// ============================================================
// anthropic_adapter.js
// OpenAI <-> Anthropic 格式双向转换层
//
// 用途：让 Dylan Heartbeat 网关同时支持
//   1. Kelivo 以 Anthropic(Claude) 供应商模式接入（/v1/messages 入口）
//   2. 上游中转站只支持 Anthropic /v1/messages 格式时的出口转换
//
// 设计原则：
//   - 网关内部流水线（时间线/事件注入/tool修复）保持 OpenAI 消息形状不变
//   - 入口：Anthropic 请求 -> 内部 OpenAI 形状
//   - 出口：内部 OpenAI 形状 -> Anthropic 请求
//   - thinking 块用 Symbol 挂在消息对象上随行，不会写入时间线 JSON，
//     出口时原样还原（保住 thinking 签名，tool 循环不会被上游拒绝）
// ============================================================

"use strict";

// thinking 块的随行暗仓。Symbol 属性会被对象展开 {...msg} 复制，
// 但 JSON.stringify / fs.writeJson 会忽略它 —— 正好穿过整条流水线而不落盘。
const THINKING_KEY = Symbol("anthropicThinkingBlocks");

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

// ------------------------------------------------------------
// 小工具
// ------------------------------------------------------------

function asArray(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

function blockText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  return "";
}

/** Anthropic 的 system / tool_result content 可以是 string 或 block 数组，压成纯文本 */
function anthropicContentToText(content) {
  if (typeof content === "string") return content;
  return asArray(content).map(blockText).filter(Boolean).join("\n");
}

function parseDataUrl(url) {
  const m = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/s.exec(url || "");
  if (!m) return null;
  return {
    mediaType: m[1] || "application/octet-stream",
    isBase64: Boolean(m[2]),
    data: m[3] || ""
  };
}

// ------------------------------------------------------------
// 上游地址与请求头
// ------------------------------------------------------------

/**
 * 判断上游格式。
 * UPSTREAM_FORMAT=anthropic|openai 显式指定；auto（默认）按 URL 嗅探。
 */
function resolveUpstreamFormat(targetUrl) {
  const forced = (process.env.UPSTREAM_FORMAT || "auto").trim().toLowerCase();
  if (forced === "anthropic" || forced === "openai") return forced;
  const url = String(targetUrl || "");
  if (url.includes("/v1/messages")) return "anthropic";
  if (/anthropic\.com/i.test(url)) return "anthropic";
  return "openai";
}

/**
 * 由配置的 TARGET_API_URL 推导 Anthropic /v1/messages 端点。
 * 容错：就算 .env 里还留着 /v1/chat/completions 也能自动纠正。
 */
function resolveAnthropicUrl(targetUrl) {
  const explicit = (process.env.ANTHROPIC_TARGET_API_URL || "").trim();
  if (explicit) return explicit;
  let url = String(targetUrl || "").trim().replace(/\/+$/, "");
  if (!url) return url;
  if (url.endsWith("/v1/messages")) return url;
  if (url.endsWith("/chat/completions")) return url.replace(/\/chat\/completions$/, "/messages");
  if (url.endsWith("/v1")) return `${url}/messages`;
  return `${url}/v1/messages`;
}

/** Anthropic 请求头。x-api-key 与 Bearer 同发，兼容各种中转站的鉴权口味。 */
function anthropicHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    Authorization: `Bearer ${apiKey}`,
    "anthropic-version": process.env.ANTHROPIC_VERSION || DEFAULT_ANTHROPIC_VERSION
  };
}

// ------------------------------------------------------------
// 入口方向：Anthropic 请求 -> 内部 OpenAI 形状
// （给 /v1/messages 路由用，转完丢进原有流水线）
// ------------------------------------------------------------

/**
 * @param {object} body Kelivo 发来的 Anthropic 格式请求体
 * @returns {Array} OpenAI 形状的 messages（system 已并入首条）
 */
function anthropicRequestToInternalMessages(body) {
  const internal = [];

  const systemText = anthropicContentToText(body.system);
  if (systemText) internal.push({ role: "system", content: systemText });

  for (const msg of asArray(body.messages)) {
    if (!msg || !msg.role) continue;

    // 内容是纯字符串：直接过
    if (typeof msg.content === "string") {
      internal.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = asArray(msg.content);

    if (msg.role === "assistant") {
      const textParts = [];
      const toolCalls = [];
      const thinkingBlocks = [];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text") {
          if (block.text) textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {})
            }
          });
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
          // 原样收好，出口时按原顺序放回最前面
          thinkingBlocks.push(block);
        }
      }
      const m = { role: "assistant", content: textParts.join("\n\n") };
      if (toolCalls.length > 0) m.tool_calls = toolCalls;
      if (thinkingBlocks.length > 0) m[THINKING_KEY] = thinkingBlocks;
      internal.push(m);
      continue;
    }

    if (msg.role === "user") {
      // tool_result 块拆成 OpenAI 的 role:"tool" 消息，且必须排在同轮其余内容之前
      const toolMsgs = [];
      const contentParts = [];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_result") {
          toolMsgs.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: anthropicContentToText(block.content)
          });
        } else if (block.type === "text") {
          if (block.text) contentParts.push({ type: "text", text: block.text });
        } else if (block.type === "image" && block.source) {
          if (block.source.type === "base64") {
            contentParts.push({
              type: "image_url",
              image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` }
            });
          } else if (block.source.type === "url") {
            contentParts.push({ type: "image_url", image_url: { url: block.source.url } });
          }
        } else if (block.type === "document") {
          contentParts.push({ type: "text", text: "[文件]" });
        }
      }
      internal.push(...toolMsgs);
      if (contentParts.length > 0) {
        const onlyText = contentParts.every(p => p.type === "text");
        internal.push({
          role: "user",
          content: onlyText ? contentParts.map(p => p.text).join("\n\n") : contentParts
        });
      }
      continue;
    }

    // 其他 role（理论上 Anthropic 不会发）：压成文本兜底
    internal.push({ role: msg.role, content: anthropicContentToText(msg.content) });
  }

  return internal;
}

// ------------------------------------------------------------
// 出口方向：内部 OpenAI 形状 -> Anthropic {system, messages}
// ------------------------------------------------------------

function openaiPartToAnthropicBlock(part) {
  if (typeof part === "string") return part ? { type: "text", text: part } : null;
  if (!part || typeof part !== "object") return null;
  if (part.type === "text" || part.type === "input_text") {
    const text = part.text || part.content || "";
    return text ? { type: "text", text } : null;
  }
  if (part.image_url || (typeof part.type === "string" && part.type.includes("image"))) {
    const url =
      typeof part.image_url === "string" ? part.image_url : part.image_url && part.image_url.url;
    if (!url) return null;
    const parsed = parseDataUrl(url);
    if (parsed && parsed.isBase64) {
      return {
        type: "image",
        source: { type: "base64", media_type: parsed.mediaType, data: parsed.data }
      };
    }
    if (/^https?:\/\//i.test(url)) {
      return { type: "image", source: { type: "url", url } };
    }
    return null;
  }
  return null;
}

function safeParseJson(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 把流水线处理完的内部消息数组转成 Anthropic 的 {system, messages}。
 * 处理：system 上提、tool 消息并入 user 轮、thinking 还原、
 * 同角色相邻合并（事件注入会造成连续 assistant）、首条必须为 user、
 * 末条 assistant 去尾部空白。
 */
function internalMessagesToAnthropic(internalMessages) {
  const systemParts = [];
  const out = [];

  const pushMerged = (role, blocks) => {
    const cleaned = blocks.filter(Boolean);
    if (cleaned.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      const lastHasTool = last.content.some(b => b.type === "tool_use" || b.type === "tool_result");
      const curHasTool = cleaned.some(b => b.type === "tool_use" || b.type === "tool_result");
      // 纯文本同角色相邻 -> 合并成一轮（Anthropic 要求 user/assistant 交替）
      if (!lastHasTool && !curHasTool) {
        const lastText = last.content[last.content.length - 1];
        const curText = cleaned[0];
        if (lastText && lastText.type === "text" && curText && curText.type === "text") {
          lastText.text = `${lastText.text}\n\n${curText.text}`;
          last.content.push(...cleaned.slice(1));
        } else {
          last.content.push(...cleaned);
        }
        return;
      }
      if (role === "user") {
        // tool_result 必须排在 user 轮内容最前面
        last.content.push(...cleaned);
        last.content.sort((a, b) => {
          const at = a.type === "tool_result" ? 0 : 1;
          const bt = b.type === "tool_result" ? 0 : 1;
          return at - bt;
        });
        return;
      }
    }
    out.push({ role, content: cleaned });
  };

  for (const msg of asArray(internalMessages)) {
    if (!msg || !msg.role) continue;

    if (msg.role === "system") {
      const t = typeof msg.content === "string" ? msg.content : anthropicContentToText(msg.content);
      if (t) systemParts.push(t);
      continue;
    }

    if (msg.role === "tool") {
      pushMerged("user", [
        {
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === "string" ? msg.content : anthropicContentToText(msg.content)
        }
      ]);
      continue;
    }

    if (msg.role === "assistant") {
      const blocks = [];
      // thinking 块放回最前（Anthropic 要求 thinking 在 assistant 内容最前）
      const thinking = msg[THINKING_KEY];
      if (Array.isArray(thinking)) blocks.push(...thinking);

      if (typeof msg.content === "string") {
        if (msg.content) blocks.push({ type: "text", text: msg.content });
      } else {
        for (const part of asArray(msg.content)) {
          const b = openaiPartToAnthropicBlock(part);
          if (b) blocks.push(b);
        }
      }

      for (const tc of asArray(msg.tool_calls)) {
        if (!tc || !tc.function) continue;
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: safeParseJson(tc.function.arguments || "{}", {})
        });
      }

      // 首条不能是 assistant：还没有 user 出现前的 assistant（历史 Bark 事件）折进 system
      if (out.length === 0) {
        const text = blocks
          .filter(b => b.type === "text")
          .map(b => b.text)
          .join("\n\n");
        if (text) systemParts.push(`【此前的自主行为记录】\n${text}`);
        continue;
      }

      pushMerged("assistant", blocks);
      continue;
    }

    // user
    const blocks = [];
    if (typeof msg.content === "string") {
      if (msg.content) blocks.push({ type: "text", text: msg.content });
    } else {
      for (const part of asArray(msg.content)) {
        const b = openaiPartToAnthropicBlock(part);
        if (b) blocks.push(b);
      }
    }
    pushMerged("user", blocks);
  }

  // 末条 assistant 的尾部空白会被 Anthropic 拒绝（prefill 规则）
  const last = out[out.length - 1];
  if (last && last.role === "assistant") {
    const lastBlock = last.content[last.content.length - 1];
    if (lastBlock && lastBlock.type === "text") {
      lastBlock.text = lastBlock.text.replace(/\s+$/, "");
      if (!lastBlock.text) last.content.pop();
    }
    if (last.content.length === 0) out.pop();
  }

  return {
    system: systemParts.join("\n\n") || undefined,
    messages: out
  };
}

// ------------------------------------------------------------
// OpenAI 请求参数 -> Anthropic 请求参数
// （给旧 /v1/chat/completions 路由和 wake_up.js 用）
// ------------------------------------------------------------

function openaiToolsToAnthropic(tools) {
  const converted = [];
  for (const t of asArray(tools)) {
    if (!t) continue;
    if (t.type === "function" && t.function) {
      converted.push({
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || { type: "object", properties: {} }
      });
    } else if (t.name && (t.input_schema || t.description)) {
      converted.push(t); // 已是 Anthropic 形状
    }
  }
  return converted;
}

function openaiToolChoiceToAnthropic(choice) {
  if (!choice) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.type === "function" && choice.function) {
    return { type: "tool", name: choice.function.name };
  }
  return undefined;
}

/**
 * @param {object} openaiBody 原始 OpenAI 请求体
 * @param {Array}  internalMessages 流水线处理后的消息
 */
function buildAnthropicRequestFromOpenAI(openaiBody, internalMessages) {
  const { system, messages } = internalMessagesToAnthropic(internalMessages);

  const defaultMax = Number(process.env.DEFAULT_MAX_TOKENS) || 4096;
  let temperature = openaiBody.temperature;
  if (typeof temperature === "number") temperature = Math.min(Math.max(temperature, 0), 1);

  const body = {
    model: openaiBody.model,
    max_tokens: openaiBody.max_tokens || openaiBody.max_completion_tokens || defaultMax,
    messages
  };
  if (system) body.system = system;
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof openaiBody.top_p === "number") body.top_p = openaiBody.top_p;
  if (openaiBody.stop) body.stop_sequences = asArray(openaiBody.stop);
  if (openaiBody.stream) body.stream = true;

  const tools = openaiToolsToAnthropic(openaiBody.tools);
  if (tools.length > 0) body.tools = tools;
  const toolChoice = openaiToolChoiceToAnthropic(openaiBody.tool_choice);
  if (toolChoice) body.tool_choice = toolChoice;

  return body;
}

// ------------------------------------------------------------
// Anthropic 响应 -> OpenAI 响应（非流式）
// ------------------------------------------------------------

const STOP_REASON_MAP = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  pause_turn: "stop",
  refusal: "content_filter"
};

/** 从 Anthropic 非流式响应里提取纯文本（wake_up 用） */
function extractAnthropicText(data) {
  return asArray(data && data.content)
    .filter(b => b && b.type === "text")
    .map(b => b.text || "")
    .join("")
    .trim();
}

function anthropicResponseToOpenAI(data) {
  const textParts = [];
  const thinkingParts = [];
  const toolCalls = [];

  for (const block of asArray(data.content)) {
    if (!block) continue;
    if (block.type === "text") textParts.push(block.text || "");
    else if (block.type === "thinking") thinkingParts.push(block.thinking || "");
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
      });
    }
  }

  const message = { role: "assistant", content: textParts.join("") };
  if (thinkingParts.length > 0) message.reasoning_content = thinkingParts.join("");
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: data.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: STOP_REASON_MAP[data.stop_reason] || "stop"
      }
    ],
    usage: {
      prompt_tokens: (data.usage && data.usage.input_tokens) || 0,
      completion_tokens: (data.usage && data.usage.output_tokens) || 0,
      total_tokens:
        ((data.usage && data.usage.input_tokens) || 0) +
        ((data.usage && data.usage.output_tokens) || 0)
    }
  };
}

// ------------------------------------------------------------
// Anthropic SSE 流 -> OpenAI SSE 流
// ------------------------------------------------------------

/**
 * 逐字节读取 Anthropic SSE，转写成 OpenAI chat.completion.chunk 流。
 * thinking_delta 映射为 reasoning_content（Kelivo/DeepSeek 约定，能直接渲染思考过程）。
 *
 * @param {ReadableStreamDefaultReader} reader 上游响应 body reader
 * @param {(chunk: string) => void} write 写入下游的回调
 */
async function pipeAnthropicStreamToOpenAI(reader, write) {
  const decoder = new TextDecoder();
  let buffer = "";
  let msgId = `chatcmpl-${Date.now()}`;
  let model = "";
  let created = Math.floor(Date.now() / 1000);
  let sentRole = false;
  let finishReason = null;
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  // Anthropic 的 content block index -> OpenAI tool_calls index
  const toolIndexMap = new Map();

  const emit = delta => {
    const chunk = {
      id: msgId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: null }]
    };
    write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const handleEvent = evt => {
    if (!evt.data) return;
    let data;
    try {
      data = JSON.parse(evt.data);
    } catch {
      return;
    }

    switch (data.type) {
      case "message_start": {
        const m = data.message || {};
        if (m.id) msgId = m.id;
        if (m.model) model = m.model;
        if (m.usage && typeof m.usage.input_tokens === "number") {
          usage.prompt_tokens = m.usage.input_tokens;
        }
        emit({ role: "assistant", content: "" });
        sentRole = true;
        break;
      }
      case "content_block_start": {
        const block = data.content_block || {};
        if (block.type === "tool_use") {
          const toolIdx = toolIndexMap.size;
          toolIndexMap.set(data.index, toolIdx);
          emit({
            tool_calls: [
              {
                index: toolIdx,
                id: block.id,
                type: "function",
                function: { name: block.name, arguments: "" }
              }
            ]
          });
        }
        break;
      }
      case "content_block_delta": {
        const d = data.delta || {};
        if (!sentRole) {
          emit({ role: "assistant", content: "" });
          sentRole = true;
        }
        if (d.type === "text_delta" && d.text) {
          emit({ content: d.text });
        } else if (d.type === "thinking_delta" && d.thinking) {
          emit({ reasoning_content: d.thinking });
        } else if (d.type === "input_json_delta" && d.partial_json) {
          const toolIdx = toolIndexMap.get(data.index);
          if (toolIdx !== undefined) {
            emit({ tool_calls: [{ index: toolIdx, function: { arguments: d.partial_json } }] });
          }
        }
        break;
      }
      case "message_delta": {
        if (data.delta && data.delta.stop_reason) {
          finishReason = STOP_REASON_MAP[data.delta.stop_reason] || "stop";
        }
        if (data.usage && typeof data.usage.output_tokens === "number") {
          usage.completion_tokens = data.usage.output_tokens;
        }
        break;
      }
      case "message_stop": {
        const finalChunk = {
          id: msgId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason || "stop" }],
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.prompt_tokens + usage.completion_tokens
          }
        };
        write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        write("data: [DONE]\n\n");
        break;
      }
      case "error": {
        const err = (data.error && data.error.message) || "上游返回错误";
        const errChunk = {
          id: msgId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: `\n[上游错误] ${err}` }, finish_reason: "stop" }]
        };
        write(`data: ${JSON.stringify(errChunk)}\n\n`);
        write("data: [DONE]\n\n");
        break;
      }
      default:
        break; // ping 等直接忽略
    }
  };

  // SSE 解析：按空行分事件，行内识别 event:/data:
  const processBuffer = final => {
    let sepIndex;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const evt = { event: "", data: "" };
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) evt.event = line.slice(6).trim();
        else if (line.startsWith("data:")) evt.data += (evt.data ? "\n" : "") + line.slice(5).trim();
      }
      handleEvent(evt);
    }
    if (final && buffer.trim()) {
      const evt = { event: "", data: "" };
      for (const line of buffer.split("\n")) {
        if (line.startsWith("event:")) evt.event = line.slice(6).trim();
        else if (line.startsWith("data:")) evt.data += (evt.data ? "\n" : "") + line.slice(5).trim();
      }
      handleEvent(evt);
      buffer = "";
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    processBuffer(false);
  }
  buffer += decoder.decode();
  processBuffer(true);
}

module.exports = {
  THINKING_KEY,
  resolveUpstreamFormat,
  resolveAnthropicUrl,
  anthropicHeaders,
  anthropicRequestToInternalMessages,
  internalMessagesToAnthropic,
  buildAnthropicRequestFromOpenAI,
  anthropicResponseToOpenAI,
  extractAnthropicText,
  pipeAnthropicStreamToOpenAI,
  anthropicContentToText
};

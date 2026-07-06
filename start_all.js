// 在同一个实例里同时运行 gateway(server.js) 和 wake-up(wake_up.js)
// 适用于 Render / Railway 这类只有一条启动命令的平台：Start Command 设为 `npm start` 即可
const { spawn } = require("child_process");

function launch(name, script) {
  const child = spawn(process.execPath, [script], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    console.error(`[start_all] ${name} 退出 (code=${code}, signal=${signal})，整体退出交给平台自动重启`);
    process.exit(code === null ? 1 : code || 1);
  });
  return child;
}

launch("gateway", "server.js");
launch("wake-up", "wake_up.js");

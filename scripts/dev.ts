import { spawn } from "node:child_process";
// One development command starts the UI and its read/signed-evidence API.
const api = spawn(process.execPath, ["run", "server/index.ts"], {
  env: { ...process.env, PORT: process.env.BOOKS_PORT ?? "3001" },
  stdio: "inherit",
});
const web = spawn(process.execPath, ["x", "vite", ...process.argv.slice(2)], {
  stdio: "inherit",
});
let closing = false;
function stop(code: number) {
  if (closing) return;
  closing = true;
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  process.exitCode = code;
}
api.on("error", (error) => {
  console.error(error);
  stop(1);
});
web.on("error", (error) => {
  console.error(error);
  stop(1);
});
api.on("exit", (code) => stop(code ?? 1));
web.on("exit", (code) => stop(code ?? 1));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

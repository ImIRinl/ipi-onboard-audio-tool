import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./dist/", import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function openBrowser(url) {
  if (!process.argv.includes("--open") || process.platform !== "win32") return;
  const browser = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${url}'`], { stdio: "inherit", windowsHide: true });
  browser.on("error", (error) => console.error(`Could not open the browser: ${error.message}. Open ${url} manually.`));
  browser.on("exit", (code) => {
    if (code) console.error(`Could not open the browser. Open ${url} manually.`);
    else console.log(`Browser launch requested: ${url}`);
  });
}

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const target = normalize(join(root, relative));
    if (!target.startsWith(normalize(root))) throw new Error("invalid path");
    const info = await stat(target);
    const file = info.isDirectory() ? join(target, "index.html") : target;
    response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.on("error", async (error) => {
  const url = `http://127.0.0.1:${port}`;
  if (error.code === "EADDRINUSE") {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const page = await response.text();
      if (response.ok && page.includes("IPI 板载音频工具")) {
        console.log(`IPI audio tool is already running: ${url}`);
        openBrowser(url);
        return;
      }
    } catch { /* Report the original bind error below. */ }
  }
  console.error(`Server startup failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`IPI audio tool: ${url}`);
  openBrowser(url);
});

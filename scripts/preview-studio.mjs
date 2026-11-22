// Local, static design review. Never reads .env, proxies API calls, or connects
// to Supabase/APIMart. Use the normal dev stack for actual image generation.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../frontend/dist/", import.meta.url));
const port = Number(process.env.STUDIO_PREVIEW_PORT || 4174);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
const json = (response, status, body) => {
  response.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { status: "ok", design_preview: true, platform_provider_configured: false, provider_configured: false, history_enabled: false });
      if (request.method === "GET" && ["/api/announcements", "/api/announcements/popups"].includes(url.pathname)) return json(response, 200, { announcements: [] });
      if (request.method === "GET" && url.pathname === "/api/styles") return json(response, 200, { styles: {}, sizes: {} });
      return json(response, 503, { error: "当前为本地界面预览", code: "LOCAL_DESIGN_PREVIEW", detail: "此预览不连接账号、数据库或生成服务；请在常规开发环境使用现有图像功能。" });
    }
    if (!["GET", "HEAD"].includes(request.method)) return json(response, 405, { error: "Method not allowed" });
    const filename = path.resolve(root, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!filename.startsWith(root)) return json(response, 403, { error: "Forbidden" });
    const bytes = await readFile(filename);
    response.writeHead(200, { ...headers, "Content-Type": types[path.extname(filename)] || "application/octet-stream" });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch (error) {
    json(response, error.code === "ENOENT" ? 404 : 400, { error: error.code === "ENOENT" ? "先运行 npm run build --prefix frontend，再打开预览。" : "Invalid request" });
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Studio design preview: http://127.0.0.1:${port} (local only; no live APIs)`));

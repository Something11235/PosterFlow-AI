// Only intercept workspace navigations. API requests, tasks and account data
// keep their normal network and cache behavior.
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname !== "/") return;

  event.respondWith(fetch(request).catch(() => new Response(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#090d14">
<title>连接中断 · PosterFlow AI</title>
<style>
:root{color-scheme:dark;font:16px/1.6 system-ui,sans-serif;background:#090d14;color:#f1f5f9}body{min-height:95vh;display:grid;place-items:center;margin:0;padding:0 24px}main{max-width:26rem}small{color:#91b8ff}h1{font-size:1.55rem;margin:.55rem 0}p{color:#a8b8ce}a{display:inline-block;border-radius:8px;background:#335fa7;color:white;padding:10px 18px;text-decoration:none}
</style><main><small>PosterFlow AI</small><h1>工作台暂时无法连接</h1><p>请检查网络连接，然后重新打开当前页面。</p><a href="">重新连接</a></main></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  )));
});

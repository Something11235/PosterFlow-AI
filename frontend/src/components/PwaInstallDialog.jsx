import { useEffect, useRef, useState } from "react";
import { Maximize, X } from "lucide-react";

function installGuide() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const inApp = /MicroMessenger|\bQQ\//i.test(ua);
  const mobileTitle = "添加到手机桌面";
  if (ios) return { title: mobileTitle, steps: [
    ...(inApp ? ["点右上角的“…”菜单，选择在 Safari 中打开。"] : []),
    "在 Safari 中点“共享”。使用紧凑工具栏时，先打开页面菜单。",
    "选“添加到主屏幕”。若显示“作为网页 App 打开”，将它开启，再点“添加”。",
  ] };
  if (/Android|Mobile/i.test(ua)) {
    if (/Firefox\//i.test(ua)) return { title: mobileTitle, steps: [
      "点 Firefox 的“⋮”菜单，选择“安装”。",
      "在“添加到主屏幕”面板中确认，然后从主屏幕打开 PosterFlow。",
    ] };
    if (inApp) return { title: mobileTitle, steps: [
      "点右上角的“…”菜单，选择在系统浏览器中打开。",
      "在打开的浏览器中再次点本站的“添加到桌面”，查看对应的安装步骤。",
    ] };
    const chrome = /Chrome\//.test(ua) && !/EdgA\/|SamsungBrowser\/|OPR\/|HuaweiBrowser\/|UCBrowser\//i.test(ua);
    return { title: mobileTitle, steps: [
      chrome ? "打开 Chrome 浏览器菜单“⋮”，点“安装并创建快捷方式” → “安装”。旧版菜单中可直接点“安装应用”或“添加到主屏幕”。" : "打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。",
      "确认添加后，从手机桌面打开 PosterFlow。",
    ] };
  }
  const title = "安装 PosterFlow";
  if (/Firefox\//i.test(ua)) {
    if (/Windows NT/i.test(ua)) return { title, steps: [
      "在 Firefox 的普通窗口中，点击地址栏右侧的网页应用按钮。",
      "从 Windows 开始菜单打开 PosterFlow。需要全屏时按 F11。",
      "若找不到按钮，请更新 Firefox。官网版支持 143 及以上，Microsoft Store 版支持 150 及以上。",
    ] };
    return { title, steps: [
      "此系统上的 Firefox 可直接使用工作台。要安装为独立窗口，请在 Chrome 中打开本站，再点“安装桌面应用”。",
    ] };
  }
  if (/Edg\//.test(ua)) return { title, steps: [
    "点击 Edge 地址栏右侧的安装图标，或打开“…” → “更多工具” → “应用” → “将此站点安装为应用”。",
    "如已安装，可在地址栏输入 edge://apps 打开。若安装选项缺失或变灰，且 Edge 显示由组织管理，请向设备管理员确认安装权限。",
  ] };
  if (/Chrome\//.test(ua)) return { title, steps: [
    "点击 Chrome 地址栏右侧的安装图标，或打开“⋮” → “投放、保存和分享” → “将网页安装为应用”。",
    "在安装窗口确认名称，再点“安装”。",
  ] };
  if (/Macintosh/.test(ua) && /Version\/.+Safari\//.test(ua)) return { title, steps: [
    "在 macOS 14 或更高版本中，打开 Safari 的“文件”菜单，选择“添加到程序坞”。",
    "点“添加”，然后从程序坞打开 PosterFlow。",
  ] };
  return { title, steps: ["在 Edge 或 Chrome 中打开本站，再点“安装应用”。", "也可以将当前页面加入书签，继续在浏览器中使用。"] };
}

const appWindowModes = ["standalone", "minimal-ui", "fullscreen"];

function inAppWindow() {
  return navigator.standalone || appWindowModes.some(mode => window.matchMedia(`(display-mode: ${mode})`).matches);
}

function canEnterFullscreen() {
  if (window.matchMedia("(pointer: coarse)").matches && !document.fullscreenEnabled && !document.webkitFullscreenEnabled) return false;
  return inAppWindow() &&
    !window.matchMedia("(display-mode: fullscreen)").matches &&
    !document.fullscreenElement && !document.webkitFullscreenElement;
}

export function PwaFullscreenButton({ className }) {
  const [visible, setVisible] = useState(canEnterFullscreen);
  const [hint, setHint] = useState("");
  useEffect(() => {
    function update() {
      setVisible(canEnterFullscreen());
      setHint("");
    }
    const modes = appWindowModes.map(mode => window.matchMedia(`(display-mode: ${mode})`));
    modes.forEach(mode => mode.addEventListener("change", update));
    document.addEventListener("fullscreenchange", update);
    document.addEventListener("webkitfullscreenchange", update);
    return () => {
      modes.forEach(mode => mode.removeEventListener("change", update));
      document.removeEventListener("fullscreenchange", update);
      document.removeEventListener("webkitfullscreenchange", update);
    };
  }, []);
  async function enter() {
    const root = document.documentElement;
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (request) {
      try { await request.call(root); return; }
      catch { /* The installed window may use the system's fullscreen command. */ }
    }
    if (window.matchMedia("(pointer: coarse)").matches) setHint("当前设备暂时无法进入全屏。");
    else setHint(/Mac/.test(navigator.platform) ? "按 Control + Command + F 进入全屏。" : "按 F11 进入全屏。");
  }
  if (!visible) return null;
  return <>
    <button className={className} type="button" onClick={enter}><Maximize size={16} aria-hidden="true" />进入全屏</button>
    {hint && <span role="status" className="text-sm text-text-secondary">{hint}</span>}
  </>;
}

export default function PwaInstallDialog() {
  const [showHelp, setShowHelp] = useState(false);
  const dialog = useRef(null);
  useEffect(() => {
    if (inAppWindow()) {
      document.documentElement.dataset.pwaInstalled = "true";
    }
    let pendingPrompt;
    function capture(event) {
      event.preventDefault();
      pendingPrompt = event;
    }
    function installed() {
      pendingPrompt = null;
      document.documentElement.dataset.pwaInstalled = "true";
      setShowHelp(false);
    }
    async function install() {
      if (inAppWindow()) return;
      const prompt = pendingPrompt;
      pendingPrompt = null;
      if (prompt) {
        try {
          await prompt.prompt();
          return;
        } catch { /* The browser may have expired the install prompt. */ }
      }
      setShowHelp(true);
    }
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", installed);
    window.addEventListener("posterflow:install", install);
    return () => {
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", installed);
      window.removeEventListener("posterflow:install", install);
    };
  }, []);

  useEffect(() => {
    if (showHelp) dialog.current.showModal();
  }, [showHelp]);
  if (!showHelp) return null;
  const guide = installGuide();
  return <dialog ref={dialog} aria-labelledby="pwa-install-heading" onClose={() => setShowHelp(false)}
    className="m-auto max-h-[85dvh] w-[min(25rem,calc(100%-2rem))] rounded-2xl border border-border-default bg-bg-secondary p-5 text-text-primary shadow-2xl backdrop:bg-black/70">
    <div className="flex items-center gap-3">
      <img src="/pwa/posterflow-p-192.png" width="40" height="40" alt="" className="rounded-xl" />
      <h2 id="pwa-install-heading" className="flex-1 text-lg font-semibold">{guide.title}</h2>
      <button type="button" aria-label="关闭安装说明" onClick={() => dialog.current.close()}
        className="grid size-11 place-items-center rounded-md text-text-muted hover:bg-bg-elevated"><X size={19} /></button>
    </div>
    <ol className="mt-4 list-decimal space-y-3 border-t border-border-subtle pt-4 pl-6 text-sm leading-6 text-text-secondary marker:text-accent">
      {guide.steps.map(step => <li key={step} className="pl-1">{step}</li>)}
    </ol>
  </dialog>;
}

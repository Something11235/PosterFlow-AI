import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const exportStep = { target: '[data-canvas-guide="export"]', title: "把成品打包带走", description: "在这里勾选项目里的参考图、生成结果和尾帧，一次下载为 ZIP 文件。" };
const replayStep = { target: '[data-canvas-guide="help"]', title: "随时重看指引", description: "在节点画布或分镜工作台点这里，就能重看当前视图的操作步骤。" };

export const graphGuide = [
  { target: '[data-canvas-guide="storyboard"]', title: "从剧本开始做分镜", description: "打开分镜工作台，粘贴剧本或手动添加镜头。选好画面、模型和时长后，可以先看预计积分，再决定生成。" },
  { target: ".cc-toolbar .cc-add", title: "在画布上搭建流程", description: "点「添加节点」放入参考图、提示词或生成节点。拖动节点标题调整位置，把右侧输出端连到下一节点的左侧输入端。" },
  { target: '[data-canvas-guide="projects"]', title: "接着上次的项目创作", description: "这里可以新建、重命名或切换项目。画布和素材自动保存在当前浏览器，刷新后可以继续编辑。" },
  exportStep, replayStep,
];

export const storyboardGuide = [
  { target: ".cs-script-toggle", title: "把剧本拆成镜头", description: "展开「创作剧本」，粘贴故事，选好镜头数后点「AI 拆镜」。先预览草案，采纳后继续编辑。" },
  { target: ".cs-list-panel header", title: "逐镜编辑画面", description: "点「添加镜头」可以手动写一镜。选中列表里的镜头，就能改提示词、选择图片或视频模型、调整模型支持的参数。" },
  { target: ".cs-generate-bar button", title: "确认费用再生成", description: "勾选要生成的镜头，打开生成清单核对模型和预计积分，最后点确认提交。" },
  exportStep, replayStep,
];

const memory = new Map();
function receipt(preference, owner) {
  const key = preference + ":" + owner;
  try { return localStorage.getItem(key) || memory.get(key); }
  catch { return memory.get(key); }
}
function remember(preference, owner, value) {
  const key = preference + ":" + owner;
  memory.set(key, value);
  try { localStorage.setItem(key, value); } catch { /* Available in memory for this visit. */ }
}

async function syncAccount(preference, owner) {
  if (!supabase || owner === "guest") return;
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user?.id !== owner) return;
    const { data: updated, error } = await supabase.auth.updateUser({ data: { [preference]: true } });
    if (!error && updated.user?.id === owner && updated.user.user_metadata?.[preference] === true) remember(preference, owner, "synced");
  } catch { /* Retry pending local receipts on the next visit. */ }
}

function recordVisit(preference, owner) {
  if (owner === "guest") {
    if (!receipt(preference, owner)) remember(preference, owner, "seen");
  } else {
    // A visitor who signs in after the tour carries that first visit into one account.
    remember(preference, "guest", "claimed");
    if (receipt(preference, owner) !== "synced") {
      remember(preference, owner, "pending");
      void syncAccount(preference, owner);
    }
  }
}

export function useWorkspaceGuide(owner, user, ready, preference) {
  const [tourOpen, setOpen] = useState(false);
  const accountSeen = user?.id === owner && user.user_metadata?.[preference] === true;
  const openTour = useCallback(() => {
    if (!ready) return;
    if (!receipt(preference, owner)) recordVisit(preference, owner);
    setOpen(true);
  }, [owner, preference, ready]);
  const closeTour = useCallback(() => setOpen(false), []);
  // A workspace may stay mounted while the visitor navigates to another area.
  useEffect(() => () => setOpen(false), [owner, preference, ready]);
  useEffect(() => {
    if (!ready) return;
    if (accountSeen) { remember(preference, owner, "synced"); remember(preference, "guest", "claimed"); return; }
    if (receipt(preference, owner) || (owner !== "guest" && receipt(preference, "guest") === "seen")) {
      if (owner !== "guest" && receipt(preference, owner) !== "synced") recordVisit(preference, owner);
      return;
    }
    let cancelled = false, timer;
    function showWhenReady() {
      if (cancelled || receipt(preference, owner)) return;
      const otherDialog = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')]
        .some(element => element.getClientRects().length > 0);
      if (document.hidden || otherDialog) { timer = window.setTimeout(showWhenReady, 350); return; }
      openTour();
    }
    async function check() {
      if (owner !== "guest" && supabase) {
        // A session on a second device may predate the first viewing.
        try {
          const { data } = await supabase.auth.getUser();
          if (cancelled || (data.user && data.user.id !== owner)) return;
          if (data.user?.user_metadata?.[preference] === true) {
            remember(preference, owner, "synced"); remember(preference, "guest", "claimed"); return;
          }
        } catch { /* Offline visits can use the local preference. */ }
      }
      showWhenReady();
    }
    timer = window.setTimeout(check, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [owner, ready, preference, accountSeen, openTour]);
  return { tourOpen: ready && tourOpen, openTour, closeTour };
}

export default function useCanvasGuide(owner, user, ready) {
  return useWorkspaceGuide(owner, user, ready, "posterflow_canvas_guide_seen");
}

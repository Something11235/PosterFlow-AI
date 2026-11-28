import { useEffect, useState } from "react";
import { isPptPreflightError, requestPpt } from "../../lib/pptProject";
import { isPptStep, pausePptStep, pptStepBody } from "../../lib/pptGeneration";

// A second tab may observe the same step. Both recover by its persisted ID;
// the service claims one provider call and returns the stored result to followers.
export default function usePptGeneration(pending, signedIn, patch, headers, finish) {
  const [live, setLive] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const id = signedIn && isPptStep(pending?.action) ? pending.id : null;
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer, animation, attempted = false;
    let draft = { id, text: "", elements: [], reconnect: false, notice: "" };
    function publish(fields) {
      draft = { ...draft, ...fields };
      if (animation == null && !signal.aborted) {
        animation = requestAnimationFrame(() => { animation = null; if (!signal.aborted) setLive(draft); });
      }
    }
    function frame(event) {
      if (event.type === "progress" && typeof event.text === "string") {
        publish({ text: (draft.text + event.text).slice(-12000), notice: "" });
      } else if (event.type === "element" && event.element?.id) {
        const elements = draft.elements.filter(item => item.id !== event.element.id);
        publish({ elements: [...elements, event.element], background: event.background || draft.background, notice: "" });
      }
    }
    async function reconcile() {
      let posting = false;
      try {
        const current = await patch();
        if (signal.aborted || current.pending?.id !== id) return;
        let result;
        try {
          result = await requestPpt("requests/" + encodeURIComponent(id), headers.current, undefined, undefined, signal);
        } catch (error) {
          if (signal.aborted) return;
          if (error.status !== 404 || error.code !== "PPT_NOT_FOUND") throw error;
          if (attempted) {
            publish({ notice: "正在确认这一步是否已提交。", reconnect: true });
          } else {
            attempted = true;
            posting = true;
            result = await requestPpt(current.pending.action, headers.current, pptStepBody(current), frame, signal);
          }
        }
        if (signal.aborted) return;
        if (result?.status === "succeeded" || result?.status === "failed") {
          await finish(id, result);
          return;
        }
        if (result?.status === "processing") publish({ notice: "模型仍在生成，正在同步原任务。", reconnect: false });
      } catch (error) {
        if (signal.aborted) return;
        if (posting && (isPptPreflightError(error) || error.status === 429)) {
          await patch(current => pausePptStep(current, id, error.message, true));
          return;
        }
        publish({ notice: "进度连接暂时中断，正在按原编号找回结果。", reconnect: true });
      }
      if (!signal.aborted) timer = setTimeout(reconcile, 6000);
    }
    void reconcile();
    return () => {
      controller.abort();
      clearTimeout(timer);
      if (animation != null) cancelAnimationFrame(animation);
    };
  }, [id, attempt, patch, headers, finish]);
  return { live: id && live?.id === id ? live : null, reconnect: () => setAttempt(value => value + 1) };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { updateCanvasProject } from "../lib/creationCanvasProject";
import { canvasTextRouteLabel, fetchCanvasText, finishCanvasText } from "../lib/creationCanvasText";

const preflight = new Set(["CANVAS_AI_INPUT_INVALID", "CANVAS_AI_MODEL_UNAVAILABLE", "CANVAS_AI_PENDING_LIMIT",
  "ACCOUNT_FROZEN", "EMAIL_UNVERIFIED", "INSUFFICIENT_CREDITS"]);

export default function useCanvasTextAssistant({ owner, project, projectRef, contextRef, queuedWrites, receive, report, login, refresh }) {
  const active = useRef(new Set());
  const mounted = useRef(false);
  const [missingId, setMissingId] = useState("");
  const [config, setConfig] = useState(null);
  const configured = config?.configured;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/canvas-ai/config", { signal: controller.signal }).then(res => res.ok ? res.json() : null)
      .then(info => { if (!controller.signal.aborted && typeof info?.configured === "boolean") setConfig(info); }).catch(() => {});
    return () => controller.abort();
  }, []);

  const execute = useCallback(async (projectId, task, submit) => {
    if (!contextRef.current.authenticated || active.current.has(task.id)) return;
    active.current.add(task.id);
    const visible = () => mounted.current && projectRef.current?.id === projectId;
    try {
      const result = await fetchCanvasText(contextRef.current.authHeaders, task, submit);
      if (result.status === "processing") return;
      const updated = await updateCanvasProject(owner, projectId, current => finishCanvasText(current, task, result));
      receive(updated);
      if (visible()) setMissingId("");
      if (mounted.current) Promise.resolve(refresh.current?.()).catch(() => {});
    } catch (error) {
      if (submit && (error.notSubmitted || preflight.has(error.code) || (error.code && error.status === 401))) {
        const updated = await updateCanvasProject(owner, projectId, current => current.textRequest?.id !== task.id ? current :
          { ...current, textRequest: null, textError: error.message });
        receive(updated);
      } else if (!submit && error.code === "CANVAS_AI_NOT_FOUND" && Date.now() - task.at > 15000) {
        if (visible()) setMissingId(task.id);
      } else if (submit && visible()) report("暂未收到 AI 结果，将按原任务编号查询。");
    } finally { active.current.delete(task.id); }
  }, [owner, contextRef, projectRef, receive, report, refresh]);

  const pending = project?.textRequest;
  const pendingId = pending?.id;
  const projectId = project?.id;
  useEffect(() => {
    if (!pendingId || !projectId || !contextRef.current.authenticated) return;
    const check = () => {
      const current = projectRef.current;
      if (document.visibilityState !== "hidden" && current?.id === projectId && current.textRequest?.id === pendingId) {
        void execute(projectId, current.textRequest, false).catch(report);
      }
    };
    check();
    const timer = window.setInterval(check, 8000);
    window.addEventListener("focus", check);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", check); };
  }, [projectId, pendingId, execute, report, contextRef, projectRef]);

  async function start(input) {
    if (configured === false) { report("AI 文字服务尚未配置，已编辑的内容已保存在本机。"); return; }
    if (!contextRef.current.authenticated) { login(); return; }
    const id = projectRef.current?.id;
    if (!id) return;
    const task = { id: crypto.randomUUID(), input, at: Date.now() };
    try {
      await queuedWrites.current;
      const next = await updateCanvasProject(owner, id, current => {
        if (current.textRequest) throw new Error("本项目已有 AI 任务正在处理。");
        if (current.textProposal) throw new Error("请先采纳或放弃上一份 AI 建议。");
        return { ...current, textRequest: task, textError: "" };
      });
      // Reserve locally before dispatch. The polling effect must not race this POST.
      const sending = execute(id, task, true);
      receive(next);
      await sending;
    } catch (error) { report(error); }
  }

  async function apply(mutate) {
    const proposal = project?.textProposal;
    if (!proposal) return;
    try {
      await queuedWrites.current;
      const next = await updateCanvasProject(owner, project.id, current => {
        if (current.textProposal?.id !== proposal.id) throw new Error("建议已更新，请重新查看。");
        return { ...(mutate ? mutate(current) : current), textProposal: null };
      });
      receive(next);
    } catch (error) { report(error); }
  }
  return { start, apply, configured, routeLabel: canvasTextRouteLabel(config), missing: Boolean(pending && missingId === pending.id),
    retry: () => pending && execute(projectId, pending, true).catch(report) };
}

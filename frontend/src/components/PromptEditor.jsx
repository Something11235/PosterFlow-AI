import React, { useEffect, useMemo, useRef, useState } from "react";
import { Clipboard, FileImage, FileText, Loader2, Paperclip, Plus, Send, Trash2, X } from "lucide-react";
import { MAX_REFERENCE_IMAGES } from "../lib/provider";
import { REFERENCE_FILE_ACCEPT, referenceFileKey } from "../lib/referenceSelection";

const PROMPT_CHARACTER_LIMIT = 6000;

function ReferenceThumbnail({ file, number }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl); setFailed(false);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);
  return url && !failed
    ? <img src={url} alt={`参考图${number}预览`} className="h-20 w-full rounded object-cover" onError={() => setFailed(true)} />
    : <div className="flex h-20 items-center justify-center rounded bg-bg-tertiary text-text-muted"><FileImage size={23} /><span className="sr-only">参考图预览暂不可用</span></div>;
}

export default function PromptEditor({
  prompt,
  onPromptChange,
  onGenerate,
  onOpenProvider,
  isGenerating,
  currentPrompt,
  referenceFiles = [],
  onReferenceAdd,
  onReferenceRemove,
  onReferenceClear,
  referenceFeedback,
  mode,
  onCopyPrompt,
  providerConfigured,
  presetName,
  presetCategory,
  hasPreviousImage,
}) {
  const fileInputRef = useRef(null);
  const promptRef = useRef(null);
  const [mentionHint, setMentionHint] = useState("");
  const charCount = Array.from(prompt.trim()).length;
  const promptTooLong = charCount > PROMPT_CHARACTER_LIMIT;
  const generationDisabled = isGenerating || (providerConfigured && (!prompt.trim() || promptTooLong));
  const promptQuality = useMemo(() => {
    if (charCount > PROMPT_CHARACTER_LIMIT) return "超出限制";
    if (charCount > 180) return "信息充分";
    if (charCount > 60) return "可生成";
    return "待完善";
  }, [charCount]);

  const files = referenceFiles;
  const referenceLimitReached = files.length >= MAX_REFERENCE_IMAGES;
  const insertMention = (index) => {
    const mention = "@图" + (index + 1); const input = promptRef.current;
    const start = input?.selectionStart ?? prompt.length; const end = input?.selectionEnd ?? start;
    onPromptChange(prompt.slice(0, start) + mention + prompt.slice(end)); setMentionHint("已插入 " + mention);
    window.setTimeout(() => { input?.focus(); const cursor = start + mention.length; input?.setSelectionRange(cursor, cursor); setMentionHint(""); }, 0);
  };

  return (
    <div className="surface rounded-lg p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <FileText size={17} className="text-accent" />
            提示词编辑器
          </div>
          <p className="mt-1 text-xs leading-5 text-text-muted">
            当前预设：{presetName || "自由创作"} · {presetCategory || "自定义"}，模板可以直接改写。
          </p>
        </div>
        <div className="flex-shrink-0 rounded-lg border border-border-subtle bg-bg-tertiary px-3 py-2 text-right">
          <p className="text-[11px] text-text-muted">提示词状态</p>
          <p className="text-xs font-medium text-text-secondary">{promptQuality}</p>
        </div>
      </div>

      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <label htmlFor="prompt" className="text-sm font-medium text-text-secondary">
            提示词
          </label>
          <div className="flex items-center gap-2">
            <span id="prompt-character-count" className={`text-xs tabular-nums ${promptTooLong ? "text-error" : "text-text-muted"}`} title="最多6000个字符，首尾空白不计入限制">{charCount}/{PROMPT_CHARACTER_LIMIT}<span className="sr-only"> 字符</span></span>
            {(currentPrompt || prompt) && (
              <button
                type="button"
                onClick={onCopyPrompt}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 text-xs text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary"
              >
                <Clipboard size={14} />
                复制
              </button>
            )}
          </div>
        </div>
        <textarea
          ref={promptRef}
          id="prompt"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          aria-describedby={`prompt-character-count${promptTooLong ? " prompt-length-warning" : ""}`}
          aria-invalid={promptTooLong || undefined}
          placeholder="描述你想生成或修改的画面；可在下方上传素材并用 @图1、@图2 引用。"
          rows={8}
          className="min-h-52 w-full resize-y rounded-lg border border-border-default bg-bg-primary/78 px-4 py-3 text-base leading-7 text-text-primary placeholder:text-text-muted transition focus:border-accent/65"
        />
        {promptTooLong && <p id="prompt-length-warning" role="alert" className="mt-2 text-xs leading-5 text-error">提示词最多 6000 个字符，请精简后再生成。</p>}
      </div>

        <div className="mb-4" role="group" aria-label="参考图片管理">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-medium text-text-secondary"><Paperclip size={16} />参考素材</span>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted"><span className="tabular-nums">{files.length}/{MAX_REFERENCE_IMAGES} 张</span><span>单张最多 16 MB</span></div>
          </div>
          {files.length > 0 && <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {files.map((file, index) => <div key={referenceFileKey(file)} className="relative min-w-0 rounded-md border border-border-subtle bg-bg-primary/60 p-1.5">
              <button type="button" onClick={() => insertMention(index)} aria-label={`插入 @图${index + 1}：${file.name}`} className="block w-full min-w-0 rounded text-left transition hover:bg-bg-elevated">
                <div className="relative"><ReferenceThumbnail file={file} number={index + 1} /><span className="absolute left-1 top-1 rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-semibold text-white">图{index + 1}</span></div>
                <p className="mt-1 truncate text-xs text-text-primary" title={file.name}>{file.name}</p><p className="truncate text-[11px] text-accent">点击插入 @图{index + 1}</p>
              </button>
              <button type="button" onClick={() => onReferenceRemove(index)} aria-label={`删除参考图${index + 1}：${file.name}`} title={`删除 ${file.name}`} className="absolute right-2 top-2 inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border border-white/15 bg-bg-primary/90 text-text-secondary transition hover:border-error/50 hover:bg-error/15 hover:text-error"><X size={16} /></button>
            </div>)}
          </div>}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={referenceLimitReached}
            className={`flex w-full items-center justify-center rounded-lg border border-dashed border-border-default bg-bg-tertiary/70 p-3 text-text-muted transition hover:border-accent/45 hover:bg-bg-elevated disabled:cursor-not-allowed disabled:opacity-55 ${files.length ? "min-h-12" : "min-h-24"}`}
          >
            {files.length ? <span className="inline-flex items-center gap-2 text-sm"><Plus size={17} />{referenceLimitReached ? `已达 ${MAX_REFERENCE_IMAGES} 张上限` : "继续添加参考图"}</span> : (
              <div className="flex flex-col items-center gap-2 text-text-muted">
                <FileImage size={24} />
                <span className="text-sm">上传参考图片</span>
              </div>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={REFERENCE_FILE_ACCEPT}
            aria-label="选择参考图片"
            className="hidden"
            multiple
            onChange={(event) => {
              const selected = Array.from(event.currentTarget.files || []);
              event.currentTarget.value = "";
              if (selected.length) onReferenceAdd(selected);
            }}
          />
          {files.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onReferenceClear();
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-xs text-text-muted transition hover:bg-bg-tertiary hover:text-error"
            >
              <Trash2 size={14} />
              清空全部参考图
            </button>
          )}
          <p className="mt-1 text-xs leading-5 text-text-muted">最多 {MAX_REFERENCE_IMAGES} 张，可分次追加，按顺序对应 @图1、@图2……。点击图片插入引用，点击右上角 × 单独删除。</p>
          {referenceFeedback?.text && <p className={`mt-2 break-words text-xs leading-5 ${referenceFeedback.warning ? "text-gold" : "text-text-muted"}`} role={referenceFeedback.warning ? "alert" : "status"}>{referenceFeedback.text}</p>}
          {mentionHint && <p className="mt-1 text-xs text-mint" role="status">{mentionHint}</p>}
        </div>

      {!providerConfigured && (
        <p className="mb-3 rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-xs leading-5 text-gold" role="status">
          还没有图片服务配置。点击下方按钮选择平台积分，或填写自己的 Key 和中转站。
        </p>
      )}
      <button
        type="button"
        onClick={providerConfigured ? onGenerate : onOpenProvider}
        disabled={generationDisabled}
        className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition ${
          generationDisabled
            ? "cursor-not-allowed bg-bg-elevated text-text-muted"
            : "bg-accent text-white shadow-lg shadow-accent/20 hover:bg-accent-hover active:scale-[0.99]"
        }`}
      >
        {isGenerating ? <Loader2 size={18} className="animate-spin-soft" /> : <Send size={18} />}
        {isGenerating
          ? "正在生成"
          : !providerConfigured
            ? "配置服务并生成"
            : mode === "iterative" && hasPreviousImage
              ? "局部重绘当前图片"
              : mode === "iterative"
                ? "生成首张参考图"
                : "生成图片"}
      </button>
    </div>
  );
}

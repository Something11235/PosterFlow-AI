import React, { useMemo, useRef, useState } from "react";
import { Clipboard, FileImage, FileText, Loader2, Paperclip, Send, Trash2 } from "lucide-react";
import { MAX_REFERENCE_IMAGES } from "../lib/provider";

export default function PromptEditor({
  prompt,
  onPromptChange,
  onGenerate,
  isGenerating,
  currentPrompt,
  referenceFile,
  referenceFiles,
  onReferenceChange,
  referencePreview,
  referencePreviews,
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
  const charCount = prompt.length;
  const promptQuality = useMemo(() => {
    if (charCount > 180) return "信息充分";
    if (charCount > 60) return "可生成";
    return "待完善";
  }, [charCount]);

  const showReference = true;
  const files = referenceFiles || (referenceFile ? [referenceFile] : []);
  const previews = referencePreviews || (referencePreview ? [referencePreview] : []);
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
            <span className="text-xs text-text-muted">{charCount} 字</span>
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
          placeholder="描述你想生成或修改的画面；可在下方上传素材并用 @图1、@图2 引用。"
          rows={8}
          className="min-h-52 w-full resize-y rounded-lg border border-border-default bg-bg-primary/78 px-4 py-3 text-base leading-7 text-text-primary placeholder:text-text-muted transition focus:border-accent/65"
        />
      </div>

      {showReference && (
        <div className="mb-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text-secondary">
            <Paperclip size={16} />
            参考素材
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex min-h-24 w-full items-center justify-center rounded-lg border border-dashed border-border-default bg-bg-tertiary/70 p-3 transition hover:border-accent/45 hover:bg-bg-elevated"
          >
            {files.length ? (
              <div className="grid w-full grid-cols-2 gap-2 text-left sm:grid-cols-4">
                {files.map((file, index) => (
                  <button type="button" key={file.name + index} onClick={(event) => { event.stopPropagation(); insertMention(index); }} className="group min-w-0 rounded-md border border-border-subtle bg-bg-primary/60 p-1.5 text-left transition hover:border-accent/50">
                    <div className="relative">{previews[index] && <img src={previews[index]} alt={"参考图" + (index + 1) + "预览"} className="h-20 w-full rounded object-cover" />}<span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white">图{index + 1}</span></div>
                    <p className="mt-1 truncate text-xs text-text-primary">{file.name}</p><p className="truncate text-[11px] text-accent">点击插入 @图{index + 1}</p>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-text-muted">
                <FileImage size={24} />
                <span className="text-sm">上传参考图片</span>
              </div>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            multiple
            onChange={(event) => onReferenceChange(Array.from(event.target.files || []))}
          />
          {files.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onReferenceChange([]);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-xs text-text-muted transition hover:bg-bg-tertiary hover:text-error"
            >
              <Trash2 size={14} />
              移除参考图
            </button>
          )}
          {files.length > 0 && <p className="mt-1 text-xs leading-5 text-text-muted">最多 {MAX_REFERENCE_IMAGES} 张，按顺序对应 @图1、@图2……。想尽量保持图1背景不变，请明确写“只添加/移动主体，其他元素、镜头和背景保持不变”。</p>}
          {mentionHint && <p className="mt-1 text-xs text-mint" role="status">{mentionHint}</p>}
        </div>
      )}

      {!providerConfigured && (
        <p className="mb-3 rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-xs leading-5 text-gold" role="status">
          还没有图片服务配置。点击下方按钮后可填写自己的 Key 和中转站。
        </p>
      )}
      <button
        type="button"
        onClick={onGenerate}
        disabled={isGenerating || !prompt.trim()}
        className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition ${
          isGenerating || !prompt.trim()
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

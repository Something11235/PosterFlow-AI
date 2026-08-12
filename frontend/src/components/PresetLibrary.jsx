import React, { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronDown, Download, ImageIcon, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import {
  BUILTIN_PRESETS,
  listCustomPresets,
  PRESET_CATEGORIES,
  removeCustomPreset,
  saveCustomPreset,
} from "../lib/presets";

const CUSTOM_CATEGORY_VALUE = "__custom__";
const BUILTIN_CATEGORY_OPTIONS = PRESET_CATEGORIES.filter((item) => item !== "全部");
const EMPTY_DRAFT = {
  id: "",
  name: "",
  category: "宣传海报",
  customCategory: "",
  prompt: "",
  cover: "",
};

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function PresetLibrary({ activePresetId, onApplyPreset }) {
  const [category, setCategory] = useState("全部");
  const [customPresets, setCustomPresets] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);
  const importInputRef = useRef(null);

  useEffect(() => {
    listCustomPresets().then(setCustomPresets);
  }, []);

  useEffect(() => {
    if (!showEditor) return undefined;
    const handleKeyDown = (event) => event.key === "Escape" && setShowEditor(false);
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showEditor]);

  const allPresets = useMemo(() => [...BUILTIN_PRESETS, ...customPresets], [customPresets]);
  const categoryOptions = useMemo(() => {
    const customCategories = customPresets
      .map((preset) => String(preset.category || "").trim())
      .filter((item) => item && item !== "全部" && !PRESET_CATEGORIES.includes(item));
    return [...PRESET_CATEGORIES, ...new Set(customCategories)];
  }, [customPresets]);
  const visiblePresets = useMemo(
    () => (category === "全部" ? allPresets : allPresets.filter((preset) => preset.category === category)),
    [allPresets, category],
  );
  const activePreset = useMemo(
    () => allPresets.find((preset) => preset.id === activePresetId),
    [activePresetId, allPresets],
  );

  useEffect(() => {
    if (!categoryOptions.includes(category)) setCategory("全部");
  }, [category, categoryOptions]);

  const openCreate = () => {
    setDraft({ ...EMPTY_DRAFT });
    setError("");
    setShowEditor(true);
  };

  const openEdit = (preset) => {
    const isBuiltinCategory = BUILTIN_CATEGORY_OPTIONS.includes(preset.category);
    setDraft({
      id: preset.id,
      name: preset.name,
      category: isBuiltinCategory ? preset.category : CUSTOM_CATEGORY_VALUE,
      customCategory: isBuiltinCategory ? "" : preset.category,
      prompt: preset.prompt,
      cover: preset.cover || "",
    });
    setError("");
    setShowEditor(true);
  };

  const handleCoverChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("封面必须是图片文件");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError("封面图片不能超过 8 MB");
      return;
    }
    const cover = await fileToDataUrl(file);
    setDraft((current) => ({ ...current, cover }));
    setError("");
  };

  const handleSave = async () => {
    if (!draft.name.trim()) return setError("请填写预设名称");
    if (!draft.prompt.trim()) return setError("请填写提示词模板");
    const selectedCategory = draft.category === CUSTOM_CATEGORY_VALUE ? draft.customCategory.trim() : draft.category;
    if (!selectedCategory) return setError("请填写自定义类别名称");
    if (selectedCategory === "全部") return setError("“全部”是系统保留类别，请使用其他名称");
    if (selectedCategory.length > 30) return setError("类别名称不能超过 30 个字符");
    const preset = {
      id: draft.id || `custom-${Date.now()}`,
      name: draft.name.trim(),
      category: selectedCategory,
      prompt: draft.prompt.trim(),
      cover: draft.cover,
      source: "custom",
      updatedAt: new Date().toISOString(),
    };
    await saveCustomPreset(preset);
    setCustomPresets(await listCustomPresets());
    setShowEditor(false);
    onApplyPreset(preset);
  };

  const handleExport = () => {
    if (customPresets.length === 0) {
      setError("还没有可导出的自定义预设");
      return;
    }
    const blob = new Blob([JSON.stringify(customPresets, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "posterflow-custom-presets.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (!Array.isArray(imported) || imported.length === 0) throw new Error("empty");
      const valid = imported.filter((preset) => preset?.name && preset?.prompt);
      if (valid.length === 0) throw new Error("invalid");
      for (const preset of valid.slice(0, 50)) {
        const importedCategory = String(preset.category || "").trim();
        await saveCustomPreset({
          id: `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name: String(preset.name).slice(0, 80),
          category: importedCategory && importedCategory !== "全部" ? importedCategory.slice(0, 30) : "宣传海报",
          prompt: String(preset.prompt).slice(0, 12000),
          cover: preset.cover ? String(preset.cover) : "",
          source: "custom",
          updatedAt: new Date().toISOString(),
        });
      }
      setCustomPresets(await listCustomPresets());
      setError("");
    } catch {
      setError("预设文件格式不正确，请选择由本工具导出的 JSON 文件");
    }
  };

  const handleDelete = async (preset) => {
    if (!window.confirm(`确定删除自定义预设“${preset.name}”吗？`)) return;
    await removeCustomPreset(preset.id);
    setCustomPresets(await listCustomPresets());
  };

  return (
    <div className="surface rounded-lg p-4">
      <div className={`flex items-start justify-between gap-3 ${collapsed ? "" : "mb-3"}`}>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <BookOpen size={17} className="text-accent" />
            预设库
            <span className="rounded-md bg-bg-elevated px-2 py-0.5 text-[11px] font-medium text-text-muted">
              {allPresets.length}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-text-muted">
            {collapsed
              ? activePreset ? `当前：${activePreset.name}` : "选择模板快速开始创作"
              : "按图片类型选择起点，模板仍可继续编辑。"}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {!collapsed && (
            <>
              <button type="button" onClick={() => importInputRef.current?.click()} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-default px-2.5 text-xs text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary" title="导入自定义预设">
                <Upload size={14} />
                导入
              </button>
              <button type="button" onClick={handleExport} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-default px-2.5 text-xs text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary" title="导出自定义预设">
                <Download size={14} />
                导出
              </button>
              <button
                type="button"
                onClick={openCreate}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-white transition hover:bg-accent-hover"
              >
                <Plus size={15} />
                新建预设
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((current) => !current)}
            className="flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-border-default text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary"
            aria-expanded={!collapsed}
            aria-controls="preset-library-content"
            aria-label={collapsed ? "展开预设库" : "收起预设库"}
            title={collapsed ? "展开预设库" : "收起预设库"}
          >
            <ChevronDown size={17} className={`transition-transform duration-200 ${collapsed ? "" : "rotate-180"}`} />
          </button>
        </div>
      </div>

      <input ref={importInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleImport} />

      {!collapsed && <div id="preset-library-content">
      <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="预设类别">
        {categoryOptions.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setCategory(item)}
            className={`min-h-9 rounded-md border px-2.5 text-xs transition ${
              category === item
                ? "border-accent/45 bg-accent/12 text-accent"
                : "border-border-subtle bg-bg-tertiary text-text-muted hover:bg-bg-elevated hover:text-text-primary"
            }`}
            role="tab"
            aria-selected={category === item}
          >
            {item}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {visiblePresets.map((preset) => {
          const active = preset.id === activePresetId;
          return (
            <article key={preset.id} className={`group overflow-hidden rounded-lg border transition ${active ? "border-accent/60 bg-accent/8" : "border-border-subtle bg-bg-tertiary/70 hover:border-border-default"}`}>
              <button type="button" onClick={() => onApplyPreset(preset)} className="block w-full text-left" aria-pressed={active}>
                <div className="relative aspect-[16/9] overflow-hidden bg-bg-primary">
                  {preset.cover ? (
                    <img src={preset.cover} alt={`${preset.name}预设封面`} className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.025]" loading="lazy" />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-bg-secondary text-text-muted">
                      <ImageIcon size={22} aria-hidden="true" />
                      <span className="text-[10px]">未设置封面</span>
                    </div>
                  )}
                  <span className="absolute bottom-2 left-2 rounded-md bg-bg-primary/80 px-2 py-1 text-[10px] text-text-secondary backdrop-blur">
                    {preset.category}
                  </span>
                </div>
                <div className="p-2.5">
                  <p className={`truncate text-xs font-semibold ${active ? "text-accent" : "text-text-primary"}`}>{preset.name}</p>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-text-muted">{preset.prompt}</p>
                </div>
              </button>
              {preset.source === "custom" && (
                <div className="flex justify-end gap-1 border-t border-border-subtle px-2 py-1.5">
                  <button type="button" onClick={() => openEdit(preset)} className="flex min-h-8 min-w-8 items-center justify-center rounded-md text-text-muted transition hover:bg-bg-elevated hover:text-text-primary" aria-label={`编辑${preset.name}`} title="编辑预设"><Pencil size={13} /></button>
                  <button type="button" onClick={() => handleDelete(preset)} className="flex min-h-8 min-w-8 items-center justify-center rounded-md text-text-muted transition hover:bg-error/10 hover:text-error" aria-label={`删除${preset.name}`} title="删除预设"><Trash2 size={13} /></button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      </div>}

      {showEditor && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="preset-editor-title">
          <div className="flex max-h-[94dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-lg border border-border-default bg-bg-secondary shadow-2xl sm:rounded-lg">
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-primary"><BookOpen size={17} className="text-accent" /><h2 id="preset-editor-title">{draft.id ? "编辑自定义预设" : "新建自定义预设"}</h2></div>
              <button type="button" onClick={() => setShowEditor(false)} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted transition hover:bg-bg-elevated hover:text-text-primary" aria-label="关闭预设编辑"><X size={18} /></button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                <div>
                  <label htmlFor="preset-name" className="text-sm font-medium text-text-secondary">预设名称 <span className="text-error">*</span></label>
                  <input id="preset-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="如：胶片感生活摄影" className="mt-2 min-h-12 w-full rounded-lg border border-border-default bg-bg-primary px-3 text-base text-text-primary placeholder:text-text-muted focus:border-accent/65" />
                </div>
                <div className="space-y-3">
                  <label htmlFor="preset-category" className="text-sm font-medium text-text-secondary">类别</label>
                  <select id="preset-category" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="min-h-12 w-full rounded-lg border border-border-default bg-bg-primary px-3 text-base text-text-primary focus:border-accent/65">
                    {BUILTIN_CATEGORY_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
                    <option value={CUSTOM_CATEGORY_VALUE}>自定义类别</option>
                  </select>
                  {draft.category === CUSTOM_CATEGORY_VALUE && (
                    <input
                      id="preset-custom-category"
                      value={draft.customCategory}
                      onChange={(event) => setDraft({ ...draft, customCategory: event.target.value })}
                      maxLength={30}
                      placeholder="输入类别名称"
                      aria-label="自定义类别名称"
                      className="min-h-12 w-full rounded-lg border border-border-default bg-bg-primary px-3 text-base text-text-primary placeholder:text-text-muted focus:border-accent/65"
                    />
                  )}
                </div>
              </div>
              <div>
                <label htmlFor="preset-prompt" className="text-sm font-medium text-text-secondary">提示词模板 <span className="text-error">*</span></label>
                <textarea id="preset-prompt" value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} rows={7} placeholder="写下可重复使用的高质量生成模板，用户选择后仍可修改。" className="mt-2 min-h-44 w-full resize-y rounded-lg border border-border-default bg-bg-primary px-3 py-3 text-base leading-7 text-text-primary placeholder:text-text-muted focus:border-accent/65" />
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between gap-3"><label className="text-sm font-medium text-text-secondary">示例封面 <span className="text-text-muted">（可选）</span></label><span className="text-xs text-text-muted">PNG/JPG，最大 8 MB</span></div>
                <button type="button" onClick={() => fileInputRef.current?.click()} className="flex min-h-36 w-full items-center justify-center overflow-hidden rounded-lg border border-dashed border-border-default bg-bg-tertiary/70 p-2 transition hover:border-accent/50 hover:bg-bg-elevated">
                  {draft.cover ? <img src={draft.cover} alt="自定义预设封面预览" className="h-32 w-full rounded-md object-cover" /> : <span className="flex flex-col items-center gap-2 text-sm text-text-muted"><Upload size={22} />上传预设封面（可选）</span>}
                </button>
                <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleCoverChange} />
                {draft.cover && (
                  <button type="button" onClick={() => setDraft({ ...draft, cover: "" })} className="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-md px-2 text-xs text-text-muted transition hover:bg-error/10 hover:text-error">
                    <Trash2 size={14} />移除封面
                  </button>
                )}
              </div>
              {error && <p className="rounded-lg border border-error/35 bg-error/10 p-3 text-sm leading-6 text-error" role="alert">{error}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-border-subtle px-4 py-4">
              <button type="button" onClick={() => setShowEditor(false)} className="min-h-11 rounded-lg border border-border-default px-4 text-sm text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary">取消</button>
              <button type="button" onClick={handleSave} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-5 text-sm font-semibold text-white transition hover:bg-accent-hover"><Plus size={16} />保存预设</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  ServerCog,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  buildProviderHeaders,
  EMPTY_PROVIDER_CONFIG,
  isProviderConfigComplete,
  PROVIDER_PRESETS,
} from "../lib/provider";
import { CLIENT_HEADERS } from "../lib/client";

const API_BASE = "/api";

function validateDraft(draft) {
  if (!draft.apiKey.trim()) return "请输入 API Key";
  if (!draft.endpoint.trim()) return "请输入图片生成接口地址";
  if (!draft.model.trim()) return "请输入模型标识";
  try {
    const endpoint = new URL(draft.endpoint.trim());
    if (endpoint.protocol !== "https:") return "公开部署仅支持 HTTPS 中转站";
  } catch {
    return "接口地址格式不正确";
  }
  return "";
}

export default function ProviderSettings({
  open,
  config,
  serverProviderConfigured,
  serverProviderHost,
  onSave,
  onClear,
  onClose,
}) {
  const [draft, setDraft] = useState(config);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const keyInputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setDraft(config);
    setError("");
    setChecked(false);
    setShowKey(false);
    const timer = window.setTimeout(() => keyInputRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [config, open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const updateDraft = (patch) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError("");
    setChecked(false);
  };

  const selectPreset = (presetId) => {
    const preset = PROVIDER_PRESETS[presetId];
    updateDraft({
      preset: presetId,
      endpoint: preset.endpoint,
      model: preset.model,
      authType: preset.authType,
    });
  };

  const checkConfiguration = async () => {
    const validationError = validateDraft(draft);
    if (validationError) {
      setError(validationError);
      return false;
    }
    setChecking(true);
    setError("");
    setChecked(false);
    try {
      const response = await fetch(`${API_BASE}/provider/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...CLIENT_HEADERS, ...buildProviderHeaders(draft) },
      });
      const data = await response.json();
      if (!response.ok || data.error) {
        setError(data.detail || data.error || "配置检查失败");
        return false;
      }
      setChecked(true);
      return true;
    } catch {
      setError("无法连接后端，请确认服务已经启动");
      return false;
    } finally {
      setChecking(false);
    }
  };

  const handleSave = async () => {
    const valid = checked || (await checkConfiguration());
    if (!valid) return;
    onSave({
      preset: draft.preset,
      endpoint: draft.endpoint.trim(),
      model: draft.model.trim(),
      authType: draft.authType,
      apiKey: draft.apiKey.trim(),
    });
  };

  const hasBrowserConfig = isProviderConfigComplete(config);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="provider-settings-title"
    >
      <div className="flex max-h-[94dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-lg border border-border-default bg-bg-secondary shadow-2xl sm:rounded-lg">
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/12 text-accent">
              <ServerCog size={20} strokeWidth={1.8} />
            </div>
            <div>
              <h2 id="provider-settings-title" className="text-base font-semibold text-text-primary">
                图片服务配置
              </h2>
              <p className="mt-1 text-sm leading-6 text-text-muted">连接 OpenRouter 或其他 OpenAI 兼容图片中转站。</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted transition hover:bg-bg-elevated hover:text-text-primary"
            aria-label="关闭服务配置"
          >
            <X size={19} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5">
          <div className="mb-5 flex items-start gap-3 rounded-lg border border-mint/25 bg-mint/8 p-3">
            <ShieldCheck size={18} className="mt-0.5 flex-shrink-0 text-mint" />
            <div>
              <p className="text-sm font-medium text-text-primary">Key 仅保存在当前标签页</p>
              <p className="mt-1 text-xs leading-6 text-text-muted">
                页面刷新后仍可使用，关闭标签页即清除。Key 只在生成请求时传给你的后端，不写入历史记录或服务器文件。
              </p>
            </div>
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-text-secondary">服务类型</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {Object.values(PROVIDER_PRESETS).map((preset) => {
                const active = draft.preset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => selectPreset(preset.id)}
                    className={`min-h-[76px] rounded-lg border p-3 text-left transition ${
                      active
                        ? "border-accent/50 bg-accent/12"
                        : "border-border-subtle bg-bg-tertiary/70 hover:border-border-default hover:bg-bg-elevated"
                    }`}
                    aria-pressed={active}
                  >
                    <span className={`block text-sm font-semibold ${active ? "text-accent" : "text-text-primary"}`}>
                      {preset.label}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-text-muted">{preset.description}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="mt-5 space-y-4">
            <div>
              <label htmlFor="provider-key" className="text-sm font-medium text-text-secondary">
                API Key <span className="text-error">*</span>
              </label>
              <div className="relative mt-2">
                <KeyRound size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                <input
                  ref={keyInputRef}
                  id="provider-key"
                  type={showKey ? "text" : "password"}
                  value={draft.apiKey}
                  onChange={(event) => updateDraft({ apiKey: event.target.value })}
                  autoComplete="off"
                  spellCheck="false"
                  placeholder="输入你自己的服务商 Key"
                  className="min-h-12 w-full rounded-lg border border-border-default bg-bg-primary pl-10 pr-12 text-base text-text-primary placeholder:text-text-muted focus:border-accent/65"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((current) => !current)}
                  className="absolute right-1 top-1/2 flex min-h-10 min-w-10 -translate-y-1/2 items-center justify-center rounded-md text-text-muted transition hover:bg-bg-elevated hover:text-text-primary"
                  aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                >
                  {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="provider-endpoint" className="text-sm font-medium text-text-secondary">
                图片生成接口 <span className="text-error">*</span>
              </label>
              <input
                id="provider-endpoint"
                type="url"
                value={draft.endpoint}
                onChange={(event) => updateDraft({ endpoint: event.target.value, preset: draft.preset === "openrouter" ? "custom" : draft.preset })}
                placeholder="https://example.com/v1/images/generations"
                className="mt-2 min-h-12 w-full rounded-lg border border-border-default bg-bg-primary px-3 text-base text-text-primary placeholder:text-text-muted focus:border-accent/65"
              />
              <p className="mt-1.5 text-xs leading-5 text-text-muted">填写完整的 OpenAI 兼容图片接口，而不是网站首页地址。</p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
              <div>
                <label htmlFor="provider-model" className="text-sm font-medium text-text-secondary">
                  模型标识 <span className="text-error">*</span>
                </label>
                <input
                  id="provider-model"
                  type="text"
                  value={draft.model}
                  onChange={(event) => updateDraft({ model: event.target.value })}
                  placeholder="服务商提供的模型 ID"
                  spellCheck="false"
                  className="mt-2 min-h-12 w-full rounded-lg border border-border-default bg-bg-primary px-3 text-base text-text-primary placeholder:text-text-muted focus:border-accent/65"
                />
              </div>
              <div>
                <label htmlFor="provider-auth" className="text-sm font-medium text-text-secondary">
                  鉴权方式
                </label>
                <select
                  id="provider-auth"
                  value={draft.authType}
                  onChange={(event) => updateDraft({ authType: event.target.value })}
                  className="mt-2 min-h-12 w-full rounded-lg border border-border-default bg-bg-primary px-3 text-base text-text-primary focus:border-accent/65"
                >
                  <option value="bearer">Bearer Token</option>
                  <option value="x-api-key">x-api-key</option>
                </select>
              </div>
            </div>
          </div>

          {serverProviderConfigured && !hasBrowserConfig && (
            <div className="mt-4 rounded-lg border border-border-subtle bg-bg-tertiary p-3 text-xs leading-6 text-text-muted">
              当前服务器已配置 {serverProviderHost || "默认图片服务"}。不填写个人 Key 时，生成任务会使用服务器配置。
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-lg border border-error/35 bg-error/10 p-3 text-sm leading-6 text-error" role="alert">
              {error}
            </div>
          )}
          {checked && !error && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-mint/30 bg-mint/10 p-3 text-sm text-mint" role="status">
              <CheckCircle2 size={17} />
              配置格式有效，可以保存使用
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border-subtle bg-bg-primary/45 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            {hasBrowserConfig && (
              <button
                type="button"
                onClick={() => {
                  onClear();
                  setDraft(EMPTY_PROVIDER_CONFIG);
                }}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm text-text-muted transition hover:bg-error/10 hover:text-error"
              >
                <Trash2 size={16} />
                清除个人配置
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={checkConfiguration}
              disabled={checking}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-border-default px-4 text-sm text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
            >
              {checking ? <Loader2 size={16} className="animate-spin-soft" /> : <ShieldCheck size={16} />}
              {checking ? "检查中" : "检查配置"}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={checking}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-5 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
            >
              保存并使用
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

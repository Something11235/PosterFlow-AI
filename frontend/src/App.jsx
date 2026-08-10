import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Copy,
  Download,
  History as HistoryIcon,
  Image as ImageIcon,
  Layers3,
  PanelRightOpen,
  ServerCog,
  WandSparkles,
} from "lucide-react";
import Gallery from "./components/Gallery";
import History from "./components/History";
import ImageModal from "./components/ImageModal";
import ParameterPanel from "./components/ParameterPanel";
import PromptEditor from "./components/PromptEditor";
import PresetLibrary from "./components/PresetLibrary";
import ProviderSettings from "./components/ProviderSettings";
import Sidebar from "./components/Sidebar";
import {
  buildProviderHeaders,
  clearProviderConfig,
  getProviderDisplayName,
  isProviderConfigComplete,
  loadProviderConfig,
  saveProviderConfig,
} from "./lib/provider";
import { CLIENT_HEADERS } from "./lib/client";
import { DEFAULT_PRESET } from "./lib/presets";

const API_BASE = "/api";
const DEFAULT_ERROR = {
  message: "生成失败，请检查接口配置",
  code: "GENERATE_FAILED",
  detail: "本次生成没有完成，请稍后重试或检查服务配置。",
  recovery: ["检查 API Key", "确认后端服务", "重新发起生成"],
};
const TECHNICAL_ERROR_PATTERNS = [
  /HTTPSConnectionPool/i,
  /NewConnectionError/i,
  /WinError/i,
  /urllib3/i,
  /requests\./i,
  /Traceback/i,
];

function normalizeApiError(data, fallback = DEFAULT_ERROR) {
  const rawMessage = String(data?.error || data?.message || "");
  const looksTechnical = TECHNICAL_ERROR_PATTERNS.some((pattern) => pattern.test(rawMessage));

  if (looksTechnical) {
    return {
      message: "无法连接图片生成服务",
      code: data?.code || "PROVIDER_NETWORK_BLOCKED",
      detail:
        data?.detail ||
        "后端向图片服务发起 HTTPS 请求时被网络策略拦截。常见原因包括中转站地址错误、防火墙、代理或当前运行环境禁止 Python 进程出站访问。",
      recovery: data?.recovery || [
        "允许 Python/服务器进程访问外网 443 端口",
        "确认中转站地址、代理和防火墙规则",
        "部署到可访问目标服务的公网服务器",
      ],
    };
  }

  return {
    message: rawMessage || fallback.message,
    code: data?.code || fallback.code,
    detail: data?.detail || fallback.detail,
    recovery: data?.recovery || fallback.recovery,
  };
}
const FALLBACK_STYLE_DATA = {
  styles: {
    "商务科技":
      "国际商务科技风，主色为深海蓝、科技银灰和冷白高光。构图理性克制，几何线条与低饱和科技元素交织，现代无衬线字体排版，适合企业招商海报。",
    "极简高级":
      "极简主义设计，大量留白，深色背景配金色或白色点缀。几何构图精准，字体纤细现代，画面干净克制，突出主体。",
    "霓虹都市":
      "赛博朋克都市夜景，霓虹灯光渲染，深紫与青色为主调。科技感数据流、全息投影元素，未来主义风格。",
    "自然生态":
      "自然光摄影风格，柔和色调，绿色植被与蓝天。画面清新通透，适合环保、ESG主题海报。",
    "工业制造":
      "工业纪实风格，金属质感与机械结构特写。深灰与橙色搭配，展现制造实力与精密工艺。",
    "金融财经":
      "金融商务风格，深蓝与金色搭配。数据图表、世界地图、货币符号等元素，稳健专业的视觉调性。",
    "医疗健康":
      "医疗科技风格，白色与浅蓝为主。洁净明亮，DNA双螺旋、分子结构等生命科学元素，专业可信。",
    "智慧城市":
      "智慧城市俯瞰图，5G网络、IoT设备、智能交通。蓝色数据流连接城市建筑，科技与人文融合。",
  },
  sizes: {
    square_1_1: { label: "正方形 1:1", width: 1024, height: 1024 },
    landscape_16_9: { label: "横版 16:9", width: 1792, height: 1008 },
    portrait_9_16: { label: "竖版 9:16", width: 1008, height: 1792 },
    landscape_4_3: { label: "横版 4:3", width: 1360, height: 1024 },
    portrait_3_4: { label: "竖版 3:4", width: 1024, height: 1360 },
    wide_21_9: { label: "超宽 21:9", width: 2016, height: 864 },
  },
};

const MODE_META = {
  "text-to-image": {
    label: "文生图",
    eyebrow: "独立生成",
    description: "每次只使用当前提示词，不继承上一轮图片或文字",
    icon: WandSparkles,
  },
  "image-to-image": {
    label: "图生图",
    eyebrow: "独立生成",
    description: "每次只使用当前提示词，可选一张参考图",
    icon: ImageIcon,
  },
  iterative: {
    label: "局部重绘",
    eyebrow: "参考上一轮",
    description: "自动参考上一轮结果，只根据本次追加要求重绘",
    icon: Layers3,
  },
};

export default function App() {
  const [mode, setMode] = useState("text-to-image");
  const [prompt, setPrompt] = useState(DEFAULT_PRESET.prompt);
  const [activePreset, setActivePreset] = useState(DEFAULT_PRESET);
  const [size, setSize] = useState("landscape_16_9");
  const [quality, setQuality] = useState("high");
  const [count, setCount] = useState(2);
  const [strength, setStrength] = useState(0.65);
  const [referenceFile, setReferenceFile] = useState(null);
  const [referencePreview, setReferencePreview] = useState(null);

  const [images, setImages] = useState([]);
  const [currentPrompt, setCurrentPrompt] = useState("");
  const [historyId, setHistoryId] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");

  const [showHistory, setShowHistory] = useState(false);
  const [showProviderSettings, setShowProviderSettings] = useState(false);
  const [previewImage, setPreviewImage] = useState(null);
  const [selectedImages, setSelectedImages] = useState(new Set());
  const [stylesData, setStylesData] = useState(FALLBACK_STYLE_DATA);
  const [providerConfig, setProviderConfig] = useState(loadProviderConfig);
  const [serverProvider, setServerProvider] = useState({ configured: false, host: "" });

  useEffect(() => {
    let alive = true;

    fetch(`${API_BASE}/styles`, { headers: CLIENT_HEADERS })
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        if (data?.styles && data?.sizes) {
          setStylesData({
            styles: { ...FALLBACK_STYLE_DATA.styles, ...data.styles },
            sizes: { ...FALLBACK_STYLE_DATA.sizes, ...data.sizes },
          });
        }
      })
      .catch(() => {
        if (!alive) return;
        setStylesData(FALLBACK_STYLE_DATA);
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/health`, { headers: CLIENT_HEADERS })
      .then((response) => response.json())
      .then((data) => {
        if (!alive) return;
        setServerProvider({
          configured: Boolean(data?.server_provider_configured),
          host: data?.default_provider_host || "",
        });
      })
      .catch(() => {
        if (alive) setServerProvider({ configured: false, host: "" });
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const modeMeta = MODE_META[mode];
  const sizeInfo = stylesData.sizes?.[size];
  const selectedCount = selectedImages.size;
  const hasBrowserProvider = isProviderConfigComplete(providerConfig);
  const providerConfigured = hasBrowserProvider || serverProvider.configured;
  const providerName = getProviderDisplayName(providerConfig, serverProvider.host);
  const providerHeaders = useMemo(
    () => ({ ...CLIENT_HEADERS, ...buildProviderHeaders(providerConfig) }),
    [providerConfig],
  );

  const workspaceStats = useMemo(
    () => [
      { label: "画幅", value: sizeInfo ? sizeInfo.label : "横版 16:9" },
      { label: "预设", value: activePreset?.name || "自由创作" },
      { label: "画质", value: quality === "high" ? "高清" : quality === "medium" ? "标准" : "自动" },
      { label: "批量", value: `${count} 张` },
    ],
    [activePreset, count, quality, sizeInfo],
  );

  const fileToBase64 = useCallback((file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }, []);

  const handleReferenceChange = useCallback((file) => {
    setReferenceFile(file);
    if (!file) {
      setReferencePreview(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => setReferencePreview(e.target.result);
    reader.readAsDataURL(file);
  }, []);

  const handleApplyPreset = useCallback((preset) => {
    setActivePreset(preset);
    setPrompt(preset.prompt);
    setNotice(`已载入预设：${preset.name}`);
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) {
      setError({
        message: "请输入提示词后再生成",
        code: "PROMPT_REQUIRED",
        detail: "生成图片需要先填写主体、场景、风格或选择一个预设模板。",
        recovery: ["填写提示词", "选择预设模板", "重新生成"],
      });
      return;
    }
    if (!providerConfigured) {
      setShowProviderSettings(true);
      setNotice("请先配置图片服务");
      return;
    }
    setError(null);
    setNotice("");
    setIsGenerating(true);
    setImages([]);
    setSelectedImages(new Set());

    try {
      const redrawFromPrevious = mode === "iterative" && images.length > 0;
      const body = redrawFromPrevious
        ? {
            prompt: prompt.trim(),
            previous_image: images[0].filename,
            strength,
            size,
            quality,
            parent_id: historyId,
          }
        : {
            prompt: prompt.trim(),
            size,
            quality,
            count,
            strength,
          };

      if (referenceFile && mode !== "text-to-image" && !redrawFromPrevious) {
        body.reference_b64 = await fileToBase64(referenceFile);
      }

      const res = await fetch(`${API_BASE}/${redrawFromPrevious ? "modify" : "generate"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...providerHeaders },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        const nextError = normalizeApiError(data);
        setError(nextError);
        if (nextError.code === "PROVIDER_KEY_MISSING") setShowProviderSettings(true);
        return;
      }
      setImages(data.images || []);
      setCurrentPrompt(data.prompt || prompt);
      setHistoryId(data.history_id);
      setNotice(redrawFromPrevious ? "局部重绘完成，已写入历史记录" : "生成完成，已写入历史记录");
    } catch {
      setError({
        message: "无法连接后端服务",
        code: "BACKEND_OFFLINE",
        detail: "浏览器没有收到后端 API 响应，请确认 Flask 服务正在运行。",
        recovery: ["启动 python backend/server.py", "检查 5000 端口", "重新发起生成"],
      });
    } finally {
      setIsGenerating(false);
    }
  }, [
    count,
    fileToBase64,
    historyId,
    images,
    mode,
    prompt,
    providerConfigured,
    providerHeaders,
    quality,
    referenceFile,
    size,
    strength,
  ]);

  const handleModify = useCallback(
    async (modifyPrompt, prevImage) => {
      if (!modifyPrompt.trim()) return;
      setError(null);
      setIsGenerating(true);

      try {
        const res = await fetch(`${API_BASE}/modify`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...providerHeaders },
          body: JSON.stringify({
            prompt: modifyPrompt.trim(),
            previous_image: prevImage,
            strength,
            size,
            quality,
            parent_id: historyId,
          }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setError(
            normalizeApiError(data, {
              message: "迭代失败",
              code: "MODIFY_FAILED",
              detail: "本次迭代请求没有完成。",
              recovery: ["检查后端服务", "确认原图仍存在", "重新发起迭代"],
            }),
          );
          return;
        }
        setImages(data.images || []);
        setCurrentPrompt(data.prompt || modifyPrompt);
        setHistoryId(data.history_id);
        setNotice("迭代版本已生成");
      } catch {
        setError({
          message: "无法连接后端服务",
          code: "BACKEND_OFFLINE",
          detail: "浏览器没有收到后端 API 响应，请确认 Flask 服务正在运行。",
          recovery: ["启动 python backend/server.py", "检查 5000 端口", "重新发起迭代"],
        });
      } finally {
        setIsGenerating(false);
      }
    },
    [historyId, providerHeaders, quality, size, strength],
  );

  const handleSaveProvider = useCallback((nextConfig) => {
    saveProviderConfig(nextConfig);
    setProviderConfig(nextConfig);
    setShowProviderSettings(false);
    setError(null);
    setNotice("图片服务配置已保存到当前标签页");
  }, []);

  const handleClearProvider = useCallback(() => {
    clearProviderConfig();
    setProviderConfig(loadProviderConfig());
    setError(null);
    setNotice(serverProvider.configured ? "已切换为服务器默认配置" : "个人服务配置已清除");
  }, [serverProvider.configured]);

  const handleLoadFromHistory = useCallback((entry) => {
    setPrompt(entry.prompt);
    setActivePreset(null);
    setSize(entry.size || "landscape_16_9");
    if (entry.quality) setQuality(entry.quality);
    if (entry.strength !== undefined) setStrength(entry.strength);
    if (entry.count !== undefined) setCount(entry.count);
    setShowHistory(false);
    setNotice("历史提示词已载入");
  }, []);

  const handleCopyPrompt = useCallback(async () => {
    const text = currentPrompt || prompt;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setNotice("提示词已复制");
  }, [currentPrompt, prompt]);

  const handleSelectImage = useCallback((filename) => {
    setSelectedImages((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  }, []);

  const handleDownloadBatch = useCallback(async () => {
    if (selectedImages.size === 0) return;
    try {
      const res = await fetch(`${API_BASE}/download-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...CLIENT_HEADERS },
        body: JSON.stringify({ filenames: [...selectedImages] }),
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ai-poster-export.zip";
      a.click();
      URL.revokeObjectURL(url);
      setNotice("已开始下载 ZIP");
    } catch {
      setError({
        message: "下载失败，请重试",
        code: "DOWNLOAD_FAILED",
        detail: "浏览器没有完成批量导出请求，可能是网络中断或后端文件不可用。",
        recovery: ["确认图片仍在输出目录", "重新选择图片", "再次导出"],
      });
    }
  }, [selectedImages]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleGenerate();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") {
        e.preventDefault();
        setShowHistory((p) => !p);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleGenerate]);

  return (
    <div className="min-h-dvh bg-bg-primary text-text-primary subtle-grid lg:h-dvh lg:overflow-hidden">
      <div className="flex min-h-dvh flex-col lg:h-dvh lg:flex-row">
        <Sidebar
          mode={mode}
          modes={MODE_META}
          onModeChange={setMode}
          showHistory={showHistory}
          onToggleHistory={() => setShowHistory((p) => !p)}
          providerConfigured={providerConfigured}
          providerName={providerName}
          onOpenProvider={() => setShowProviderSettings(true)}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-border-subtle bg-bg-primary/92 px-4 py-3 backdrop-blur lg:px-6">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/12 text-accent">
                  <modeMeta.icon size={20} strokeWidth={1.8} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                  <h1 className="truncate text-base font-semibold text-text-primary">AI图片工坊</h1>
                    <span className="rounded-md border border-mint/25 bg-mint/10 px-2 py-0.5 text-[11px] font-medium text-mint">
                      多服务商在线工作台
                    </span>
                  </div>
                  <p className="truncate text-sm text-text-muted">
                    {modeMeta.eyebrow} · {modeMeta.description}
                  </p>
                </div>
              </div>

              <div className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
                {workspaceStats.map((item) => (
                  <div key={item.label} className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2">
                    <p className="text-[11px] text-text-muted">{item.label}</p>
                    <p className="mt-0.5 text-xs font-medium text-text-secondary">{item.value}</p>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setShowHistory((p) => !p)}
                  className="col-span-2 flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border-subtle bg-bg-secondary px-3 text-sm text-text-secondary transition hover:border-border-default hover:bg-bg-elevated hover:text-text-primary sm:col-span-1"
                >
                  <HistoryIcon size={16} />
                  历史
                </button>
                <button
                  type="button"
                  onClick={() => setShowProviderSettings(true)}
                  aria-label="图片服务配置"
                  title="图片服务配置"
                  className={`col-span-2 flex min-h-11 items-center justify-center gap-2 rounded-lg border px-3 text-sm transition sm:col-span-1 ${
                    providerConfigured
                      ? "border-mint/30 bg-mint/10 text-mint hover:bg-mint/15"
                      : "border-gold/35 bg-gold/10 text-gold hover:bg-gold/15"
                  }`}
                >
                  <ServerCog size={16} />
                  <span className="max-w-36 truncate">{providerName}</span>
                </button>
              </div>
            </div>
          </header>

          <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[minmax(360px,430px)_minmax(0,1fr)] lg:overflow-hidden lg:p-6">
            <section className="flex min-h-0 flex-col gap-4 lg:overflow-y-auto lg:pr-1">
              <PresetLibrary activePresetId={activePreset?.id} onApplyPreset={handleApplyPreset} />
              <PromptEditor
                prompt={prompt}
                onPromptChange={setPrompt}
                onGenerate={handleGenerate}
                isGenerating={isGenerating}
                currentPrompt={currentPrompt}
                referenceFile={referenceFile}
                onReferenceChange={handleReferenceChange}
                referencePreview={referencePreview}
                mode={mode}
                onCopyPrompt={handleCopyPrompt}
                providerConfigured={providerConfigured}
                presetName={activePreset?.name}
                presetCategory={activePreset?.category}
                hasPreviousImage={images.length > 0}
              />
              <ParameterPanel
                size={size}
                onSizeChange={setSize}
                quality={quality}
                onQualityChange={setQuality}
                count={count}
                onCountChange={setCount}
                strength={strength}
                onStrengthChange={setStrength}
                sizes={stylesData.sizes}
                mode={mode}
              />
            </section>

            <section className="min-h-[620px] min-w-0 lg:min-h-0">
              <Gallery
                images={images}
                isGenerating={isGenerating}
                error={error}
                currentPrompt={currentPrompt}
                mode={mode}
                selectedCount={selectedCount}
                onPreview={setPreviewImage}
                onModify={mode === "iterative" ? handleModify : null}
                selectedImages={selectedImages}
                onSelectImage={handleSelectImage}
                onSelectAll={() => setSelectedImages(new Set(images.map((img) => img.filename)))}
                onClearSelection={() => setSelectedImages(new Set())}
                onDownloadBatch={handleDownloadBatch}
                onCopyPrompt={handleCopyPrompt}
                onRetry={handleGenerate}
                providerModel={hasBrowserProvider ? providerConfig.model : "服务器默认模型"}
                presetName={activePreset?.name}
                presetCategory={activePreset?.category}
              />
            </section>
          </div>
        </main>

        {showHistory && <History onClose={() => setShowHistory(false)} onLoadEntry={handleLoadFromHistory} />}
      </div>

      {previewImage && (
        <ImageModal
          filename={previewImage}
          onClose={() => setPreviewImage(null)}
          onModify={mode === "iterative" ? handleModify : null}
        />
      )}

      <ProviderSettings
        open={showProviderSettings}
        config={providerConfig}
        serverProviderConfigured={serverProvider.configured}
        serverProviderHost={serverProvider.host}
        onSave={handleSaveProvider}
        onClear={handleClearProvider}
        onClose={() => setShowProviderSettings(false)}
      />

      {(notice || selectedCount > 0) && (
        <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border-default bg-bg-secondary px-4 py-3 text-sm text-text-secondary shadow-2xl">
          {notice ? (
            <>
              <Activity size={16} className="text-mint" />
              {notice}
            </>
          ) : (
            <>
              <PanelRightOpen size={16} className="text-accent" />
              已选择 {selectedCount} 张
            </>
          )}
          {selectedCount > 0 && (
            <button
              type="button"
              onClick={handleDownloadBatch}
              className="ml-2 inline-flex min-h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-white transition hover:bg-accent-hover"
            >
              <Download size={14} />
              导出
            </button>
          )}
          {(currentPrompt || prompt) && (
            <button
              type="button"
              onClick={handleCopyPrompt}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border-subtle px-3 text-xs text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary"
            >
              <Copy size={14} />
              复制
            </button>
          )}
        </div>
      )}
    </div>
  );
}

import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Copy,
  Download,
  History as HistoryIcon,
  Layers3,
  PanelsTopLeft,
  PanelRightOpen,
  ServerCog,
  WandSparkles,
} from "lucide-react";
import Gallery from "./components/Gallery";
import History from "./components/History";
import ImageModal from "./components/ImageModal";
import AuthModal from "./components/AuthModal";
import AccountPanel from "./components/AccountPanel";
import AdminMetricsPanel from "./components/AdminMetricsPanel";
import RechargePanel from "./components/RechargePanel";
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
  MAX_REFERENCE_IMAGES,
  saveProviderConfig,
} from "./lib/provider";
import { CLIENT_HEADERS } from "./lib/client";
import { DEFAULT_PRESET } from "./lib/presets";
import { supabase, supabaseConfigured } from "./lib/supabase";

const CanvasWorkspace = lazy(() => import("./components/FabricCanvasWorkspace"));

const API_BASE = "/api";

function createRequestId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
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
  create: {
    label: "AI创作",
    eyebrow: "文字 + 素材",
    description: "像 GPT 图片一样，用提示词和可选参考素材共同创作",
    icon: WandSparkles,
  },
  iterative: {
    label: "局部重绘",
    eyebrow: "参考上一轮",
    description: "自动参考上一轮结果，只根据本次追加要求重绘",
    icon: Layers3,
  },
  canvas: {
    label: "无限画布",
    eyebrow: "本机项目",
    description: "自由排版、标注、导入图片并导出完整视觉画布",
    icon: PanelsTopLeft,
  },
};

export default function App() {
  const [mode, setMode] = useState("create");
  const [prompt, setPrompt] = useState(DEFAULT_PRESET?.prompt || "");
  const [activePreset, setActivePreset] = useState(DEFAULT_PRESET);
  const [size, setSize] = useState("landscape_16_9");
  const [customSize, setCustomSize] = useState({ width: "1024", height: "1024" });
  const [quality, setQuality] = useState("auto");
  const [count, setCount] = useState(1);
  const [referenceFiles, setReferenceFiles] = useState([]);
  const [referencePreviews, setReferencePreviews] = useState([]);

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
  const [serverProvider, setServerProvider] = useState({ configured: false, platformConfigured: false, host: "", paymentEnabled: false, paymentChannels: [] });
  const [pendingCanvasImport, setPendingCanvasImport] = useState(null);
  const [billingMode, setBillingMode] = useState("platform");
  const [session, setSession] = useState(null);
  const [account, setAccount] = useState(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const sessionRef = useRef(null);
  const accountRequestRef = useRef(0);
  const [authOpen, setAuthOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [rechargeOpen, setRechargeOpen] = useState(false);

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

  const authHeaders = useMemo(
    () => ({ ...CLIENT_HEADERS, ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) }),
    [session],
  );

  const refreshAccount = useCallback(async (activeSession) => {
    const targetSession = activeSession || sessionRef.current;
    const requestNumber = ++accountRequestRef.current;
    if (!targetSession?.access_token) {
      setAccount(null);
      setAccountLoading(false);
      return null;
    }
    setAccountLoading(true);
    try {
      const response = await fetch(`${API_BASE}/account`, {
        headers: { ...CLIENT_HEADERS, Authorization: `Bearer ${targetSession.access_token}` },
        credentials: "include",
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.detail || data.error || "账户信息加载失败");
      if (requestNumber === accountRequestRef.current) setAccount(data);
      return data;
    } catch (reason) {
      if (requestNumber === accountRequestRef.current) {
        setError({ message: "账户信息暂时不可用", code: "ACCOUNT_LOAD_FAILED", detail: reason.message, recovery: ["检查 Supabase 配置", "刷新页面", "稍后重试"] });
      }
      return null;
    } finally {
      if (requestNumber === accountRequestRef.current) setAccountLoading(false);
    }
  }, []);

  const syncBackendSession = useCallback(async (nextSession) => {
    if (!nextSession?.access_token) return;
    try {
      await fetch(`${API_BASE}/auth/session`, {
        method: "POST",
        headers: { ...CLIENT_HEADERS, Authorization: `Bearer ${nextSession.access_token}` },
        credentials: "include",
      });
    } catch {
      // Protected requests still carry the bearer token; the cookie is a convenience for asset requests.
    }
  }, []);

  useEffect(() => {
    if (!supabaseConfigured || !supabase) return undefined;
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      sessionRef.current = data.session;
      setSession(data.session);
      if (data.session) {
        syncBackendSession(data.session);
        refreshAccount(data.session);
      }
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      sessionRef.current = nextSession;
      setSession(nextSession);
      if (nextSession) {
        syncBackendSession(nextSession);
        refreshAccount(nextSession);
      } else {
        accountRequestRef.current += 1;
        setAccount(null);
        setAccountLoading(false);
      }
    });
    return () => {
      alive = false;
      listener.subscription.unsubscribe();
    };
  }, [refreshAccount, syncBackendSession]);

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/health`, { headers: CLIENT_HEADERS })
      .then((response) => response.json())
      .then((data) => {
        if (!alive) return;
        setServerProvider({
          configured: Boolean(data?.server_provider_configured),
          platformConfigured: Boolean(data?.platform_provider_configured),
          host: "",
          paymentEnabled: Boolean(data?.payment_enabled),
          paymentChannels: Array.isArray(data?.payment_channels) ? data.payment_channels : [],
        });
      })
      .catch(() => {
        if (alive) setServerProvider({ configured: false, platformConfigured: false, host: "", paymentEnabled: false, paymentChannels: [] });
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
  const platformReady = Boolean(serverProvider.platformConfigured && session);
  const providerConfigured = billingMode === "platform" ? platformReady : hasBrowserProvider;
  // 平台积分模式不向用户暴露实际中转站/服务商域名；自带 Key 模式仍显示用户自己的配置。
  const providerName = billingMode === "platform" ? "平台图片服务" : getProviderDisplayName(providerConfig, serverProvider.host);
  const visibleServerProviderHost = billingMode === "platform" ? "平台图片服务" : "服务器图片服务";
  const providerHeaders = useMemo(
    () => ({
      ...authHeaders,
      "X-Billing-Mode": billingMode,
      ...(billingMode === "own_key" ? buildProviderHeaders(providerConfig) : {}),
    }),
    [authHeaders, billingMode, providerConfig],
  );

  const updateCreditBalance = useCallback((balance) => {
    if (balance === undefined || balance === null) return;
    setAccount((current) => {
      if (!current) return current;
      return { ...current, credits: { ...(current.credits || {}), balance } };
    });
  }, []);

  const requireGenerationAccess = useCallback(() => {
    if (billingMode === "platform" && !session) {
      setAuthOpen(true);
      setNotice("请先登录，验证邮箱后即可领取 10 个免费积分");
      return false;
    }
    if (billingMode === "platform" && !serverProvider.platformConfigured) {
      setShowProviderSettings(true);
      setError({
        message: "平台积分服务尚未配置",
        code: "PLATFORM_PROVIDER_NOT_CONFIGURED",
        detail: "管理员还没有配置平台侧图片服务，请切换到自带 API Key 模式，或稍后再试。",
        recovery: ["切换到自带 API Key 模式", "联系管理员配置平台服务"],
      });
      return false;
    }
    if (billingMode === "own_key" && !hasBrowserProvider && !serverProvider.configured) {
      setShowProviderSettings(true);
      setError({
        message: "请先配置图片服务",
        code: "PROVIDER_KEY_MISSING",
        detail: "自带 Key 模式需要填写 API Key、接口地址和模型标识。",
        recovery: ["打开图片服务配置", "选择中转站并填写 Key"],
      });
      return false;
    }
    return true;
  }, [billingMode, hasBrowserProvider, serverProvider.configured, serverProvider.platformConfigured, session]);

  const workspaceStats = useMemo(() => {
    if (mode === "canvas") {
      return [
        { label: "存储", value: "当前浏览器" },
        { label: "可用素材", value: `${images.length} 张` },
        { label: "画布", value: "自动保存" },
      ];
    }
    return [
      { label: "画幅", value: sizeInfo ? sizeInfo.label : "横版 16:9" },
      { label: "预设", value: activePreset?.name || "自由创作" },
      { label: "画质", value: quality === "high" ? "高清" : quality === "medium" ? "标准" : "自动" },
      { label: "批量", value: `${count} 张` },
    ];
  }, [activePreset, count, images.length, mode, quality, sizeInfo]);

  const handleAddToCanvas = useCallback((filenames) => {
    const uniqueFilenames = [...new Set(filenames.filter(Boolean))];
    if (!uniqueFilenames.length) return;
    setPendingCanvasImport({
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      filenames: uniqueFilenames,
    });
    setSelectedImages(new Set());
    setShowHistory(false);
    setMode("canvas");
    setNotice(`正在送入画布：${uniqueFilenames.length} 张图片`);
  }, []);

  const handleCanvasGenerated = useCallback(({ image, prompt: generatedPrompt, historyId: generatedHistoryId }) => {
    setImages([image]);
    setCurrentPrompt(generatedPrompt);
    setHistoryId(generatedHistoryId);
  }, []);

  const fileToBase64 = useCallback((file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }, []);

  const handleReferenceChange = useCallback((files) => {
    const nextFiles = Array.isArray(files) ? files.slice(0, MAX_REFERENCE_IMAGES) : files ? [files] : [];
    setReferenceFiles(nextFiles);
    setReferencePreviews([]);
    Promise.all(nextFiles.map((file) => new Promise((resolve) => {
      const reader = new FileReader(); reader.onload = (event) => resolve(event.target.result); reader.onerror = () => resolve(""); reader.readAsDataURL(file);
    }))).then(setReferencePreviews);
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
    if (!requireGenerationAccess()) return;
    if (!providerConfigured) {
      setShowProviderSettings(true);
      setNotice("请先配置图片服务");
      return;
    }
    const previousImages = images;
    const previousHistoryId = historyId;
    const requestId = createRequestId();
    setError(null);
    setNotice("");
    setIsGenerating(true);
    setImages([]);
    setSelectedImages(new Set());

    try {
      const redrawFromPrevious = mode === "iterative" && previousImages.length > 0;
      const body = redrawFromPrevious
        ? {
            prompt: prompt.trim(),
            previous_image: previousImages[0].filename,
            size,
            ...(size === "custom" ? { custom_width: customSize.width, custom_height: customSize.height } : {}),
            quality,
            parent_id: previousHistoryId,
          }
        : {
            prompt: prompt.trim(),
            size,
            ...(size === "custom" ? { custom_width: customSize.width, custom_height: customSize.height } : {}),
            quality,
            count,
          };
      body.request_id = requestId;

      if (referenceFiles.length && !redrawFromPrevious) {
        body.reference_images_b64 = await Promise.all(referenceFiles.map(fileToBase64));
      }

      const res = await fetch(`${API_BASE}/${redrawFromPrevious ? "modify" : "generate"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Request-Id": requestId, ...providerHeaders },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        const nextError = normalizeApiError(data);
        setError(nextError);
        if (nextError.code === "EMAIL_UNVERIFIED") setNotice("请先完成邮箱验证，验证后即可使用免费积分");
        if (nextError.code === "PROVIDER_KEY_MISSING") setShowProviderSettings(true);
        await refreshAccount();
        return;
      }
      setImages(data.images || []);
      setCurrentPrompt(data.prompt || prompt);
      setHistoryId(data.history_id);
      updateCreditBalance(data.credit_balance);
      await refreshAccount();
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
    customSize.height,
    customSize.width,
    fileToBase64,
    historyId,
    images,
    mode,
    prompt,
    providerConfigured,
    providerHeaders,
    quality,
    referenceFiles,
    size,
    refreshAccount,
    requireGenerationAccess,
    updateCreditBalance,
  ]);

  const handleModify = useCallback(
    async (modifyPrompt, prevImage) => {
      if (!modifyPrompt.trim()) return;
      if (!requireGenerationAccess()) return;
      const requestId = createRequestId();
      setError(null);
      setIsGenerating(true);

      try {
        const res = await fetch(`${API_BASE}/modify`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Request-Id": requestId, ...providerHeaders },
          body: JSON.stringify({
            prompt: modifyPrompt.trim(),
            previous_image: prevImage,
            size,
            ...(size === "custom" ? { custom_width: customSize.width, custom_height: customSize.height } : {}),
            quality,
            parent_id: historyId,
            request_id: requestId,
          }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          const nextError = normalizeApiError(data, {
            message: "迭代失败",
            code: "MODIFY_FAILED",
            detail: "本次迭代请求没有完成。",
            recovery: ["检查后端服务", "确认原图仍存在", "重新发起迭代"],
          });
          setError(nextError);
          if (nextError.code === "EMAIL_UNVERIFIED") setNotice("请先完成邮箱验证，验证后即可使用免费积分");
          await refreshAccount();
          return;
        }
        setImages(data.images || []);
        setCurrentPrompt(data.prompt || modifyPrompt);
        setHistoryId(data.history_id);
        updateCreditBalance(data.credit_balance);
        await refreshAccount();
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
    [customSize.height, customSize.width, historyId, providerHeaders, quality, refreshAccount, requireGenerationAccess, size, updateCreditBalance],
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
    if (entry.size === "custom") {
      setCustomSize({
        width: String(entry.custom_width || 1024),
        height: String(entry.custom_height || 1024),
      });
    }
    if (entry.quality) setQuality(entry.quality);
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
        headers: { "Content-Type": "application/json", ...authHeaders },
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
  }, [authHeaders, selectedImages]);

  const handleSignOut = useCallback(async () => {
    await supabase?.auth.signOut();
    await fetch(API_BASE + "/auth/session", { method: "DELETE", headers: CLIENT_HEADERS, credentials: "include" });
    sessionRef.current = null; accountRequestRef.current += 1;
    setSession(null); setAccount(null); setAccountLoading(false); setAccountOpen(false); setNotice("已退出登录");
  }, []);

  const handleDeleteAccount = useCallback(async () => {
    const response = await fetch(API_BASE + "/account", { method: "DELETE", headers: authHeaders, credentials: "include" });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.detail || data.error || "删除账号失败");
    await supabase?.auth.signOut(); sessionRef.current = null; accountRequestRef.current += 1;
    setSession(null); setAccount(null); setAccountLoading(false); setAccountOpen(false); setNotice("账号已删除");
  }, [authHeaders]);

  useEffect(() => {
    const handler = (e) => {
      if (mode !== "canvas" && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
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
  }, [handleGenerate, mode]);

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
          session={session}
          account={account}
          isAdmin={Boolean(account?.is_admin)}
          accountLoading={accountLoading}
          onOpenAuth={() => setAuthOpen(true)}
          onOpenAccount={() => setAccountOpen(true)}
          onOpenMetrics={() => setMetricsOpen(true)}
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
                    <h1 className="truncate text-base font-semibold text-text-primary">
                      {mode === "canvas" ? "视觉无限画布" : "AI图片工坊"}
                    </h1>
                    <span className="rounded-md border border-mint/25 bg-mint/10 px-2 py-0.5 text-[11px] font-medium text-mint">
                      多服务商在线工作台
                    </span>
                  </div>
                  <p className="truncate text-sm text-text-muted">
                    {modeMeta.eyebrow} · {modeMeta.description}
                  </p>
                </div>
              </div>

              <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
                {workspaceStats.map((item) => (
                  <div
                    key={item.label}
                    className={`rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2 ${
                      mode === "canvas" ? "hidden sm:block" : ""
                    }`}
                  >
                    <p className="text-[11px] text-text-muted">{item.label}</p>
                    <p className="mt-0.5 text-xs font-medium text-text-secondary">{item.value}</p>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setShowHistory((p) => !p)}
                  className="flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border-subtle bg-bg-secondary px-3 text-sm text-text-secondary transition hover:border-border-default hover:bg-bg-elevated hover:text-text-primary"
                >
                  <HistoryIcon size={16} />
                  历史
                </button>
                <button
                  type="button"
                  onClick={() => setShowProviderSettings(true)}
                  aria-label="图片服务配置"
                  title="图片服务配置"
                  className={`flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-lg border px-3 text-sm transition ${
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

          {mode === "canvas" && (
            <>
              <div className="h-[680px] flex-none lg:h-auto lg:min-h-0 lg:flex-1">
              <Suspense
                fallback={
                  <div className="flex h-full min-h-[680px] items-center justify-center gap-3 bg-bg-primary text-sm text-text-muted lg:min-h-0">
                    <Activity size={17} className="animate-spin-soft text-accent" />
                    正在加载画布
                  </div>
                }
              >
                <CanvasWorkspace
                  galleryImages={images}
                  pendingImport={pendingCanvasImport}
                  onImportHandled={(id) =>
                    setPendingCanvasImport((current) => (current?.id === id ? null : current))
                  }
                  onNotice={setNotice}
                  providerConfigured={providerConfigured}
                  providerName={providerName}
                  providerHeaders={providerHeaders}
                  billingMode={billingMode}
                  authenticated={Boolean(session)}
                  onAuthRequired={() => { setAuthOpen(true); setNotice("请先登录，验证邮箱后即可使用免费积分"); }}
                  onAccountRefresh={refreshAccount}
                  onOpenProvider={() => setShowProviderSettings(true)}
                  onCanvasGenerated={handleCanvasGenerated}
                  onOpenRecharge={() => setRechargeOpen(true)}
                />
              </Suspense>
            </div>
            </>
          )}

          <div
            className={
              mode === "canvas"
                ? "hidden"
                : "grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[minmax(360px,430px)_minmax(0,1fr)] lg:overflow-hidden lg:p-6"
            }
          >
            <section className="flex min-h-0 flex-col gap-4 lg:overflow-y-auto lg:pr-1">
              <PresetLibrary activePresetId={activePreset?.id} onApplyPreset={handleApplyPreset} />
              <PromptEditor
                prompt={prompt}
                onPromptChange={setPrompt}
                onGenerate={handleGenerate}
                isGenerating={isGenerating}
                currentPrompt={currentPrompt}
                referenceFiles={referenceFiles}
                onReferenceChange={handleReferenceChange}
                referencePreviews={referencePreviews}
                mode={mode}
                onCopyPrompt={handleCopyPrompt}
                providerConfigured={providerConfigured}
                presetName={activePreset?.name}
                presetCategory={activePreset?.category}
                authenticated={Boolean(session)}
                hasPreviousImage={images.length > 0}
              />
              <ParameterPanel
                size={size}
                onSizeChange={setSize}
                customSize={customSize}
                onCustomSizeChange={setCustomSize}
                quality={quality}
                onQualityChange={setQuality}
                count={count}
                onCountChange={setCount}
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
                onAddToCanvas={handleAddToCanvas}
                onCopyPrompt={handleCopyPrompt}
                onRetry={handleGenerate}
                providerModel={hasBrowserProvider ? providerConfig.model : "服务器默认模型"}
                presetName={activePreset?.name}
                presetCategory={activePreset?.category}
                authenticated={Boolean(session)}
              />
            </section>
          </div>
        </main>

        {showHistory && <History onClose={() => setShowHistory(false)} onLoadEntry={handleLoadFromHistory} authHeaders={authHeaders} authenticated={Boolean(session)} />}
      </div>

      {previewImage && (
        <ImageModal
          filename={previewImage}
          onClose={() => setPreviewImage(null)}
          onModify={mode === "iterative" ? handleModify : null}
          authenticated={Boolean(session)}
        />
      )}

      <ProviderSettings
        open={showProviderSettings}
        config={providerConfig}
        serverProviderConfigured={serverProvider.configured}
        serverProviderHost={visibleServerProviderHost}
        onSave={handleSaveProvider}
        onClear={handleClearProvider}
        billingMode={billingMode}
        onBillingModeChange={setBillingMode}
        platformReady={platformReady}
        session={session}
        account={account}
        onClose={() => setShowProviderSettings(false)}
      />

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} onNotice={setNotice} />
      <AccountPanel open={accountOpen} account={account} loading={accountLoading} paymentEnabled={serverProvider.paymentEnabled} onClose={() => setAccountOpen(false)} onSignOut={handleSignOut} onDelete={handleDeleteAccount} onOpenRecharge={() => { setAccountOpen(false); setRechargeOpen(true); }} />
      <AdminMetricsPanel open={metricsOpen} authHeaders={authHeaders} onClose={() => setMetricsOpen(false)} />
      <RechargePanel open={rechargeOpen} authHeaders={authHeaders} account={account} paymentEnabled={serverProvider.paymentEnabled} paymentChannels={serverProvider.paymentChannels} onClose={() => setRechargeOpen(false)} onAccountRefresh={() => refreshAccount()} />

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

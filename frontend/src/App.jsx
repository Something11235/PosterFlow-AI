import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Activity,
  Copy,
  Download,
  Layers3,
  PanelsTopLeft,
  PanelRightOpen,
  ServerCog,
  WandSparkles,
} from "lucide-react";
import Gallery from "./components/Gallery";
import { canvasEditCapability } from "./lib/canvasImageEditing";
import ImageTaskQueue from "./components/ImageTaskQueue";
import ImageTasksPanel from "./components/ImageTasksPanel";
import { createImageTaskStore, IMAGE_TASK_LIMIT, referenceCapability } from "./lib/imageTasks";
import { imageGenerationFetch, readImageTask, listImageTasks, usesBuyToken } from "./lib/apimartImages";
import ImageModal from "./components/ImageModal";
import AuthModal from "./components/AuthModal";
import AccountPanel from "./components/AccountPanel";
import AnnouncementBanner from "./components/AnnouncementBanner";
import AdminMetricsPanel from "./components/AdminMetricsPanel";
import RechargePanel from "./components/RechargePanel";
import CommunityQrModal from "./components/CommunityQrModal";
import PromptHistoryPanel from "./components/PromptHistoryPanel";
import { rememberGuestPrompt } from "./lib/promptHistory";
import ParameterPanel from "./components/ParameterPanel";
import PromptEditor from "./components/PromptEditor";
import PresetLibrary from "./components/PresetLibrary";
import { companionFile } from "./lib/aiCompanions";
import ProviderSettings from "./components/ProviderSettings";
import Sidebar from "./components/Sidebar";
import StudioNavigation from "./components/studio/StudioNavigation";
import "./components/studio/studio.css";
import {
  buildProviderHeaders,
  apimartImageModel,
  imageResolutionSpec,
  DEFAULT_PLATFORM_MODEL,
  clearProviderConfig,
  getProviderDisplayName,
  isProviderConfigComplete,
  loadProviderConfig,
  MAX_REFERENCE_IMAGES,
  saveProviderConfig,
} from "./lib/provider";
import { CLIENT_HEADERS, clearImageUrlCache, downloadImage, recoverGeneration } from "./lib/client";
import { createImageArchive } from "./lib/batchDownload";
import { saveBrowserFile } from "./lib/browserSave";
import { DEFAULT_PRESET } from "./lib/presets";
import { cleanupReferencePaths, uploadReferenceFiles } from "./lib/referenceUpload";
import { appendReferenceFiles, removeReferenceMentions } from "./lib/referenceSelection";
import { supabase, supabaseConfigured } from "./lib/supabase";

const CanvasWorkspace = lazy(() => import("./components/FabricCanvasWorkspace"));
const StudioWorkspace = lazy(() => import("./components/studio/StudioWorkspace"));

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
      submission_unknown: Boolean(data?.submission_unknown),
      upstream_error: data?.upstream_error,
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
    submission_unknown: Boolean(data?.submission_unknown),
    detail: data?.detail || fallback.detail,
    recovery: data?.recovery || fallback.recovery,
    upstream_error: data?.upstream_error,
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
  const [classicWorkspace] = useState(() => new URLSearchParams(window.location.search).get("workspace") === "classic");
  const [studioArea, setStudioArea] = useState(() => new URLSearchParams(window.location.search).get("area") === "tavern" ? "tavern" : "home");
  const [tavernBackgroundTarget, setTavernBackgroundTarget] = useState(null);
  const [tavernBackgroundImports, setTavernBackgroundImports] = useState([]);
  const [mode, setMode] = useState("create");
  const [prompt, setPrompt] = useState(DEFAULT_PRESET?.prompt || "");
  const [activePreset, setActivePreset] = useState(DEFAULT_PRESET);
  const [size, setSize] = useState("");
  const [platformModel, setPlatformModel] = useState(DEFAULT_PLATFORM_MODEL);
  const [imageResolution, setImageResolution] = useState("1K");
  const [imageOutputFormat, setImageOutputFormat] = useState("png");
  const [apimartConfigured, setApimartConfigured] = useState(false);
  const [buytokenConfigured, setBuytokenConfigured] = useState(false);
  const [customSize, setCustomSize] = useState({ width: "1024", height: "1024" });
  const [count, setCount] = useState(1);
  const [referenceFiles, setReferenceFiles] = useState([]);
  const referenceFilesRef = useRef([]);
  const [referenceFeedback, setReferenceFeedback] = useState(null);

  const [images, setImages] = useState([]);
  const [currentPrompt, setCurrentPrompt] = useState("");
  const selectedTaskRef = useRef("");
  const [musicActiveCount, setMusicActiveCount] = useState(0);
  const [videoActiveCount, setVideoActiveCount] = useState(0);
  const [videoHistoryRestore, setVideoHistoryRestore] = useState(null);
  const [musicHistoryRestore, setMusicHistoryRestore] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [downloadError, setDownloadError] = useState(null);
  const [downloadingImages, setDownloadingImages] = useState(new Set());
  const downloadingImagesRef = useRef(new Set());
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");

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
  const imageTaskStore = useMemo(() => createImageTaskStore(IMAGE_TASK_LIMIT, session?.user?.id || "guest"), [session?.user?.id]);
  const imageTaskStoreRef = useRef(imageTaskStore);
  imageTaskStoreRef.current = imageTaskStore;
  const imageTasks = useSyncExternalStore(imageTaskStore.subscribe, imageTaskStore.getSnapshot);
  const imageActiveCount = imageTasks.filter(task => task.active).length;
  const isGenerating = Boolean(imageTasks.find(task => task.id === selectedTaskRef.current)?.active);
  useEffect(() => {
    selectedTaskRef.current = "";
    setImages([]); setCurrentPrompt(""); setError(null); setSelectedImages(new Set());
    setTavernBackgroundTarget(null); setTavernBackgroundImports([]);
  }, [imageTaskStore]);

  const accountRequestRef = useRef(0);
  const [authOpen, setAuthOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [imageTasksOpen, setImageTasksOpen] = useState(false);
  const [imageTasksLoading, setImageTasksLoading] = useState(false);
  const [imageTasksWarning, setImageTasksWarning] = useState('');
  const imageQueries = useRef(new Set());
  const closeImageTasks = useCallback(()=>setImageTasksOpen(false),[]);
  const [communityOpen, setCommunityOpen] = useState(false);

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

  useEffect(() => { clearImageUrlCache(); }, [session?.user?.id]);

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
  const selectedCount = selectedImages.size;
  const hasBrowserProvider = isProviderConfigComplete(providerConfig);
  const activeImageModel = billingMode === "platform" ? platformModel : providerConfig.model;
  const canvasAllowed = canvasEditCapability(activeImageModel).kind !== "disabled";
  const canvasAllowedRef = useRef(canvasAllowed);
  canvasAllowedRef.current = canvasAllowed;
  const apimartSpec = imageResolutionSpec(activeImageModel);
  const routedImageSpec = apimartImageModel(activeImageModel);
  const imagePriceResolution = size === "custom" && ["seedream-5-5", "seedream-5-0-pro"].includes(activeImageModel)
    ? Number(customSize.width) * Number(customSize.height) > 2601124 ? "2K" : "1K" : imageResolution;
  const routedImageConfigured = activeImageModel?.startsWith("gpt-image-2.6-") ? buytokenConfigured : apimartConfigured;
  const gifMode = apimartSpec?.outputFormats?.includes("gif") && imageOutputFormat === "gif";
  const referenceSpec = referenceCapability(gifMode && !apimartSpec.gifReferences ? {...apimartSpec, maxReferences: 0} : apimartSpec);
  const materialReferenceSpec = useRef(referenceSpec);
  materialReferenceSpec.current = referenceSpec;
  const platformReady = Boolean((apimartImageModel(activeImageModel) ? routedImageConfigured : serverProvider.platformConfigured) && session);
  const providerConfigured = billingMode === "platform" ? platformReady : hasBrowserProvider;
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/apimart-images/config", { headers: CLIENT_HEADERS, signal: controller.signal })
      .then(response => response.json()).then(data => { if (!controller.signal.aborted) setApimartConfigured(Boolean(data.platform_configured)); }).catch(() => {});
    fetch("/api/buytoken-images/config", { headers: CLIENT_HEADERS, signal: controller.signal })
      .then(response => response.json()).then(data => { if (!controller.signal.aborted) setBuytokenConfigured(Boolean(data.platform_configured)); }).catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!apimartSpec?.outputFormats?.includes("gif")) setImageOutputFormat("png");
    if (mode === "iterative" && gifMode) setImageOutputFormat("png");
    if (gifMode) setSize("");
  }, [apimartSpec, gifMode, mode]);
  useEffect(() => {
    if (!apimartSpec) return;
    setCount(previous => apimartSpec.value.startsWith('gpt-image-2.6-') ? 1 : Math.min(previous, apimartSpec.maxCount));
    if (apimartSpec.value === "seedream-5-0-lite" || apimartSpec.customSize === false) setSize(previous => previous === "custom" ? "" : previous);
    if (!apimartSpec.automaticResolution) setImageResolution(apimartSpec.resolutions[0]);
  }, [apimartSpec]);
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
  const referenceUploadHeaders = useMemo(
    () => ({ ...authHeaders, "X-Billing-Mode": billingMode }),
    [authHeaders, billingMode],
  );

  const requireGenerationAccess = useCallback(() => {
    if (billingMode === "platform" && !session) {
      setAuthOpen(true);
      setNotice("请先登录，完成邮箱验证后即可领取注册赠送积分");
      return false;
    }
    if (billingMode === "platform" && !(routedImageSpec ? routedImageConfigured : serverProvider.platformConfigured)) {
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
  }, [routedImageSpec, routedImageConfigured, billingMode, hasBrowserProvider, serverProvider.configured, serverProvider.platformConfigured, session]);

  const handleAddToCanvas = useCallback((filenames) => {
    if (!canvasAllowedRef.current) { setNotice("当前模型未开放无限画布，请先切换模型。"); return; }
    const uniqueFilenames = [...new Set(filenames.filter(Boolean))];
    if (!uniqueFilenames.length) return;
    setPendingCanvasImport({
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      filenames: uniqueFilenames,
    });
    setSelectedImages(new Set());
    setStudioArea("image");
    setMode("canvas");
    setNotice(`正在送入画布：${uniqueFilenames.length} 张图片`);
  }, []);

  const handleCanvasGenerated = useCallback(({ image, prompt: generatedPrompt }) => {
    setImages([image]);
    setCurrentPrompt(generatedPrompt);
  }, []);

  const handleReferenceAdd = useCallback((files) => {
    if (!files.length || referenceSpec.disabled) return;
    const result = appendReferenceFiles(referenceFilesRef.current, files, referenceSpec.limit);
    referenceFilesRef.current = result.files;
    setReferenceFiles(result.files);
    const messages = [];
    if (result.added) messages.push(`已添加 ${result.added} 张参考图`);
    if (result.duplicates) messages.push(`已跳过 ${result.duplicates} 张重复图片`);
    if (result.oversized) messages.push(`${result.oversized} 张超过 16 MB，未添加`);
    if (result.unsupported) messages.push(`${result.unsupported} 张格式不支持或无法识别，请使用 PNG、JPG、WebP 或 GIF`);
    if (result.overflow) messages.push(`最多保留 ${MAX_REFERENCE_IMAGES} 张，另外 ${result.overflow} 张未添加`);
    setReferenceFeedback({ text: messages.join("；"), warning: Boolean(result.oversized || result.unsupported || result.overflow) });
  }, [referenceSpec.disabled, referenceSpec.limit]);

  const handleReferenceRemove = useCallback((index) => {
    const current = referenceFilesRef.current;
    if (!Number.isInteger(index) || index < 0 || index >= current.length) return;
    const remaining = current.filter((_file, position) => position !== index);
    referenceFilesRef.current = remaining;
    setReferenceFiles(remaining);
    setPrompt(value => removeReferenceMentions(value, index, current.length));
    setReferenceFeedback({ text: `已删除图${index + 1}，剩余图片已重新编号，相关 @图 引用已同步更新。`, warning: false });
  }, []);

  const handleReferenceClear = useCallback(() => {
    const previousCount = referenceFilesRef.current.length;
    referenceFilesRef.current = [];
    setReferenceFiles([]);
    setPrompt(value => removeReferenceMentions(value, null, previousCount));
    setReferenceFeedback({ text: "已清空全部参考图及对应的 @图 引用。", warning: false });
  }, []);

  const handleApplyPreset = useCallback((preset) => {
    setTavernBackgroundTarget(null);
    setActivePreset(preset);
    setPrompt(preset.prompt);
    setNotice(`已载入预设：${preset.name}`);
  }, []);

  const queueTavernBackgrounds = useCallback((filenames, name = 'AI 生成背景', requestId = crypto.randomUUID(), identity = sessionRef.current?.user?.id || 'guest') => {
    if (identity !== (sessionRef.current?.user?.id || 'guest')) return;
    const cleanName = Array.from(name).filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('') || 'AI 生成背景';
    const items = filenames.filter(filename => typeof filename === 'string' && /^[a-zA-Z0-9_.-]{1,200}$/.test(filename))
      .map((filename, index) => ({ id: `${requestId}:${filename}`, identity, filename, name: `${cleanName}${filenames.length > 1 ? ` ${index + 1}` : ''}`.slice(0,80) }));
    setTavernBackgroundImports(previous => [...previous, ...items.filter(item => !previous.some(existing => existing.id === item.id))]);
  }, []);
  const handleBackgroundImportHandled = useCallback((id, result) => {
    setTavernBackgroundImports(previous => previous.filter(item => item.id !== id));
    setNotice(result.ok ? '图片已存入酒馆背景库，可返回酒馆切换使用。' : `背景入库未完成：${result.error} 生成原图仍在画廊，可稍后点击「存入酒馆背景库」重试，不需重新生图。`);
  }, []);
  const handleStartImage = useCallback((text, context) => {
    const identity = sessionRef.current?.user?.id || 'guest';
    const background = context?.target === 'tavern-background' && context.identity === identity;
    const tavernImage = context?.target === 'tavern-image' && context.identity === identity;
    setTavernBackgroundTarget(background ? { identity, name: context.name || 'AI 生成背景' } : null);
    if (text?.trim()) { setPrompt(text); setActivePreset(null); setMode('create'); }
    if (background || tavernImage) {
      referenceFilesRef.current = []; setReferenceFiles([]); setReferenceFeedback(null);
      setSize(tavernImage && context.size === 'portrait_3_4' ? 'portrait_3_4' : 'landscape_16_9'); setCount(1); setImageOutputFormat('png');
      setNotice(background ? '已填入剧情背景提示词；确认模型与价格后生成，成功图片自动存入酒馆背景库。' : '中文画面提示词已填入；确认模型、参考图与价格后再生成。');
    }
    setStudioArea('image');
  }, []);

  const importCompanion = useCallback(async (id, target) => {
    const owner = sessionRef.current?.user?.id || "guest";
    const file = typeof id === "string" ? await companionFile(id) : id;
    if (!(file instanceof File)) throw new Error("请选择有效的图片素材。");
    if (owner !== (sessionRef.current?.user?.id || "guest")) throw new Error("账户已切换，请重新选择素材。");
    setTavernBackgroundTarget(null);
    if (target === "reference") {
      const spec = materialReferenceSpec.current;
      if (spec.disabled) throw new Error("当前图片模型不支持参考图，请先到图像创作切换支持参考图的模型。");
      const result = appendReferenceFiles(referenceFilesRef.current, [file], spec.limit);
      if (result.overflow) throw new Error(`当前模型最多支持 ${spec.limit} 张参考图，请先移除部分图片。`);
      if (!result.added && !result.duplicates) throw new Error("素材未能加入参考图，请重试。");
      referenceFilesRef.current = result.files;setReferenceFiles(result.files);
      setReferenceFeedback({ text: result.duplicates ? "这张 AI娘图片已在参考图列表中。" : "已加入 AI娘参考图，可在提示词中使用 @图 引用。", warning: false });
      setMode("create");setStudioArea("image");setNotice("AI娘图片已加入参考图。");
    } else if (target === "canvas") {
      if (!canvasAllowedRef.current) throw new Error("当前模型未开放无限画布，请先切换模型。");
      setPendingCanvasImport({ id: crypto.randomUUID(), files: [file] });
      setStudioArea("image");setMode("canvas");setNotice("正在把 AI娘图片加入无限画布…");
    } else throw new Error("请选择参考图或无限画布。");
  }, []);

  const runImageTask = useCallback(async (taskPrompt, previousImage = null) => {
    if (!taskPrompt.trim() || Array.from(taskPrompt.trim()).length > 6000) {
      setError({ message: "提示词须为 1–6000 个字符", code: "PROMPT_INVALID" }); return;
    }
    if (!requireGenerationAccess()) return;
    if (!providerConfigured) { setShowProviderSettings(true); return; }
    if (gifMode && !apimartSpec?.gifReferences && referenceFiles.length) { setNotice("当前模型的 GIF 不支持参考图，请移除参考图或切回 PNG。"); return; }
    if (gifMode && previousImage) { setNotice("局部重绘请使用 PNG 输出格式。"); return; }
    if (previousImage && !canvasAllowedRef.current) { setNotice("当前模型未开放局部重绘，请使用参考图创作或切换模型。"); return; }
    if (previousImage && referenceSpec.disabled) {
      setNotice("当前模型仅支持文生图，请切换到 AI 创作或选择支持参考图的模型。"); return;
    }
    if (!referenceSpec.disabled && !previousImage && referenceFiles.length > referenceSpec.limit) {
      setNotice(`当前模型最多支持 ${referenceSpec.limit} 张参考图，请先移除多余素材。`); return;
    }
    const requestId = createRequestId(), store = imageTaskStore;
    const backgroundTarget = !previousImage && tavernBackgroundTarget?.identity === store.identity ? tavernBackgroundTarget : null;
    if (!store.start(requestId, { prompt: taskPrompt.trim(), model: activeImageModel, billingMode,
      route:routedImageSpec ? usesBuyToken(activeImageModel,providerHeaders)?'buytoken':'apimart' : 'legacy',
      backgroundName:backgroundTarget?.name })) {
      setNotice("已有 3 个生图任务正在运行，完成一个后可继续提交。"); return;
    }
    selectedTaskRef.current = requestId;
    setError(null); setNotice("任务已开始，可修改提示词继续提交，或切换到音乐创作。");
    setImages([]); setSelectedImages(new Set()); setCurrentPrompt(taskPrompt.trim());
    const live = () => imageTaskStoreRef.current === store && (sessionRef.current?.user?.id || 'guest') === store.identity;
    const selected = () => live() && selectedTaskRef.current === requestId;
    const show = data => {
      store.finish(requestId, { images: data.images || [], prompt: data.prompt || taskPrompt });
      if (selected()) { setImages(data.images || []); setCurrentPrompt(data.prompt || taskPrompt); setError(null); }
      if (live() && backgroundTarget && data.images?.length) queueTavernBackgrounds(data.images.map(image => image.filename), backgroundTarget.name, requestId, backgroundTarget.identity);
    };
    let paths = [], started = false;
    try {
      const body = { prompt: taskPrompt.trim(), request_id: requestId,
        ...(previousImage ? { previous_image: previousImage, ...(apimartSpec?.value.startsWith('gpt-image-2.6-') ? {count} : {}) } : { count }),
        ...(size ? { size } : {}),
        ...(size === "custom" ? { custom_width: customSize.width, custom_height: customSize.height } : {}),
        quality: "auto", ...(previousImage ? { canvas_workflow: "iterative" } : {}), ...(billingMode === "platform" ? { platform_model: platformModel } : {}),
        ...(apimartSpec && !apimartSpec.automaticResolution ? { resolution: imageResolution } : {}),
        ...(apimartSpec?.outputFormats ? {output_format: imageOutputFormat} : {}) };
      if (!previousImage && !referenceSpec.disabled && referenceFiles.length) {
        paths = await uploadReferenceFiles(referenceFiles, { headers: referenceUploadHeaders });
        body.reference_storage_paths = paths;
      }
      // A removed file/config change affects only the next task; this closure
      // retains this submission's complete parameters and credential headers.
      if (!live()) { store.finish(requestId, { error: { message: "登录身份已变化，尚未提交生成。" } }); return; }
      started = true;
      if (!session?.user?.id) rememberGuestPrompt(body.prompt, requestId);
      const response = await imageGenerationFetch(`${API_BASE}/${previousImage ? "modify" : "generate"}`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Request-Id": requestId, ...providerHeaders },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || data.error) {
        const pending = Boolean(routedImageSpec && !data.job?.status?.match(/^(failed|completed)$/) && (data.submission_unknown || /UNKNOWN|PENDING|QUERY|UNCERTAIN|TIMEOUT|CONNECTION_FAILED/.test(data.code || "")));
        const failure = { ...normalizeApiError(data), billing_mode: billingMode, submission_unknown:pending || Boolean(data.submission_unknown) };
        store.finish(requestId, { error: failure, pending });
        if (selected()) setError(failure);
      } else show(data);
    } catch (reason) {
      // Existing synchronous models have their original GET-only recovery.
      const recovered = started && billingMode === "platform" && !routedImageSpec
        ? await recoverGeneration(requestId, { headers: authHeaders }).catch(() => null) : null;
      if (recovered?.images?.length) show(recovered);
      else {
        const failure = { message: reason?.code?.startsWith("REFERENCE_") ? "参考图上传失败" : "生成请求暂未完成",
          code: reason?.code || "BACKEND_OFFLINE", billing_mode: billingMode, submission_unknown:started,
          detail: reason?.detail || reason?.message || "请查询原任务状态，避免重复提交。" };
        store.finish(requestId, { error: failure, pending: started });
        if (selected()) setError(failure);
      }
    } finally {
      if (live()) await refreshAccount();
      await cleanupReferencePaths(paths, referenceUploadHeaders);
    }
  }, [activeImageModel, apimartSpec, routedImageSpec, authHeaders, billingMode, count, customSize.height, customSize.width,
    imageResolution, imageOutputFormat, gifMode, imageTaskStore, platformModel, providerConfigured, providerHeaders, referenceFiles,
    referenceSpec.disabled, referenceSpec.limit, referenceUploadHeaders, refreshAccount, requireGenerationAccess, session?.user?.id, size, tavernBackgroundTarget, queueTavernBackgrounds]);

  const handleGenerate = useCallback(() => runImageTask(prompt,
    mode === "iterative" && images.length ? images[0].filename : null), [runImageTask, prompt, mode, images]);
  const handleModify = useCallback((text, previousImage) => runImageTask(text, previousImage), [runImageTask]);
  const viewImageTask = useCallback(task => {
    selectedTaskRef.current = task.id;
    setImages(task.images || []); setCurrentPrompt(task.prompt); setError(task.error || null);
    setSelectedImages(new Set()); setMode('create'); setStudioArea("image"); setImageTasksOpen(false);
  }, []);

  const syncImageTasks = useCallback(async signal => {
    const store=imageTaskStore;
    const live=()=>!signal?.aborted && imageTaskStoreRef.current===store && (sessionRef.current?.user?.id||'guest')===store.identity;
    if(!session?.user?.id){setImageTasksWarning('登录后可同步本人平台任务；当前仅显示本机记录。');return;}
    setImageTasksLoading(true);setImageTasksWarning('');
    try {
      const data=await listImageTasks({...authHeaders,'X-Billing-Mode':'platform'},signal);
      if(!live())return;
      store.importJobs(data.jobs);
      if(data.unavailable)setImageTasksWarning('部分任务暂未同步，请稍后刷新；已有记录仍可查询。');
    } finally {if(live())setImageTasksLoading(false);}
  },[imageTaskStore,session?.user?.id,authHeaders]);

  useEffect(()=>{
    const controller=new AbortController();
    setImageTasksLoading(false);setImageTasksWarning('');
    void syncImageTasks(controller.signal);
    return()=>controller.abort();
  },[syncImageTasks]);

  const queryImageTask = useCallback(async task => {
    const store=imageTaskStore, key=store.identity+':'+task.id;
    if(task.active || imageQueries.current.has(key))return;
    const live=()=>imageTaskStoreRef.current===store && (sessionRef.current?.user?.id||'guest')===store.identity;
    let headers={...authHeaders,'X-Billing-Mode':'platform'};
    if(task.billingMode==='own_key'){
      if(billingMode!=='own_key' || !providerConfigured || providerConfig.model!==task.model){setNotice('请先在图片服务配置中填写原任务使用的模型和 API Key，再查询原任务。');setImageTasksOpen(false);setShowProviderSettings(true);return;}
      headers=providerHeaders;
    }
    imageQueries.current.add(key);
    const announce=message=>{setNotice(message);setImageTasksWarning(message);};
    try {
      const data=task.route==='legacy' ? await recoverGeneration(task.id,{headers,attempts:1})
        : await readImageTask(task.id,headers,undefined,task.model,task.route);
      if(!live())return;
      if((data?.job?.status==='completed' || data?.status==='succeeded') && data?.images?.length){
        store.finish(task.id,{images:data.images,prompt:task.prompt});
        if(selectedTaskRef.current===task.id){setImages(data.images);setError(null);}
        if(task.backgroundName)queueTavernBackgrounds(data.images.map(image=>image.filename),task.backgroundName,task.id,store.identity);
        announce('已找回原任务图片，可点击“查看结果”并下载；没有重新生图。');
      }else if(data?.job?.status==='failed'){
        const failure={message:data.job.failure_reason||'原任务未完成，预留积分已按实际结果处理。',code:data.job.error_code,billing_mode:task.billingMode};
        store.finish(task.id,{error:failure});if(selectedTaskRef.current===task.id)setError(failure);
        announce(failure.message);
      }else announce(data?.job?.status==='submission_unknown'?task.billingMode==='platform'?'原请求尚无图片返回，需要管理员核对服务商记录；预留积分保持不变，请勿重复生成。':'原请求尚无图片返回，请核对服务商记录；自带 Key 不扣平台积分，请勿重复生成。':'原任务暂未完成，可稍后查询；不会重新生图。');
      await refreshAccount();
    }catch{if(live())announce('原任务暂时无法查询，请稍后再试，不要重复生成。');}
    finally{imageQueries.current.delete(key);}
  },[imageTaskStore,authHeaders,billingMode,providerConfigured,providerConfig.model,providerHeaders,queueTavernBackgrounds,refreshAccount]);

  const handleSaveProvider = useCallback((nextConfig) => {
    saveProviderConfig(nextConfig);
    setProviderConfig(nextConfig);
    setShowProviderSettings(false);
    setError(null);
    setNotice("图片服务配置已保存到当前标签页");
  }, []);

  const handleImageModelChange = useCallback((model) => {
    if (billingMode === "platform") {
      setPlatformModel(model);
      return;
    }
    const nextConfig = { ...providerConfig, model };
    saveProviderConfig(nextConfig);
    setProviderConfig(nextConfig);
  }, [billingMode, providerConfig]);

  const handleClearProvider = useCallback(() => {
    clearProviderConfig();
    setProviderConfig(loadProviderConfig());
    setError(null);
    setNotice(serverProvider.configured ? "已切换为服务器默认配置" : "个人服务配置已清除");
  }, [serverProvider.configured]);

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

  const handleDownloadImage = useCallback(async (filename) => {
    if (downloadingImagesRef.current.has(filename)) return;
    downloadingImagesRef.current.add(filename);
    setDownloadingImages(new Set(downloadingImagesRef.current));
    setDownloadError(null);
    setNotice("正在读取原图，请稍候…");
    try {
      const result = await downloadImage(filename, { authenticated: Boolean(session), headers: authHeaders });
      setNotice(result === "cancelled" ? "已取消保存" : result === "saved" ? "原图已保存" : "已请求浏览器下载原图；若被迅雷接管，请关闭接管后重试。");
    } catch (reason) {
      setDownloadError({ message: "原图下载未完成", detail: reason?.message || "浏览器没有完成原图读取。", filenames: [filename], kind: "image" });
      setNotice("原图下载未完成，可点击图片下方或预览顶部的“备用下载”。");
    } finally {
      downloadingImagesRef.current.delete(filename);
      setDownloadingImages(new Set(downloadingImagesRef.current));
    }
  }, [authHeaders, session]);

  const handleDownloadBatch = useCallback(async () => {
    if (selectedImages.size === 0 || isExporting) return;
    const filenames = [...selectedImages];
    setIsExporting(true);
    setDownloadError(null);
    try {
      setNotice("正在读取原图，完成后将打包下载");
      const result = await saveBrowserFile("ai-poster-export.zip", () => createImageArchive(filenames, {
        authenticated: Boolean(session),
        headers: authHeaders,
        onProgress: (done, total) => setNotice(`已读取 ${done} / ${total} 张图片${done < total ? "，正在读取下一张…" : "，正在打包…"}`),
      }));
      setNotice(result === "cancelled" ? "已取消保存" : result === "saved" ? "ZIP 已保存" : "已请求浏览器下载 ZIP；若被迅雷接管，请关闭接管后重试。");
    } catch (reason) {
      setDownloadError({
        message: "批量下载未完成",
        detail: reason?.message || "浏览器没有完成图片读取或打包，请稍后重试。",
        filenames,
        kind: "batch",
      });
      setNotice("批量下载未完成，图片仍保留在画廊，可使用每张图片下的“备用下载”。");
    } finally {
      setIsExporting(false);
    }
  }, [authHeaders, isExporting, selectedImages, session]);

  const handleSignOut = useCallback(async () => {
    await supabase?.auth.signOut({ scope: "local" });
    await fetch(API_BASE + "/auth/session", { method: "DELETE", headers: CLIENT_HEADERS, credentials: "include" });
    sessionRef.current = null; accountRequestRef.current += 1;
    setSession(null); setAccount(null); setAccountLoading(false); setAccountOpen(false); setNotice("已退出登录");
  }, []);

  const handleDeleteAccount = useCallback(async () => {
    const response = await fetch(API_BASE + "/account", { method: "DELETE", headers: authHeaders, credentials: "include" });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.detail || data.error || "删除账号失败");
    await supabase?.auth.signOut({ scope: "local" }); sessionRef.current = null; accountRequestRef.current += 1;
    setSession(null); setAccount(null); setAccountLoading(false); setAccountOpen(false); setNotice("账号已删除");
  }, [authHeaders]);

  useEffect(() => {
    const handler = (e) => {
      if ((classicWorkspace || studioArea === "image") && mode !== "canvas" && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleGenerate();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleGenerate, mode, classicWorkspace, studioArea]);

  return (
    <div className={`min-h-dvh bg-bg-primary text-text-primary lg:h-dvh lg:overflow-hidden ${classicWorkspace ? "subtle-grid" : "studio-app"}`}>
      <div className="flex min-h-dvh flex-col lg:h-dvh lg:flex-row">
        {classicWorkspace ? <Sidebar
          mode={mode}
          modes={MODE_META}
          onModeChange={(value) => { if (value === "create" || canvasAllowed) setMode(value); else setNotice("当前模型未开放局部重绘与无限画布。"); }}
          disabledModes={canvasAllowed ? [] : ["canvas", "iterative"]}
          providerConfigured={providerConfigured}
          providerName={providerName}
          onOpenProvider={() => setShowProviderSettings(true)}
          session={session}
          account={account}
          isAdmin={Boolean(account?.is_admin)}
          accountLoading={accountLoading}
          onOpenAuth={() => setAuthOpen(true)}
          onOpenAccount={() => setAccountOpen(true)}
          onOpenRecharge={() => setRechargeOpen(true)}
          onOpenMetrics={() => setMetricsOpen(true)}
          onOpenHistory={() => setHistoryOpen(true)}
          onOpenImageTasks={() => setImageTasksOpen(true)}
          onOpenCommunity={() => setCommunityOpen(true)}
        /> : <StudioNavigation
          area={studioArea}
          onAreaChange={setStudioArea}
          session={session}
          account={account}
          accountLoading={accountLoading}
          onOpenAuth={() => setAuthOpen(true)}
          onOpenAccount={() => setAccountOpen(true)}
          onOpenRecharge={() => setRechargeOpen(true)}
          onOpenMetrics={() => setMetricsOpen(true)}
          onOpenHistory={() => setHistoryOpen(true)}
          onOpenImageTasks={() => setImageTasksOpen(true)}
          onOpenCommunity={() => setCommunityOpen(true)}
          onOpenProvider={() => setShowProviderSettings(true)}
        />}

        <main className="flex min-w-0 flex-1 flex-col">
          <AnnouncementBanner />
          {(imageActiveCount > 0 || musicActiveCount > 0 || videoActiveCount > 0) && <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-accent/20 bg-accent/8 px-4 py-2 text-xs text-text-secondary" role="status">
            <Activity size={14} className="text-accent" />任务进行中
            <button type="button" className="min-h-7 text-accent" onClick={() => setStudioArea("image")}>图像 {imageActiveCount}</button>
            {!classicWorkspace && <button type="button" className="min-h-7 text-accent" onClick={() => setStudioArea("music")}>音乐 {musicActiveCount}</button>}
            {!classicWorkspace && <button type="button" className="min-h-7 text-accent" onClick={() => setStudioArea("video")}>视频 {videoActiveCount}</button>}
            <span className="text-text-muted">可以切换工作区继续创作</span>
          </div>}
          <div className={`studio-image-workspace ${classicWorkspace || studioArea === "image" ? "" : "studio-is-hidden"}`}>
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

              <div role="group" aria-label="图像工作区操作" className="image-workspace-actions grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
                {!classicWorkspace && Object.entries(MODE_META).map(([key, item]) => (
                  <button
                    type="button"
                    key={key}
                    disabled={key !== "create" && !canvasAllowed}
                    title={key !== "create" && !canvasAllowed ? "当前模型未开放局部重绘与无限画布" : undefined}
                    onClick={() => setMode(key)}
                    aria-pressed={mode === key}
                    className={`flex min-h-11 min-w-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border px-3 text-sm transition ${
                      mode === key
                        ? "border-accent bg-accent text-white hover:bg-accent-hover"
                        : "border-border-default bg-bg-secondary text-text-secondary hover:bg-bg-elevated"
                    }`}
                  >
                    <item.icon size={16} />{item.label}
                  </button>
                ))}
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
                  authHeaders={authHeaders}
                  providerHeaders={providerHeaders}
                  referenceUploadHeaders={referenceUploadHeaders}
                  billingMode={billingMode}
                  platformModel={platformModel}
                  imageModel={activeImageModel}
                  onImageModelChange={handleImageModelChange}
                  imageResolution={imageResolution}
                  onImageResolutionChange={setImageResolution}
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
              {tavernBackgroundTarget && <div className="rounded-lg border border-accent/35 bg-accent/5 p-4" role="region" aria-label="酒馆背景创作"><p className="text-sm font-semibold text-text-primary">为故事生成一处风景</p><p className="mt-2 text-xs leading-6 text-text-secondary">已带入当前剧情。可修改提示词、模型和参数，生成按当前生图价格收费；成功图片自动存入你的酒馆背景库。失败入库可从画廊重试，无需再次生成。</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => setStudioArea('tavern')} className="min-h-11 rounded-md border border-accent/40 px-3 text-xs text-accent">返回 AI 酒馆</button><button type="button" onClick={() => setTavernBackgroundTarget(null)} className="min-h-11 rounded-md px-3 text-xs text-text-muted">结束背景创作</button></div></div>}
              {classicWorkspace && <PresetLibrary activePresetId={activePreset?.id} onApplyPreset={handleApplyPreset} />}
              <PromptEditor
                imageModel={activeImageModel}
                imageResolution={imagePriceResolution}
                imageReferenceCount={referenceFiles.length || (mode === "iterative" && images.length ? 1 : 0)}
                onImageModelChange={handleImageModelChange}
                billingMode={billingMode}
                prompt={prompt}
                onPromptChange={setPrompt}
                onGenerate={handleGenerate}
                onOpenProvider={() => setShowProviderSettings(true)}
                isGenerating={false}
                generationLimitReached={imageActiveCount >= IMAGE_TASK_LIMIT}
                activeTaskCount={imageActiveCount}
                referenceLimit={referenceSpec.limit}
                currentPrompt={currentPrompt}
                referenceFiles={referenceFiles}
                onReferenceAdd={handleReferenceAdd}
                onReferenceRemove={handleReferenceRemove}
                onReferenceClear={handleReferenceClear}
                referenceFeedback={referenceFeedback}
                mode={mode}
                onCopyPrompt={handleCopyPrompt}
                providerConfigured={providerConfigured}
                presetName={activePreset?.name}
                presetCategory={activePreset?.category}
                authenticated={Boolean(session)}
                authHeaders={authHeaders}
                hasPreviousImage={images.length > 0}
              />
              <ParameterPanel
                billingMode={billingMode}
                apimartSpec={apimartSpec}
                resolution={imageResolution}
                outputFormat={imageOutputFormat}
                referenceCount={mode === "iterative" && images.length ? 1 : referenceFiles.length}
                onOutputFormatChange={setImageOutputFormat}
                onResolutionChange={setImageResolution}
                size={size}
                onSizeChange={setSize}
                customSize={customSize}
                onCustomSizeChange={setCustomSize}
                count={count}
                onCountChange={setCount}
                sizes={stylesData.sizes}
                mode={mode}
              />
            </section>

            <section className="flex min-h-[620px] min-w-0 flex-col gap-3 lg:min-h-0">
              <Gallery
                onSaveTavernBackground={classicWorkspace ? undefined : filename => queueTavernBackgrounds([filename])}
                tavernBackgroundImports={tavernBackgroundImports}
                billingMode={billingMode}
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
                onDownloadImage={handleDownloadImage}
                isExporting={isExporting}
                downloadingImages={downloadingImages}
                downloadError={downloadError}
                onDismissDownloadError={() => setDownloadError(null)}
                onAddToCanvas={handleAddToCanvas}
                onCopyPrompt={handleCopyPrompt}
                onRetry={handleGenerate}
                onQueryTask={() => {const task=imageTasks.find(item=>item.id===selectedTaskRef.current);if(task)return queryImageTask(task);setImageTasksOpen(true);}}
                providerModel={hasBrowserProvider ? providerConfig.model : "服务器默认模型"}
                presetName={activePreset?.name}
                presetCategory={activePreset?.category}
                authenticated={Boolean(session)}
                authHeaders={authHeaders}
              />
              <ImageTaskQueue key={imageTaskStore.identity} tasks={imageTasks} onView={viewImageTask} onQuery={queryImageTask} />
            </section>
          </div>
          </div>
          {!classicWorkspace && <div className={`studio-workspace-host ${studioArea === "image" ? "studio-is-hidden" : ""}`}>
            <Suspense fallback={<div className="flex flex-1 items-center justify-center p-16 text-text-muted">正在打开创作空间…</div>}>
              <StudioWorkspace key={session?.user?.id || "guest"} area={studioArea} onAreaChange={setStudioArea} username={account?.profile?.username} identity={session?.user?.id || "guest"} authHeaders={authHeaders} session={session} account={account} accountLoading={accountLoading} onLogin={() => setAuthOpen(true)} onAccountRefresh={refreshAccount} onTaskActivity={setMusicActiveCount} onVideoTaskActivity={setVideoActiveCount} musicHistoryRestore={musicHistoryRestore} videoHistoryRestore={videoHistoryRestore} onImportCompanion={importCompanion} presetLibrary={<PresetLibrary activePresetId={activePreset?.id} onApplyPreset={preset => { handleApplyPreset(preset); setMode("create"); setStudioArea("image"); }} />} onStartImage={handleStartImage} backgroundImport={tavernBackgroundImports[0]} onBackgroundImportHandled={handleBackgroundImportHandled} />
            </Suspense>
          </div>}
        </main>

      </div>

      {previewImage && (
        <ImageModal
          key={previewImage}
          onDownloadImage={handleDownloadImage}
          filename={previewImage}
          isDownloading={downloadingImages.has(previewImage)}
          onClose={() => setPreviewImage(null)}
          onModify={mode === "iterative" ? handleModify : null}
          authenticated={Boolean(session)}
          authHeaders={authHeaders}
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
        platformModel={platformModel}
        onPlatformModelChange={setPlatformModel}
        platformReady={platformReady}
        session={session}
        account={account}
        onClose={() => setShowProviderSettings(false)}
      />

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} onNotice={setNotice} />
      <CommunityQrModal open={communityOpen} onClose={() => setCommunityOpen(false)} />
      <AccountPanel open={accountOpen} account={account} loading={accountLoading} onClose={() => setAccountOpen(false)} onSignOut={handleSignOut} onDelete={handleDeleteAccount} onOpenRecharge={() => { setAccountOpen(false); setRechargeOpen(true); }} />
      <AdminMetricsPanel open={metricsOpen} authHeaders={authHeaders} onClose={() => setMetricsOpen(false)} />
      <RechargePanel key={`recharge:${session?.user?.id || "guest"}`} open={rechargeOpen} onClose={() => setRechargeOpen(false)} session={session} account={account} authHeaders={authHeaders} onLogin={() => {setRechargeOpen(false);setAuthOpen(true);}} onAccountRefresh={refreshAccount} />
      <PromptHistoryPanel key={session?.user?.id || "guest"} open={historyOpen} onOpenImageTasks={() => {setHistoryOpen(false);setImageTasksOpen(true);}} userId={session?.user?.id} authHeaders={authHeaders} onClose={() => setHistoryOpen(false)} onUsePrompt={(value, item) => { if (item?.kind === "video") { setVideoHistoryRestore({ id: createRequestId(), identity: session?.user?.id || "guest", entry: item }); setStudioArea("video"); } else if (item?.kind === "music") { setMusicHistoryRestore({ id: createRequestId(), identity: session?.user?.id || "guest", entry: item }); setStudioArea("music"); } else { setPrompt(value); setActivePreset(null); setMode("create"); setStudioArea("image"); } setHistoryOpen(false); setNotice("历史提示词已填入，请核对模型与参数后生成"); }} />

      <ImageTasksPanel key={imageTaskStore.identity} open={imageTasksOpen} tasks={imageTasks} loading={imageTasksLoading} warning={imageTasksWarning} onClose={closeImageTasks} onRefresh={() => void syncImageTasks()} onView={viewImageTask} onQuery={queryImageTask} />

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

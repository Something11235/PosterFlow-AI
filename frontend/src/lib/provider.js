export const PROVIDER_STORAGE_KEY = "posterflow.provider.session.v1";
export const MAX_REFERENCE_IMAGES = 8;
export const GPT26_IMAGE_MODELS = ["flare", "sunburst"].map(version => ({ value: `gpt-image-2.6-${version}`, label: `GPT Image 2.6 ${version === "flare" ? "Flare" : "Sunburst"}`, upstreamVersion: version, outputFormats: ["png", "gif"], gifReferences: true, creditCost: 1, referenceCreditCost: 1.5, maxCount: 4, maxReferences: 8, resolutions: ["1K"], canvasEdit: true, maskEdit: true, customSize: false }));

export const APIMART_IMAGE_MODELS = [
  ...GPT26_IMAGE_MODELS,
  { value: "gemini-nano-banana-2.1", label: "Nano Banana 2.1", creditCost: 1, resolutionCreditCosts: { "4K": 2 }, maxCount: 1, maxReferences: 8, resolutions: ["1K", "2K", "4K"] },
  { value: "grok-imagine-image-2.0", label: "Grok Imagine Image 2.0", creditCost: 1, referenceCreditCost: 2, maxCount: 4, maxReferences: 3, automaticResolution: true, resolutions: ["1K", "2K"] },
  { value: "grok-imagine-2.0-ext", label: "Grok Imagine 2.0 Ext", creditCost: 1, maxCount: 4, maxReferences: 0, automaticResolution: true, resolutions: ["quality"] },
  { value: "seedream-5-0-pro", label: "（即梦）Seedream 5.0 Pro", creditCost: 2, maxCount: 1, maxReferences: 8, resolutions: ["1K", "1.5K", "2K"], canvasEdit: true, interactiveEdit: true },
  { value: "seedream-5-0-lite", label: "（即梦）Seedream 5.0 Lite", creditCost: 1, maxCount: 4, maxReferences: 8, resolutions: ["2K", "3K", "4K"], canvasEdit: false },
  { value: "seedream-5-0-flash", label: "（即梦）Seedream 5.0 Flash", creditCost: 0.5, maxCount: 1, maxReferences: 8, resolutions: ["1K", "1.5K", "2K"], canvasEdit: true, interactiveEdit: true },
];
export const apimartImageModel = model => APIMART_IMAGE_MODELS.find(item => item.value === model);

export const IMAGE_MODEL_OPTIONS = [
  ...GPT26_IMAGE_MODELS,
  { value: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare", creditCost: 1 },
  { value: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst", creditCost: 1 },
  ...APIMART_IMAGE_MODELS.filter(model => !model.value.startsWith("gpt-image-2.6-")),
];

export function imageCreditCost(model, referenceCount = 0, resolution = "") {
  const spec = IMAGE_MODEL_OPTIONS.find(option => option.value === model);
  const resolutionCost = spec?.resolutionCreditCosts?.[String(resolution).trim().toUpperCase()];
  if (resolutionCost != null) return resolutionCost;
  return referenceCount > 0 ? spec?.referenceCreditCost ?? spec?.creditCost ?? 1 : spec?.creditCost ?? 1;
}

export function imagePricingLabel(model) {
  const spec = IMAGE_MODEL_OPTIONS.find(option => option.value === model);
  if (spec?.resolutionCreditCosts) return `1K、2K ${imageCreditCost(model)} 积分 / 张，4K ${imageCreditCost(model, 0, "4K")} 积分 / 张`;
  return `${imageCreditCost(model)} 积分 / 张${spec?.referenceCreditCost ? `，使用参考图 ${imageCreditCost(model, 1)} 积分 / 张` : ""}`;
}

export const DEFAULT_PLATFORM_MODEL = IMAGE_MODEL_OPTIONS[0].value;

export const PROVIDER_PRESETS = {
  jojo: {
    id: "jojo",
    label: "JOJO Code",
    description: "JOJO Code 的 OpenAI 图片兼容接口",
    endpoint: "https://api2.jojocode.com/v1/images/generations",
    model: "gpt-image-2.5-flare",
    authType: "bearer",
  },
  micu: {
    id: "micu",
    label: "米醋 API",
    description: "使用米醋 API 的 OpenAI 图片兼容接口",
    endpoint: "https://www.micuapi.ai/v1/images/generations",
    model: "gpt-image-2.5-flare",
    authType: "bearer",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    description: "使用 OpenRouter 的 OpenAI 图片兼容接口",
    endpoint: "https://openrouter.ai/api/v1/images",
    model: "openai/gpt-image-2.5-flare",
    authType: "bearer",
  },
  custom: {
    id: "custom",
    label: "自定义中转站",
    description: "接入其他 OpenAI 兼容图片生成服务",
    endpoint: "",
    model: "",
    authType: "bearer",
  },
};

export const EMPTY_PROVIDER_CONFIG = {
  preset: "custom",
  endpoint: "",
  model: "",
  authType: "bearer",
  apiKey: "",
};

export function loadProviderConfig() {
  try {
    const stored = window.sessionStorage.getItem(PROVIDER_STORAGE_KEY);
    if (!stored) return EMPTY_PROVIDER_CONFIG;
    const parsed = JSON.parse(stored);
    const migrated = { ...EMPTY_PROVIDER_CONFIG, ...parsed };
    if (migrated.model === "gpt-image-2") migrated.model = "";
    if (migrated.preset === "openrouter") {
      const oldEndpoint = migrated.endpoint;
      const oldModel = migrated.model;
      if (migrated.endpoint === "https://openrouter.ai/api/v1/images/generations") {
        migrated.endpoint = PROVIDER_PRESETS.openrouter.endpoint;
      }
      if (migrated.model === "gpt-image-2.5-flare") {
        migrated.model = PROVIDER_PRESETS.openrouter.model;
      }
      if (migrated.endpoint !== oldEndpoint || migrated.model !== oldModel) {
        window.sessionStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(migrated));
      }
    }
    return migrated;
  } catch {
    return EMPTY_PROVIDER_CONFIG;
  }
}

export function saveProviderConfig(config) {
  window.sessionStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(config));
}

export function clearProviderConfig() {
  window.sessionStorage.removeItem(PROVIDER_STORAGE_KEY);
}

export function isProviderConfigComplete(config) {
  return Boolean(config?.apiKey?.trim() && config?.endpoint?.trim() && config?.model?.trim());
}

export function buildProviderHeaders(config) {
  if (!isProviderConfigComplete(config)) return {};
  return {
    "X-Provider-Api-Key": config.apiKey.trim(),
    "X-Provider-Endpoint": config.endpoint.trim(),
    "X-Provider-Model": config.model.trim(),
    "X-Provider-Auth-Type": config.authType || "bearer",
  };
}

export function getProviderDisplayName(config, serverHost = "") {
  if (isProviderConfigComplete(config)) {
    try {
      return new URL(config.endpoint).hostname;
    } catch {
      return "自定义中转站";
    }
  }
  return serverHost || "服务器图片服务";
}

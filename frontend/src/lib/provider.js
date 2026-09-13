export const PROVIDER_STORAGE_KEY = "posterflow.provider.session.v1";
export const MAX_REFERENCE_IMAGES = 8;

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
  preset: "jojo",
  endpoint: PROVIDER_PRESETS.jojo.endpoint,
  model: PROVIDER_PRESETS.jojo.model,
  authType: "bearer",
  apiKey: "",
};

export function loadProviderConfig() {
  try {
    const stored = window.sessionStorage.getItem(PROVIDER_STORAGE_KEY);
    if (!stored) return EMPTY_PROVIDER_CONFIG;
    const parsed = JSON.parse(stored);
    const migrated = { ...EMPTY_PROVIDER_CONFIG, ...parsed };
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
    if (config.preset === "jojo") return "JOJO Code";
    if (config.preset === "openrouter") return "OpenRouter";
    if (config.preset === "micu") return "米醋 API";
    try {
      return new URL(config.endpoint).hostname;
    } catch {
      return "自定义中转站";
    }
  }
  return serverHost || "未配置";
}

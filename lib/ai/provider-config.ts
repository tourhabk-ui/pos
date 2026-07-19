/**
 * AI Provider key configuration.
 * Centralized key access — all providers read keys through here.
 *
 * Server-side only (lib/), never exposed to client.
 */

export function getOpenRouterKey(): string | null {
  return process.env.OR_API_KEY
    || process.env.OPENROUTER_API_KEY
    || null;
}

/**
 * Какая env-переменная реально даёт ключ OpenRouter — для health-диагностики.
 * OR_API_KEY имеет приоритет: если в окружении остался старый OR_API_KEY,
 * замена OPENROUTER_API_KEY ничего не меняет — это надо видеть, а не гадать.
 */
export function getOpenRouterKeySource(): 'OR_API_KEY' | 'OPENROUTER_API_KEY' | null {
  if (process.env.OR_API_KEY) return 'OR_API_KEY';
  if (process.env.OPENROUTER_API_KEY) return 'OPENROUTER_API_KEY';
  return null;
}

export function getDeepSeekKey(): string | null {
  return process.env.DEEPSEEK_API_KEY || null;
}

export function getAnthropicKey(): string | null {
  return process.env.ANTHROPIC_API_KEY || null;
}

export function getXaiKey(): string | null {
  return process.env.XAI_API_KEY || null;
}

export function getGeminiKey(): string | null {
  return process.env.GEMINI_API_KEY || null;
}

export function getMiMoKey(): string | null {
  return process.env.XIAOMI_API_KEY || null;
}

export function getMiniMaxKey(): { apiKey: string; groupId: string } | null {
  const apiKey = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  if (!apiKey || !groupId) return null;
  return { apiKey, groupId };
}

// Meta Muse Spark — анонсирована 08.04.2026, API пока закрыт (select partners).
// Когда откроют — выставить MUSE_SPARK_API_KEY в Timeweb и модель активируется автоматически.
// Docs: https://about.fb.com/news/2026/04/introducing-muse-spark-meta-superintelligence-labs/
export function getMuseSparkKey(): string | null {
  return process.env.MUSE_SPARK_API_KEY || null;
}

export function getYandexKey(): { apiKey: string; folderId: string } | null {
  const apiKey = process.env.YANDEX_API_KEY;
  const folderId = process.env.YANDEX_FOLDER_ID;
  if (!apiKey || !folderId) return null;
  return { apiKey, folderId };
}

export function getGLMKey(): string | null {
  return process.env.GLM_API_KEY || null;
}

// NVIDIA NIM — бесплатный OpenAI-compatible API (100+ моделей: DeepSeek R1, Llama 3.3 и др.)
// Получить ключ: https://build.nvidia.com → Free tier → API Key
// Env: NVIDIA_API_KEY
export function getNvidiaKey(): string | null {
  return process.env.NVIDIA_API_KEY || null;
}

// Groq — бесплатный OpenAI-compatible API (Llama 3.3-70B и др., очень быстрый LPU).
// Лимит free-tier: ~14 400 запросов/день. Ключ: https://console.groq.com/keys
// Endpoint: https://api.groq.com/openai/v1/chat/completions
// GEO-оговорка: US-провайдер, может геоблокировать РФ-IP Timeweb — проверить
// достижимость через /api/ai/debug-waterfall перед тем как полагаться в гонке.
// Env: GROQ_API_KEY
export function getGroqKey(): string | null {
  return process.env.GROQ_API_KEY || null;
}

// Cerebras — бесплатный OpenAI-compatible API (Llama 3.3-70B, экстремально быстрый).
// Лимит free-tier: ~30 запросов/мин. Ключ: https://cloud.cerebras.ai
// Endpoint: https://api.cerebras.ai/v1/chat/completions
// GEO-оговорка: US-провайдер — см. комментарий к getGroqKey.
// Env: CEREBRAS_API_KEY
export function getCerebrasKey(): string | null {
  return process.env.CEREBRAS_API_KEY || null;
}

// Mistral La Plateforme — бесплатный OpenAI-compatible API (mistral-small и др.).
// Free-tier: ~500k токенов/мин (требует opt-in обучения на данных при регистрации).
// Ключ: https://console.mistral.ai/api-keys
// Endpoint: https://api.mistral.ai/v1/chat/completions
// GEO-оговорка: EU-провайдер — проверить достижимость с РФ-IP через debug-waterfall.
// Env: MISTRAL_API_KEY
export function getMistralKey(): string | null {
  return process.env.MISTRAL_API_KEY || null;
}

// Sakana AI Fugu Ultra — multilingual frontier model (Japanese/Asian focus).
// Docs: https://sakana.ai/fugu/
// Endpoint: https://api.sakana.ai/v1/chat/completions (OpenAI-compatible)
// Env: FUGU_API_KEY
export function getFuguKey(): string | null {
  return process.env.FUGU_API_KEY || null;
}

export function getMolmoWebConfig(): {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  mode: 'native' | 'openai';
  endpointPath: string;
} | null {
  const baseUrl = process.env.MOLMO_WEB_URL || process.env.MOLMOWEB_URL || '';
  if (!baseUrl) return null;

  const mode = (process.env.MOLMO_WEB_MODE || 'openai').toLowerCase() === 'native'
    ? 'native'
    : 'openai';
  const endpointPath = process.env.MOLMO_WEB_ENDPOINT
    || (mode === 'native' ? '/predict' : '/v1/chat/completions');

  return {
    baseUrl,
    apiKey: process.env.MOLMO_WEB_API_KEY || process.env.MOLMOWEB_API_KEY || null,
    model: process.env.MOLMO_WEB_MODEL || 'allenai/Molmo-7B-D-0924',
    mode,
    endpointPath,
  };
}

export function isMolmoPilotEnabled(): boolean {
  return process.env.MOLMO_PILOT_ENABLED === 'true';
}

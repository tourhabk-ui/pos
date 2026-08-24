/**
 * AI Provider key configuration.
 * Centralized key access — all providers read keys through here.
 *
 * Server-side only (lib/), never exposed to client.
 */

/**
 * Строка из одних пробелов — не ключ.
 *
 * 22.08 отчёт судьи назвал причину отказа первой ступени:
 * `HTTP 401 {"error":{"message":"Missing Authentication header","code":401}}`.
 * OpenRouter говорит, что заголовка авторизации НЕТ, — при том что ветка
 * «ключ не задан» не срабатывала, то есть переменная непустая. Обе вещи
 * сходятся ровно в одном случае: значение непусто как строка, но пусто как
 * ключ. `Bearer ` с пустым содержимым — заголовок формально есть, а
 * авторизации в нём нет.
 *
 * Отсюда правило: значение обрезается, и после обрезки пустое считается
 * отсутствующим. Это не косметика — это разница между «ключа нет» (лечится
 * за минуту) и «ключ есть, но не работает» (мы искали причину полдня в
 * релее, гео-блоке и Cloudflare).
 */
function envKey(name: string): string | null {
  const raw = process.env[name];
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getOpenRouterKey(): string | null {
  return envKey('OR_API_KEY') || envKey('OPENROUTER_API_KEY');
}

/**
 * Форма ключа БЕЗ его содержимого — для диагностики.
 *
 * Наружу уходят только длина, признак ожидаемого начала (`sk-or-`) и флаг
 * пробелов внутри. Ни одного символа самого ключа: ответ health читают в
 * логах Actions, и там ему не место. Этих трёх фактов хватает, чтобы
 * отличить «вставили не то» от «вставили с переводом строки» и от
 * «ключ настоящий, отказывает провайдер».
 */
export function describeOpenRouterKey(): {
  key_len: number;
  key_prefix_ok: boolean;
  key_had_outer_space: boolean;
  key_has_inner_space: boolean;
} | null {
  const raw = process.env.OR_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!raw) return null;
  const trimmed = raw.trim();
  return {
    key_len: trimmed.length,
    key_prefix_ok: trimmed.startsWith('sk-or-'),
    key_had_outer_space: trimmed.length !== raw.length,
    key_has_inner_space: /\s/.test(trimmed),
  };
}

/**
 * Какая env-переменная реально даёт ключ OpenRouter — для health-диагностики.
 * OR_API_KEY имеет приоритет: если в окружении остался старый OR_API_KEY,
 * замена OPENROUTER_API_KEY ничего не меняет — это надо видеть, а не гадать.
 */
export function getOpenRouterKeySource(): 'OR_API_KEY' | 'OPENROUTER_API_KEY' | null {
  // Судим по тому же правилу, что и выдача ключа: иначе диагностика скажет
  // «источник OPENROUTER_API_KEY», а вызов получит null — и это снова будут
  // два несогласных ответа об одном и том же.
  if (envKey('OR_API_KEY')) return 'OR_API_KEY';
  if (envKey('OPENROUTER_API_KEY')) return 'OPENROUTER_API_KEY';
  return null;
}

export function getDeepSeekKey(): string | null {
  return process.env.DEEPSEEK_API_KEY || null;
}

// Moonshot (Kimi) — китайский провайдер, достижим из РФ напрямую (как
// DeepSeek/Qwen), OpenAI-совместимый (api.moonshot.ai/v1). Третий живой
// решатель/судья на случай немоты DeepSeek+Qwen. Нет ключа → провайдер
// пропускается, поведение прежнее (подготовка 01.08, активирует владелец).
export function getMoonshotKey(): string | null {
  return process.env.MOONSHOT_API_KEY || null;
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

export interface TimewebAgent {
  agentId: string;
  token: string;
}

/**
 * Шлюз Timeweb к флагманам (Claude/GPT/Gemini/…) БЕЗ хопа за границей —
 * замер владельца 23.08 (CLAUDE.md §8). Наружу ходит инфраструктура
 * Timeweb, поэтому гео-блок Cloudflare (403 из РФ на прямой api.anthropic.com
 * и на некоторые OpenRouter-релеи) к этому пути не относится — это ДРУГОЙ
 * сетевой путь, не альтернативный ключ к тому же самому.
 *
 * У шлюза Timeweb модель — свойство АГЕНТА, не параметр запроса:
 * `POST https://agent.timeweb.cloud/api/v1/cloud-ai/agents/{agent_id}/v1/chat/completions`,
 * один агент = одна модель, `/v1/models` у шлюза нет. Поэтому вместо
 * авто-резолва (как у DeepSeek/Qwen, §8) — явная карта «имя модели → агент»,
 * которую владелец наполняет сам, создавая агентов в панели Timeweb.
 *
 * `TIMEWEB_AI_AGENTS` — JSON-объект:
 *   {"claude-opus-5": {"agentId": "...", "token": "..."}, "gpt-5.6": {...}}
 * Имя модели используется ТОЛЬКО для ранжирования (pickBestFlagship) — какой
 * из настроенных агентов сильнее; сам по себе шлюз имени не проверяет и не
 * использует. Не задан/не парсится → пустая карта, ступень решателя молча
 * пропускается (тот же fail-soft, что у остальных провайдеров без ключа).
 *
 * Формат заголовка авторизации у шлюза документацией Timeweb НЕ
 * зафиксирован дословно (только «токен доступа агента» без примера) — здесь
 * предположен `Authorization: Bearer <токен>` по конвенции OpenAI-совместимых
 * API, которой шлюз следует по пути `/v1/chat/completions`. Не проверено
 * вызовом: у песочницы нет сети до agent.timeweb.cloud. Проверяется
 * probeTimewebAgentStatus() на живом окружении — если формат неверен, ответ
 * будет 401, а не таймаут, и это будет видно сразу, а не через день гадания.
 */
export function getTimewebAgents(): Record<string, TimewebAgent> {
  const raw = process.env.TIMEWEB_AI_AGENTS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, TimewebAgent> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as { agentId?: unknown; token?: unknown };
      if (typeof v?.agentId === 'string' && v.agentId.trim() && typeof v?.token === 'string' && v.token.trim()) {
        out[name] = { agentId: v.agentId.trim(), token: v.token.trim() };
      }
    }
    return out;
  } catch {
    // Битый JSON в env — не повод падать сервису; ступень решателя просто
    // не активируется, как и при отсутствующей переменной.
    return {};
  }
}

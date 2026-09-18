/**
 * lib/ai/balances.ts — остаток денег у провайдеров ИИ, по запросу владельца 18.09.
 *
 * Баланс — свойство АККАУНТА провайдера, а не модели: у DeepSeek один счёт на
 * все его модели, у OpenRouter один на всех вендоров за ним. Поэтому здесь
 * баланс считается по провайдерам, а расход по моделям — рядом, в
 * `lib/ai/model-spend.ts` из нашего же `llm_usage_log`.
 *
 * Правило §4.0: у каждого провайдера обязан быть исход. Их четыре, и они не
 * равны друг другу:
 *   ok          — число получено от провайдера;
 *   no_key      — ключа нет, спрашивать нечем;
 *   unsupported — API провайдера баланс НЕ ОТДАЁТ; причина записана в
 *                 реестре, а не выведена из молчания;
 *   failed      — эндпоинт есть, но ответ не получен или не разобран.
 *
 * Реестр `BALANCE_SOURCES` обязан покрывать каждый ключ из
 * `lib/ai/provider-config.ts` — сторож `tests/unit/ai-money.test.ts`.
 * Новый провайдер без записи здесь — красный тест, а не «баланса нет».
 *
 * Отдают баланс по API ключа модели только двое: DeepSeek
 * (`GET /user/balance`) и OpenRouter (`/credits` или `/auth/key`, см.
 * `checkOpenRouterBalance`). У остальных остаток виден только в их консоли.
 */

import { getDeepSeekKey, getOpenRouterKey } from '@/lib/ai/provider-config';
import { checkOpenRouterBalance } from '@/lib/ai/providers';

export type BalanceStatus = 'ok' | 'no_key' | 'unsupported' | 'failed';

export interface ProviderBalance {
  id: string;
  label: string;
  status: BalanceStatus;
  /** Остаток в валюте `currency`; null при любом статусе, кроме ok. */
  amount: number | null;
  currency: string | null;
  /** Что именно известно: откуда число, почему его нет, где смотреть. */
  detail: string;
}

export interface BalanceSource {
  label: string;
  /** Имя геттера ключа в provider-config — связка со сторожем. */
  key_getter: string;
  kind: 'api' | 'unsupported';
  /** Для unsupported: почему API не отдаёт и где смотреть остаток. */
  reason?: string;
}

/**
 * Реестр: каждый провайдер платформы и то, умеет ли его API отдать баланс.
 * Причины записаны словами, чтобы «не отдаёт» отличалось от «не спросили».
 */
export const BALANCE_SOURCES: Record<string, BalanceSource> = {
  deepseek:   { label: 'DeepSeek',   key_getter: 'getDeepSeekKey',   kind: 'api' },
  openrouter: { label: 'OpenRouter', key_getter: 'getOpenRouterKey', kind: 'api' },

  anthropic: {
    label: 'Anthropic', key_getter: 'getAnthropicKey', kind: 'unsupported',
    reason: 'предоплаченный остаток организации API не отдаёт; смотреть в console.anthropic.com → Billing',
  },
  qwen: {
    label: 'Qwen (DashScope)', key_getter: 'getQwenConfig', kind: 'unsupported',
    reason: 'ключ Model Studio баланс не отдаёт, квоты считаются по моделям; смотреть в Bailian → Model Usage',
  },
  xai: {
    label: 'xAI (Grok)', key_getter: 'getXaiKey', kind: 'unsupported',
    reason: 'у ключа API эндпоинта баланса нет; смотреть в console.x.ai → Billing',
  },
  gemini: {
    label: 'Gemini', key_getter: 'getGeminiKey', kind: 'unsupported',
    reason: 'биллинг через Google Cloud, ключом API не читается; с прода провайдер и так гео-закрыт',
  },
  yandex: {
    label: 'YandexGPT', key_getter: 'getYandexKey', kind: 'unsupported',
    reason: 'остаток — в биллинге Yandex Cloud, ключом API не читается',
  },
  kimi: {
    label: 'Kimi (Moonshot)', key_getter: 'getMoonshotKey', kind: 'unsupported',
    reason: 'эндпоинта баланса у ключа API нет; смотреть в platform.moonshot.ai',
  },
  glm: {
    label: 'GLM (z.ai)', key_getter: 'getGLMKey', kind: 'unsupported',
    reason: 'прямой ключ баланса не отдаёт; флагман GLM идёт через OpenRouter — его остаток выше',
  },
  minimax: {
    label: 'MiniMax', key_getter: 'getMiniMaxKey', kind: 'unsupported',
    reason: 'эндпоинта баланса у ключа API нет',
  },
  mimo: {
    label: 'MiMo (Xiaomi)', key_getter: 'getMiMoKey', kind: 'unsupported',
    reason: 'эндпоинта баланса у ключа API нет',
  },
  musespark: {
    label: 'MuseSpark', key_getter: 'getMuseSparkKey', kind: 'unsupported',
    reason: 'эндпоинта баланса у ключа API нет',
  },
  nvidia: {
    label: 'NVIDIA NIM', key_getter: 'getNvidiaKey', kind: 'unsupported',
    reason: 'кредиты NIM ключом API не читаются; смотреть в build.nvidia.com',
  },
  groq: {
    label: 'Groq', key_getter: 'getGroqKey', kind: 'unsupported',
    reason: 'эндпоинта баланса у ключа API нет; смотреть в console.groq.com',
  },
  cerebras: {
    label: 'Cerebras', key_getter: 'getCerebrasKey', kind: 'unsupported',
    reason: 'эндпоинта баланса у ключа API нет',
  },
  mistral: {
    label: 'Mistral', key_getter: 'getMistralKey', kind: 'unsupported',
    reason: 'эндпоинта баланса у ключа API нет; смотреть в console.mistral.ai',
  },
  fugu: {
    label: 'Sakana Fugu', key_getter: 'getFuguKey', kind: 'unsupported',
    reason: 'эндпоинта баланса у ключа API нет',
  },
  timeweb: {
    label: 'Timeweb AI-агенты', key_getter: 'getTimewebAgents', kind: 'unsupported',
    reason: 'токен агента баланс не отдаёт; остаток аккаунта — в панели Timeweb, списание раз в час',
  },
};

/** Форма ответа `GET https://api.deepseek.com/user/balance`. */
interface DeepSeekBalanceBody {
  is_available?: unknown;
  balance_infos?: unknown;
}

/**
 * Разбор тела DeepSeek. Чистая функция — под сторож. Числа у DeepSeek приходят
 * СТРОКАМИ (`"total_balance": "110.00"`), поэтому Number() с проверкой на NaN:
 * нечисло — исход failed, а не 0.
 */
export function parseDeepSeekBalance(body: unknown): { amount: number; currency: string } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'тело ответа не объект' };
  const b = body as DeepSeekBalanceBody;
  if (!Array.isArray(b.balance_infos) || b.balance_infos.length === 0) {
    return { error: 'в ответе нет balance_infos' };
  }
  const first = b.balance_infos[0] as { currency?: unknown; total_balance?: unknown };
  const amount = Number(first.total_balance);
  if (typeof first.total_balance !== 'string' && typeof first.total_balance !== 'number') {
    return { error: 'в ответе нет total_balance' };
  }
  if (!Number.isFinite(amount)) return { error: `total_balance не число: ${String(first.total_balance)}` };
  const currency = typeof first.currency === 'string' && first.currency ? first.currency : 'USD';
  return { amount, currency };
}

async function fetchDeepSeekBalance(): Promise<ProviderBalance> {
  const base = { id: 'deepseek', label: BALANCE_SOURCES.deepseek.label };
  const key = getDeepSeekKey();
  if (!key) return { ...base, status: 'no_key', amount: null, currency: null, detail: 'DEEPSEEK_API_KEY не задан' };
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 160);
      return { ...base, status: 'failed', amount: null, currency: null, detail: `HTTP ${res.status}: ${text || 'без тела'}` };
    }
    const parsed = parseDeepSeekBalance(await res.json());
    if ('error' in parsed) {
      return { ...base, status: 'failed', amount: null, currency: null, detail: `ответ не разобран: ${parsed.error}` };
    }
    return {
      ...base, status: 'ok', amount: parsed.amount, currency: parsed.currency,
      detail: 'GET /user/balance, общий остаток счёта',
    };
  } catch (e) {
    return {
      ...base, status: 'failed', amount: null, currency: null,
      detail: `сеть/timeout: ${e instanceof Error ? e.message : 'error'}`,
    };
  }
}

async function fetchOpenRouterBalance(): Promise<ProviderBalance> {
  const base = { id: 'openrouter', label: BALANCE_SOURCES.openrouter.label };
  if (!getOpenRouterKey() && !process.env.OPENROUTER_MANAGEMENT_KEY) {
    return { ...base, status: 'no_key', amount: null, currency: null, detail: 'OPENROUTER_API_KEY не задан' };
  }
  const bal = await checkOpenRouterBalance();
  if (!bal) {
    return {
      ...base, status: 'failed', amount: null, currency: null,
      detail: 'ответ не получен; с прода OpenRouter закрыт краем сети (известное состояние health), с раннера GitHub читается',
    };
  }
  if (bal.remaining === null) {
    return {
      ...base, status: 'ok', amount: null, currency: 'USD',
      detail: `лимита нет (pay-as-you-go), потрачено ${bal.total_usage.toFixed(2)} USD`,
    };
  }
  return {
    ...base, status: 'ok', amount: bal.remaining, currency: 'USD',
    detail: `потрачено ${bal.total_usage.toFixed(2)} из ${bal.total_credits.toFixed(2)} USD`,
  };
}

/**
 * Балансы всех провайдеров из реестра. Провайдеры без API баланса идут
 * статусом unsupported с причиной — их не меньше, чем тех, что отвечают, и
 * прятать их значило бы показать владельцу «двое, и у обоих всё хорошо».
 */
export async function collectProviderBalances(): Promise<ProviderBalance[]> {
  const [deepseek, openrouter] = await Promise.all([fetchDeepSeekBalance(), fetchOpenRouterBalance()]);
  const unsupported: ProviderBalance[] = Object.entries(BALANCE_SOURCES)
    .filter(([, s]) => s.kind === 'unsupported')
    .map(([id, s]) => ({
      id, label: s.label, status: 'unsupported' as const, amount: null, currency: null,
      detail: s.reason ?? 'API баланс не отдаёт',
    }));
  return [deepseek, openrouter, ...unsupported];
}

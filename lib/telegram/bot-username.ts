/**
 * lib/telegram/bot-username.ts — имя бота для ссылок t.me/<bot>?start=…
 * берётся у самого бота (getMe), а не из переменной окружения.
 *
 * Случай 15.10. Оператор «Местечко Камчатка» по ссылке подключения получил от
 * Telegram «Похоже, такого пользователя не существует». Ссылка была собрана
 * из NEXT_PUBLIC_TELEGRAM_BOT_USERNAME, а переменная на проде стояла с
 * опечаткой: kuzmihai_bot вместо kuzmichai_bot. Бот при этом жил, вебхук
 * стоял верно, обработчик ссылку понимал — не работало только имя в адресе.
 * Переменная — объявление; у объявления должен быть источник (§4 CLAUDE.md):
 * у бота есть getMe, и он отвечает своим настоящим username.
 *
 * Порядок: getMe по TELEGRAM_BOT_TOKEN (кэш на час) → переменная окружения,
 * если она похожа на username → kuzmichai_bot. Исход называется в `source`;
 * расхождение переменной с getMe — в `env_mismatch`, его показывает health.
 * Отказ getMe не глушится: причина в логе, ссылка строится по запасу, и
 * `source` говорит об этом вслух.
 *
 * Сторож: tests/unit/telegram-bot-username.test.ts.
 */

export const DEFAULT_BOT_USERNAME = 'kuzmichai_bot';
const USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;
const CACHE_TTL_MS = 60 * 60 * 1000;
const GETME_TIMEOUT_MS = 5000;

export type BotUsernameSource = 'getMe' | 'env' | 'default';

export interface BotUsername {
  name: string;
  source: BotUsernameSource;
  /** Переменная окружения, если она задана и не совпала с getMe; иначе null. */
  env_mismatch: string | null;
  /** Почему getMe не дал имени (когда source не getMe); иначе null. */
  reason: string | null;
}

let cache: { name: string; at: number } | null = null;

/** Имя из переменной, если оно похоже на username; иначе null. */
export function envBotUsername(): string | null {
  const raw = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
  return raw && USERNAME_RE.test(raw) ? raw : null;
}

/** Имя по getMe, если его уже спрашивали в этот час; иначе null. */
export function cachedBotUsername(now: number = Date.now()): string | null {
  return cache && now - cache.at < CACHE_TTL_MS ? cache.name : null;
}

/** Только для тестов: забыть ответ getMe. */
export function resetBotUsernameCache(): void {
  cache = null;
}

function fallback(reason: string): BotUsername {
  const env = envBotUsername();
  return env
    ? { name: env, source: 'env', env_mismatch: null, reason }
    : { name: DEFAULT_BOT_USERNAME, source: 'default', env_mismatch: null, reason };
}

/**
 * Спросить у бота его имя. Кэш на час: ссылки выдаются редко, а имя бота
 * меняется ещё реже; отказ не кэшируется — следующая выдача спросит снова.
 */
export async function resolveTelegramBotUsername(
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<BotUsername> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = envBotUsername();

  const cached = cachedBotUsername(now);
  if (cached) {
    return { name: cached, source: 'getMe', env_mismatch: env && env !== cached ? env : null, reason: null };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return fallback('TELEGRAM_BOT_TOKEN не задан');

  const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  let name: string | null = null;
  let reason: string | null = null;
  try {
    const res = await fetchImpl(`${base}/bot${token}/getMe`, { signal: AbortSignal.timeout(GETME_TIMEOUT_MS) });
    const data = (await res.json()) as { ok?: boolean; description?: string; result?: { username?: string } };
    if (res.ok && data.ok && data.result?.username && USERNAME_RE.test(data.result.username)) {
      name = data.result.username;
    } else {
      reason = `getMe: HTTP ${res.status}${data.description ? `, ${data.description}` : ''}`;
    }
  } catch (err) {
    reason = `getMe: ${err instanceof Error ? err.message : 'сеть не ответила'}`;
  }

  if (!name) {
    console.error(`[telegram-bot-username] имя бота у Telegram не получено (${reason}) — ссылки строятся по запасу`);
    return fallback(reason ?? 'getMe не ответил');
  }

  cache = { name, at: now };
  const mismatch = env && env !== name ? env : null;
  if (mismatch) {
    console.error(`[telegram-bot-username] NEXT_PUBLIC_TELEGRAM_BOT_USERNAME=${mismatch} не совпадает с именем бота по getMe (${name}) — ссылки строятся по getMe, переменную надо поправить`);
  }
  return { name, source: 'getMe', env_mismatch: mismatch, reason: null };
}

/**
 * Строка для health-крона: расхождение переменной с ботом — warn (ссылки
 * из переменной вели бы в несуществующего пользователя); getMe недоступен
 * при заданной переменной — тоже warn, но с другой причиной: «не смог
 * проверить» не равно «совпадает» (§4.0). Нечего проверять — null.
 */
export function botUsernameIssue(resolved: BotUsername): { level: 'warn'; text: string } | null {
  if (resolved.env_mismatch) {
    return {
      level: 'warn',
      text: `Имя бота в NEXT_PUBLIC_TELEGRAM_BOT_USERNAME (${resolved.env_mismatch}) не совпадает с ботом по getMe (${resolved.name}): ссылки по переменной вели бы в несуществующего пользователя, сейчас строятся по getMe — поправьте переменную`,
    };
  }
  if (resolved.source !== 'getMe' && envBotUsername()) {
    return {
      level: 'warn',
      text: `Имя бота по getMe не получено (${resolved.reason ?? 'причина не названа'}): ссылки строятся по переменной ${resolved.name}, сверить её с ботом нечем`,
    };
  }
  return null;
}

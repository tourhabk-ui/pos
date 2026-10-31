/**
 * Проверка подписи `initData` мини-приложения MAX и Telegram (план
 * docs/CHAT_MINIAPPS_PLAN.md §6.2, этап 0).
 *
 * Схема у обоих мессенджеров одна: ключ — HMAC-SHA-256 токена бота с ключом
 * `WebAppData`; в строку проверки идут все поля, кроме `hash`, по алфавиту
 * через `\n` (поле `signature` Telegram остаётся в строке). Сравнение — по
 * байтам, `timingSafeEqual`.
 * Источники: https://core.telegram.org/bots/webapps, https://dev.max.ru/docs/webapps/validation (22.10.2026).
 *
 * Исходов три, как в §4.0: `ok` / `forbidden` / `not_configured`. Нет токена бота —
 * это «не настроено», а не «подпись верна» и не «подделка»: вызывающий не должен
 * пускать человека ни в одном из двух неудачных случаев.
 *
 * Читается ТОЛЬКО подписанная строка. `initDataUnsafe` на сервере не читается
 * никогда. Сама `initData` и токен в лог не пишутся — причина отказа отдаётся
 * кодом, без содержимого.
 *
 * Свежесть: `auth_date` не старше окна `maxAgeSec` (число называет владелец,
 * вопрос 16); дата из будущего дальше чем на минуту — отказ. Повтор одной
 * `initData` по `hash` в окне отсекает вызывающий (хэш хранится в БД).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type MiniappPlatform = 'max' | 'telegram';

/** Окно подписи по умолчанию: 5 минут (предложение, вопрос 16; решение владельца 31.10 «согласен»). */
export const DEFAULT_MAX_AGE_SEC = 5 * 60;
/** Часы сервера и клиента не совпадают точно: из будущего допускаем не больше минуты. */
const FUTURE_SKEW_SEC = 60;

export type InitDataRefusal =
  | 'malformed'
  | 'no_hash'
  | 'bad_signature'
  | 'no_auth_date'
  | 'expired'
  | 'from_future'
  | 'no_user';

export interface MiniappUser {
  /** id пользователя мессенджера — единственное, что идёт в поиск аккаунта. */
  id: number;
  firstName: string | null;
  username: string | null;
}

export type InitDataResult =
  | { outcome: 'ok'; platform: MiniappPlatform; user: MiniappUser; authDate: number; hash: string }
  | { outcome: 'forbidden'; reason: InitDataRefusal }
  | { outcome: 'not_configured' };

/** Токен бота платформы; пустая строка и пробелы — «не настроен». */
function tokenOf(platform: MiniappPlatform, env: NodeJS.ProcessEnv): string | null {
  const raw = platform === 'max' ? env.MAX_BOT_TOKEN : env.TELEGRAM_BOT_TOKEN;
  const token = typeof raw === 'string' ? raw.trim() : '';
  return token === '' ? null : token;
}

function parseUser(raw: string | null): MiniappUser | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const rec = data as Record<string, unknown>;
  const id = rec.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    firstName: typeof rec.first_name === 'string' ? rec.first_name : null,
    username: typeof rec.username === 'string' ? rec.username : null,
  };
}

/**
 * Строка проверки: пары `ключ=значение` без `hash`, по ключу, через `\n`.
 * Каждый параметр обязан быть ровно один раз — повтор ключа делает строку
 * неоднозначной, такую `initData` не принимаем.
 */
function checkString(params: URLSearchParams): string | null {
  const seen = new Set<string>();
  const pairs: string[] = [];
  for (const [key, value] of params) {
    if (key === 'hash') continue;
    if (seen.has(key)) return null;
    seen.add(key);
    pairs.push(`${key}=${value}`);
  }
  return pairs.sort().join('\n');
}

export function verifyInitData(
  platform: MiniappPlatform,
  initData: string,
  opts: { nowSec?: number; maxAgeSec?: number; env?: NodeJS.ProcessEnv } = {},
): InitDataResult {
  const token = tokenOf(platform, opts.env ?? process.env);
  if (token === null) return { outcome: 'not_configured' };

  if (typeof initData !== 'string' || initData === '' || initData.length > 8192) {
    return { outcome: 'forbidden', reason: 'malformed' };
  }
  const params = new URLSearchParams(initData);
  const hashes = params.getAll('hash');
  if (hashes.length !== 1 || !/^[0-9a-f]{64}$/.test(hashes[0]!)) {
    return { outcome: 'forbidden', reason: hashes.length === 0 ? 'no_hash' : 'malformed' };
  }
  const hash = hashes[0]!;
  const toCheck = checkString(params);
  if (toCheck === null) return { outcome: 'forbidden', reason: 'malformed' };

  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(toCheck).digest();
  const received = Buffer.from(hash, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { outcome: 'forbidden', reason: 'bad_signature' };
  }

  // Подпись верна — только теперь читаем поля.
  const authRaw = params.get('auth_date');
  const authDate = authRaw !== null && /^\d{1,12}$/.test(authRaw) ? Number(authRaw) : null;
  if (authDate === null) return { outcome: 'forbidden', reason: 'no_auth_date' };
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const maxAge = opts.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;
  if (authDate - nowSec > FUTURE_SKEW_SEC) return { outcome: 'forbidden', reason: 'from_future' };
  if (nowSec - authDate > maxAge) return { outcome: 'forbidden', reason: 'expired' };

  const user = parseUser(params.get('user'));
  if (user === null) return { outcome: 'forbidden', reason: 'no_user' };
  return { outcome: 'ok', platform, user, authDate, hash };
}

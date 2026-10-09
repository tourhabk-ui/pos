/**
 * Ссылка «получать заявки в мессенджере» для оператора (решение владельца 29.09).
 *
 * Кто выдаёт. Администратор (`/api/admin/operators/[id]/channel-link`,
 * requireAdmin) — для партнёров без аккаунта, и сам партнёр после входа
 * (`/api/hub/crm/channel/link`, requirePartner; id партнёра — из гарда, то
 * есть только на свою карточку) — решение владельца 09.10 «дай партнёру
 * возможность». Других выдавальщиков нет: это держит сторож
 * partner-channel-banner.
 *
 * Зачем. Перепись operator-reach 11.09: у обоих операторов с живыми турами в
 * базе нет ни Telegram, ни MAX — любая заявка и любой будущий «запрос мест»
 * уходят в пустоту. Прежний путь привязки (`/start link_`) требует, чтобы
 * оператор сам зашёл в кабинет и нажал «Подключить Telegram», — у импортированных
 * операторов аккаунта нет вовсе. Эта ссылка выдаётся администратором и
 * пересылается оператору любым способом (WhatsApp, почта, SMS): оператор жмёт
 * «Старт» в боте — и чат записан в карточку ПАРТНЁРА, а не человека.
 *
 * Токен. Без базы: подпись HMAC над (id партнёра, срок). Ограничения Telegram на
 * параметр `start` — до 64 символов из [A-Za-z0-9_-], поэтому id и срок
 * кладутся байтами, а не текстом: 16 байт UUID + 4 байта срока в минутах +
 * 12 байт подписи = 32 байта = 43 символа base64url.
 *
 * Доменное разделение: подпись берётся над меткой `partner-channel-link:v1`, и
 * токен привязки ЧЕЛОВЕКА (`lib/telegram/connect-token`) здесь не проходит, как
 * и наоборот — секрет у них может быть общий.
 *
 * Без запасного dev-секрета. Эта ссылка решает, в чей чат уйдут имя и телефон
 * туриста; подпись известным всем ключом значила бы, что чужой чат можно
 * назначить любому оператору. Секрета нет — ссылки нет, и причина названа.
 *
 * Срок — 72 часа: ссылку пересылают человеку, который может ответить не сразу,
 * а утёкшая ссылка должна протухнуть быстро. Перепривязка видна: о ней узнают
 * и администратор, и прежний чат (lib/partners/bind-channel).
 */

import { createHmac, timingSafeEqual } from 'crypto';

export const PARTNER_LINK_PREFIX = 'op_';
export const PARTNER_LINK_TTL_MS = 72 * 60 * 60 * 1000;

const DOMAIN = 'partner-channel-link:v1';
const MAC_BYTES = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secret(): string | null {
  // `||`, а не `??`: переменная, заданная пустой строкой, — это «не задана».
  const s = process.env.CONNECT_TOKEN_SECRET || process.env.JWT_SECRET || '';
  return s.length >= 16 ? s : null;
}

function mac(key: string, data: Buffer): Buffer {
  return createHmac('sha256', key).update(DOMAIN).update(data).digest().subarray(0, MAC_BYTES);
}

export type PartnerTokenResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: 'no_secret' | 'bad_partner_id' };

export function createPartnerLinkToken(partnerId: string, now: number = Date.now()): PartnerTokenResult {
  const key = secret();
  if (!key) return { ok: false, reason: 'no_secret' };
  if (!UUID_RE.test(partnerId)) return { ok: false, reason: 'bad_partner_id' };

  const expiresMin = Math.ceil((now + PARTNER_LINK_TTL_MS) / 60_000);
  const data = Buffer.alloc(20);
  Buffer.from(partnerId.replace(/-/g, ''), 'hex').copy(data, 0);
  data.writeUInt32BE(expiresMin, 16);
  const token = Buffer.concat([data, mac(key, data)]).toString('base64url');
  return { ok: true, token, expiresAt: new Date(expiresMin * 60_000) };
}

/**
 * Три исхода, а не два (§4.0): подпись не сошлась, срок вышел — это разные
 * ответы человеку («попросите новую ссылку» годится для обоих, но в лог и
 * администратору нужна причина), а «не смог проверить» (секрета нет) — факт
 * о нас, не о ссылке.
 */
export type PartnerTokenCheck =
  | { ok: true; partnerId: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'no_secret' };

export function verifyPartnerLinkToken(token: string, now: number = Date.now()): PartnerTokenCheck {
  const key = secret();
  if (!key) return { ok: false, reason: 'no_secret' };
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, reason: 'malformed' };

  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== 20 + MAC_BYTES) return { ok: false, reason: 'malformed' };
  const data = raw.subarray(0, 20);
  if (!timingSafeEqual(raw.subarray(20), mac(key, data))) return { ok: false, reason: 'bad_signature' };
  if (now > data.readUInt32BE(16) * 60_000) return { ok: false, reason: 'expired' };

  const hex = data.subarray(0, 16).toString('hex');
  const partnerId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { ok: true, partnerId };
}

/** Ссылка на бота строго на своих хостах — env с посторонним игнорируется. */
export function telegramBot(): string {
  const name = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? 'kuzmichai_bot';
  return /^[A-Za-z0-9_]{5,32}$/.test(name) ? name : 'kuzmichai_bot';
}

export function maxBot(): string {
  const fallback = 'https://max.ru/id4101147649_bot';
  const candidate = process.env.NEXT_PUBLIC_MAX_BOT_LINK ?? fallback;
  try {
    const u = new URL(candidate);
    if (u.protocol === 'https:' && (u.hostname === 'max.ru' || u.hostname.endsWith('.max.ru'))) {
      return candidate.replace(/\/$/, '');
    }
  } catch { /* битый URL в env — берём свой */ }
  return fallback;
}

export type PartnerLinks =
  | { ok: true; telegram: string; max: string; expiresAt: Date }
  | { ok: false; reason: 'no_secret' | 'bad_partner_id' };

export function buildPartnerChannelLinks(partnerId: string, now: number = Date.now()): PartnerLinks {
  const t = createPartnerLinkToken(partnerId, now);
  if (!t.ok) return t;
  const start = `${PARTNER_LINK_PREFIX}${t.token}`;
  return {
    ok: true,
    telegram: `https://t.me/${telegramBot()}?start=${start}`,
    max: `${maxBot()}?start=${start}`,
    expiresAt: t.expiresAt,
  };
}

/** Разобрать аргумент /start; не наш префикс — null (обработчик идёт дальше). */
export function partnerTokenFromStart(arg: string): string | null {
  return arg.startsWith(PARTNER_LINK_PREFIX) ? arg.slice(PARTNER_LINK_PREFIX.length) : null;
}

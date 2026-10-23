/**
 * Правила согласия партнёра на материалы — чистые функции без базы и сети
 * (миграция 1321, решение владельца 23.10). Ссылка устроена как ссылка на
 * отзыв о перевозчике (1235): ключ во фрагменте адреса, в базе только хэш,
 * 30 дней, новая ссылка гасит прежнюю.
 */
export const PARTNER_CONSENT_INVITE_DAYS = 30;
export const PARTNER_CONSENT_PATH = '/partner-consent';

/** Откуда пришло согласие подписанта на ПД — пишется рядом с версией текста. */
export const PARTNER_CONSENT_SOURCE = 'partner-consent-page';

const KEY_RE = /^[A-Za-z0-9_-]{32}$/;

/** Ключ ссылки: 24 случайных байта в base64url — ровно 32 знака. */
export function isConsentKeyShape(v: unknown): v is string {
  return typeof v === 'string' && KEY_RE.test(v);
}

/** Адрес ссылки: ключ — во фрагменте, на сервер и в логи он не уходит. */
export function partnerConsentUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, '')}${PARTNER_CONSENT_PATH}#${key}`;
}

export type InviteProblem = 'unknown' | 'expired' | 'used';

export function consentInviteVerdict(
  row: { expiresAt: string; usedAt: string | null },
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: InviteProblem } {
  if (row.usedAt) return { ok: false, reason: 'used' };
  const exp = Date.parse(row.expiresAt);
  if (!Number.isFinite(exp) || exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true };
}

export function consentInviteProblemText(reason: InviteProblem): string {
  switch (reason) {
    case 'unknown': return 'Ссылка не найдена. Возможно, её заменили новой — попросите менеджера Ведара прислать актуальную.';
    case 'expired': return 'Срок ссылки истёк. Попросите менеджера Ведара прислать новую.';
    case 'used': return 'По этой ссылке согласие уже записано. Чтобы изменить его, попросите менеджера Ведара прислать новую ссылку.';
  }
}

/** Потолок длины текста, присланного страницей на сверку: документ ~2 тыс. знаков. */
export const CONSENT_TEXT_MAX = 6000;

export type GrantProblem = InviteProblem | 'text_changed';

/** Текст ответа, когда подписать не вышло. */
export function grantProblemText(reason: GrantProblem): string {
  if (reason === 'text_changed') {
    return 'Текст согласия изменился, пока страница была открыта. Обновите страницу и прочитайте его заново.';
  }
  return consentInviteProblemText(reason);
}

/** Имя подписанта: буквы, пробелы, дефис и точка, 2–120 знаков. */
export function normalizeSignerName(raw: string): string | null {
  const s = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 120) return null;
  return /^\p{L}[\p{L}\p{M} .'’-]*$/u.test(s) ? s : null;
}

/** Должность или статус: свободный текст 2–120 знаков без управляющих символов. */
export function normalizeSignerRole(raw: string): string | null {
  const s = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 120) return null;
  return /[\p{Cc}]/u.test(s) ? null : s;
}

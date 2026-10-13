/**
 * Путь страницы принятия приглашения в команду оператора (CRM 2г). Без
 * node:crypto — читается и в браузере: страница входа возвращает сюда
 * человека, который открыл ссылку, не войдя.
 */

/** Токен — 32 байта в base64url: ровно 43 символа без «=». */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const JOIN_PATH_RE = /^\/team\/join\/([A-Za-z0-9_-]{43})$/;

export function isInviteTokenShape(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Путь страницы принятия. Хост добавляет браузер владельца — так ссылка не уйдёт на внутренний адрес. */
export function invitePath(token: string): string {
  return `/team/join/${token}`;
}

/**
 * Возврат после входа на страницу принятия. Только точный путь с токеном
 * нужной формы — открытого перенаправления быть не может.
 */
export function safeTeamJoinReturn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = JOIN_PATH_RE.exec(raw);
  return m ? invitePath(m[1]) : null;
}

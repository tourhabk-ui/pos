/**
 * Свои заходы — отдельно от внешних (решение владельца 02.10).
 *
 * «Если подумать, мои заходы тоже в этой статистике». Суточный hash от IP и
 * UA человека не называет by design (152-ФЗ), поэтому проверки владельца с
 * телефона и из кабинета считались туристами, а его вызовы MCP из своего
 * Claude — внешним спросом. Отделить их задним числом нельзя; дальше — можно,
 * двумя метками, которые ставит сам владелец:
 *
 *  - сайт: cookie `vedar_self=1` на год в этом браузере (переключатель в
 *    /hub/admin/traffic; на каждом устройстве отдельно). Маяки page_views и
 *    funnel_events пишут строку с is_self = TRUE;
 *  - MCP: метка `?self=<MCP_SELF_TAG>` в адресе коннектора, сверяется с env.
 *    Подделав метку, чужой лишь выпадет из статистики спроса — поэтому это
 *    не ключ, но и не голое слово: без env метки нет, и никто не «свой».
 *
 * Своя строка не прячется, а отделяется: панели считают внешних без неё и
 * показывают своё отдельным числом. Правило в одном месте: оба маяка и роут
 * MCP зовут эти функции, а не разбирают cookie и адрес сами.
 */
import { timingSafeEqual } from 'crypto';

export const SELF_VISIT_COOKIE = 'vedar_self';
export const SELF_VISIT_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

/** Параметр адреса MCP, несущий метку своего клиента. */
export const MCP_SELF_PARAM = 'self';
export const MCP_SELF_TAG_ENV = 'MCP_SELF_TAG';

/** Заход помечен своим: в заголовке Cookie есть vedar_self=1. */
export function isSelfVisit(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(';').some((part) => {
    const [k, v] = part.trim().split('=');
    return k === SELF_VISIT_COOKIE && v === '1';
  });
}

/** Строка для document.cookie: включить или снять метку в этом браузере. */
export function selfVisitCookieString(on: boolean): string {
  const maxAge = on ? SELF_VISIT_COOKIE_MAX_AGE_S : 0;
  return `${SELF_VISIT_COOKIE}=${on ? '1' : ''}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
}

/**
 * Вызов MCP помечен своим: метка в адресе совпала с env. Пустая или
 * отсутствующая env — своих нет вовсе (а не «все свои»). Сравнение
 * постоянного времени: метка не секрет уровня ключа, но проверить её
 * правильно дешевле, чем потом спорить, можно ли было подобрать.
 */
export function isSelfMcpCaller(url: URL, tag: string | undefined = process.env[MCP_SELF_TAG_ENV]): boolean {
  if (!tag || tag.length < 8) return false;
  const given = url.searchParams.get(MCP_SELF_PARAM);
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(tag);
  return a.length === b.length && timingSafeEqual(a, b);
}

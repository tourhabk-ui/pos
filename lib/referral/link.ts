/**
 * lib/referral/link.ts — реферальная ссылка: как её собрать и как поймать.
 *
 * ── Что обнаружилось ───────────────────────────────────────────────────────
 *
 * Реферальная ссылка на платформе была уже собрана в четырёх местах
 * (`https://vedarai.ru/?ref=КОД` — дважды в /api/loyalty/referral и дважды в
 * кабинете лояльности), но **параметр `ref` не читал никто**. Форма регистрации
 * (`app/auth/login/_AuthPageClient.tsx`) не отправляла `referralCode`, хотя
 * `POST /api/auth/register` его принимает и заводит строку в `referrals`.
 *
 * То есть кнопка «Поделиться» в кабинете лояльности уже сегодня отдаёт ссылку,
 * которая выглядит реферальной и не приводит ни одного реферала. Приглашающий
 * ждёт бонус, который не начислится: механизм не сломан — он не подключён.
 *
 * Поэтому вместе с кнопкой на главной подключён и путь: поймать `ref` при
 * входе на любую страницу, сохранить, отдать при регистрации.
 *
 * ── Почему `KH-XXXXXX`, а не любой `ref` ───────────────────────────────────
 *
 * Имя `ref` на платформе занято дважды. Кроме пользовательских кодов
 * (`users.referral_code`) есть агентские ссылки (`agent_referral_links`,
 * читаются в `GET /api/tours/[id]/price`). Класть агентский код в
 * пользовательский реферал нельзя — это разные сущности с разными выплатами.
 * Формат `users.referral_code` задан в `generateReferralCode`: `KH-` и шесть
 * шестнадцатеричных знаков. По нему и различаем.
 *
 * ── Срок ───────────────────────────────────────────────────────────────────
 *
 * 30 дней. Человек редко регистрируется в тот же заход, что и пришёл по
 * ссылке; вечное хранение — другая крайность: код полугодовой давности
 * приписал бы приглашение тому, кто к решению отношения уже не имеет.
 */

export const REFERRAL_PARAM = 'ref';
export const REFERRAL_STORAGE_KEY = 'kh-ref';
export const REFERRAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Формат пользовательского кода — см. loyaltySystem.generateReferralCode. */
const CODE_RE = /^KH-[0-9A-F]{6}$/i;

export function isUserReferralCode(value: string | null | undefined): boolean {
  return typeof value === 'string' && CODE_RE.test(value.trim());
}

/** Приписать код к ссылке. Пустой код — ссылка возвращается как есть. */
export function withReferral(url: string, code: string | null): string {
  if (!isUserReferralCode(code) || !code) return url;
  try {
    const u = new URL(url);
    u.searchParams.set(REFERRAL_PARAM, code.trim().toUpperCase());
    return u.toString();
  } catch {
    // Относительный путь или мусор — лучше отдать исходную ссылку, чем склеить
    // строку руками и получить два «?».
    return url;
  }
}

/** Достать код из строки запроса. Чужие и кривые коды не считаются. */
export function readReferralFromSearch(search: string): string | null {
  try {
    const code = new URLSearchParams(search).get(REFERRAL_PARAM);
    return isUserReferralCode(code) ? (code as string).trim().toUpperCase() : null;
  } catch {
    return null;
  }
}

interface StoredReferral {
  code: string;
  at: number;
}

/** Запомнить код. Молча ничего не делает, если хранилище недоступно. */
export function saveReferral(code: string, now: number): void {
  if (!isUserReferralCode(code)) return;
  try {
    const payload: StoredReferral = { code: code.trim().toUpperCase(), at: now };
    localStorage.setItem(REFERRAL_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Приватный режим или переполненное хранилище. Реферал потеряется, но
    // регистрация из-за этого падать не должна.
  }
}

/** Код, если он есть и не протух. Протухший — стирается. */
export function loadReferral(now: number): string | null {
  try {
    const raw = localStorage.getItem(REFERRAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { code, at } = parsed as Partial<StoredReferral>;
    if (!isUserReferralCode(code) || typeof at !== 'number') return null;
    if (now - at > REFERRAL_TTL_MS) {
      localStorage.removeItem(REFERRAL_STORAGE_KEY);
      return null;
    }
    return (code as string).toUpperCase();
  } catch {
    return null;
  }
}

/** Забыть код — после того, как он ушёл в регистрацию. */
export function forgetReferral(): void {
  try {
    localStorage.removeItem(REFERRAL_STORAGE_KEY);
  } catch {
    /* см. saveReferral */
  }
}

/**
 * lib/referral/agent-link.ts — код агента/креатора: поймать и ЗАПОМНИТЬ.
 *
 * ── Что обнаружилось (20.09, issue #1978) ─────────────────────────────────
 *
 * Владелец попросил запустить программу креаторов. Механизм под неё в
 * платформе уже был — ссылка `KH-AGT-XXXX`, счётчик кликов, атрибуция брони
 * через `operator_bookings.referral_link_id`, кабинет. Не хватало одного
 * звена, и без него вся программа не смогла бы честно посчитать, кто кого
 * привёл.
 *
 * Код НИГДЕ НЕ ЗАПОМИНАЛСЯ. Бронь брала его из адресной строки в момент
 * нажатия кнопки (`components/booking/TourPaymentModal.tsx`). Значит
 * атрибуция выживала, только если турист всё ещё на том самом URL:
 *
 *   • ушёл с карточки тура на маршрут и вернулся — потеряно;
 *   • открыл ссылку из мессенджера, срезавшего параметры — потеряно;
 *   • вернулся назавтра, а для покупки за 28 000 ₽ это норма, — потеряно.
 *
 * Блогер в таком случае не получает ничего, и доказать обратное нечем.
 *
 * ── Почему отдельный модуль, а не расширение `link.ts` ────────────────────
 *
 * В `lib/referral/link.ts` записано прямо: имя `ref` на платформе занято
 * дважды, и класть агентский код в пользовательский реферал НЕЛЬЗЯ — это
 * разные сущности с разными выплатами. Пользовательский код приглашает
 * друга и даёт бонус лояльности; агентский приводит покупателя и даёт
 * вознаграждение по ставке, которую назначает владелец.
 *
 * Поэтому здесь своё хранилище, свой формат и своя проверка. Общий у них
 * только параметр в адресе — и именно поэтому оба ловца обязаны смотреть на
 * ФОРМАТ, а не хватать всё подряд: чужой код в своём хранилище хуже
 * отсутствующего, потому что выглядит как рабочий.
 *
 * ── Формат ────────────────────────────────────────────────────────────────
 *
 * `KH-AGT-` и шесть шестнадцатеричных знаков — так его собирает
 * `POST /api/hub/agent/referral` (`randomBytes(3).toString('hex')`).
 * Пользовательский код короче и без `AGT`, так что перепутать их нельзя ни
 * в одну сторону.
 *
 * ── Срок ──────────────────────────────────────────────────────────────────
 *
 * 30 дней — тот же, что у пользовательского приглашения, и по той же
 * причине. Меньше не годится: дорогую поездку выбирают неделями. Вечно
 * нельзя: код полугодовой давности приписал бы покупку блогеру, к решению
 * уже не причастному.
 *
 * ── Чего модуль не делает ─────────────────────────────────────────────────
 *
 * Не ходит в сеть и не знает, существует ли такая ссылка. Проверяет ТОЛЬКО
 * форму. Живость кода решает сервер при брони: там `SELECT ... WHERE code = $1
 * AND is_active` — и несуществующий код честно даёт NULL, а не выдуманную
 * привязку.
 */

export const AGENT_REFERRAL_PARAM = 'ref';
export const AGENT_REFERRAL_STORAGE_KEY = 'kh-agent-ref';
export const AGENT_REFERRAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Формат кода агентской ссылки — см. POST /api/hub/agent/referral. */
const AGENT_CODE_RE = /^KH-AGT-[0-9A-F]{6}$/i;

export function isAgentReferralCode(value: string | null | undefined): boolean {
  return typeof value === 'string' && AGENT_CODE_RE.test(value.trim());
}

/** Достать агентский код из строки запроса. Пользовательский не считается. */
export function readAgentReferralFromSearch(search: string): string | null {
  try {
    const code = new URLSearchParams(search).get(AGENT_REFERRAL_PARAM);
    return isAgentReferralCode(code) ? (code as string).trim().toUpperCase() : null;
  } catch {
    return null;
  }
}

interface StoredAgentReferral {
  code: string;
  at: number;
}

/**
 * Запомнить код. Молча ничего не делает, если хранилище недоступно.
 *
 * Приватный режим и переполненное хранилище — не повод падать: потеря
 * атрибуции неприятна, сломанная страница хуже.
 */
export function saveAgentReferral(code: string, now: number): void {
  if (!isAgentReferralCode(code)) return;
  try {
    const payload: StoredAgentReferral = { code: code.trim().toUpperCase(), at: now };
    localStorage.setItem(AGENT_REFERRAL_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* см. шапку */
  }
}

/** Код, если он есть и не протух. Протухший — стирается. */
export function loadAgentReferral(now: number): string | null {
  try {
    const raw = localStorage.getItem(AGENT_REFERRAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { code, at } = parsed as Partial<StoredAgentReferral>;
    if (!isAgentReferralCode(code) || typeof at !== 'number') return null;
    if (now - at > AGENT_REFERRAL_TTL_MS) {
      localStorage.removeItem(AGENT_REFERRAL_STORAGE_KEY);
      return null;
    }
    return (code as string).toUpperCase();
  } catch {
    return null;
  }
}

/**
 * Код для брони: сперва адресная строка, потом память.
 *
 * Порядок именно такой. Адрес — это «человек пришёл по ссылке ПРЯМО
 * СЕЙЧАС», и он сильнее вчерашней памяти: если турист открыл ссылку другого
 * блогера, привёл его этот, а не тот, чей код лежит в хранилище.
 *
 * Чистая функция: `search` и `now` передаются, чтобы правило проверялось
 * без браузера.
 */
export function agentReferralForBooking(search: string, now: number): string | null {
  return readAgentReferralFromSearch(search) ?? loadAgentReferral(now);
}

/** Забыть код. Нужен при разборе и при ручной чистке. */
export function forgetAgentReferral(): void {
  try {
    localStorage.removeItem(AGENT_REFERRAL_STORAGE_KEY);
  } catch {
    /* см. saveAgentReferral */
  }
}

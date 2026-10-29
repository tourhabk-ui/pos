/**
 * Правило 1в — порядок предложений туров на ОБЩИХ витринах (слово владельца
 * 29.10, «1в 2б 3 да»).
 *
 * Сначала туры со свободной датой — по ближайшему выезду. Остальные (и ничьи
 * по дате) — «жребий дня»: порядок меняется раз в сутки, по календарной дате
 * Камчатки. Жребий воспроизводим: FNV-1a от строки «дата:id», а не
 * Math.random и не RANDOM() в SQL. Любой, у кого есть дата и id, повторит
 * порядок сам — значит, его можно проверить, а не поверить ему.
 *
 * Чего в порядке НЕТ и быть не должно (CLAUDE.md §0): комиссии платформы,
 * новизны, номера тура как ранга (id — только последний ключ ради
 * устойчивости), длины названия, рейтинга, случайности и цены по умолчанию.
 * Цена и дата — только кнопка, которую нажимает турист, с подписью
 * SORT_CHOICE_NOTE_RU. Правило называется туристу на странице
 * (OFFER_ORDER_NOTE) и кончается фразой «Место в списке не продаётся.».
 *
 * Где правило НЕ действует: список КОМПАНИЙ /operators (по алфавиту,
 * lib/operators/list-query) и своя витрина партнёра — его страница, сайт и
 * виджет (там его закрепление, миграция 1267).
 *
 * «Свободная дата» — одно SQL-условие, lib/tours/nearest-free-date.
 * Этот модуль чистый: без базы, безопасен для клиента.
 *
 * Порядок считается только здесь, в TypeScript, после SQL: второй копии
 * правила в ORDER BY нет. Живых туров на 29.10 — 75, загрузить все и
 * отсортировать в памяти дешевле, чем держать два правила. Потолок — около
 * тысячи живых туров: дальше загрузку всей витрины придётся пересмотреть.
 *
 * Сторож: tests/unit/offer-order.test.ts.
 */

import { kamchatkaDate } from '@/lib/analytics/kamchatka-day';
import { plural } from '@/lib/home/data-freshness';
import { longDay, requestWindow, windowLabel } from '@/lib/tours/request-window';

export const OFFER_ORDER_VERSION = '1v-2026-10-29';

const encoder = new TextEncoder();

/** FNV-1a 32 бит по байтам UTF-8; результат без знака. */
export function fnv1a32(s: string): number {
  let h = 2166136261;
  for (const b of encoder.encode(s)) {
    h ^= b;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Жребий дня тура: день — 'YYYY-MM-DD' по Камчатке. */
export function tourLot(day: string, tourId: string | number): number {
  return fnv1a32(`${day}:${String(tourId)}`);
}

/** Жребий дня компании: один билет на компанию, сколько бы туров у неё ни было. */
export function companyLot(day: string, partnerId: string): number {
  return fnv1a32(`${day}:company:${partnerId}`);
}

/** День правила для момента `now` — календарная дата Камчатки. */
export function offerOrderDay(now: Date = new Date()): string {
  return kamchatkaDate(now);
}

export interface OfferKeyInput {
  id: string | number;
  /** Ближайшая дата со свободными местами, 'YYYY-MM-DD'; нет — null. */
  nearestFreeDate: string | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

/** Дата как ключ: только 'YYYY-MM-DD'; всё прочее — «даты нет», а не ошибка порядка. */
function dayKey(v: string | null | undefined): string | null {
  return typeof v === 'string' && ISO_DAY.test(v) ? v.slice(0, 10) : null;
}

function compareIds(a: string | number, b: string | number): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Компаратор тура: есть дата → дата раньше → жребий дня → id числом. */
export function compareTourOffers(day: string): (a: OfferKeyInput, b: OfferKeyInput) => number {
  return (a, b) => {
    const da = dayKey(a.nearestFreeDate);
    const db = dayKey(b.nearestFreeDate);
    if ((da === null) !== (db === null)) return da === null ? 1 : -1;
    if (da !== null && db !== null && da !== db) return da < db ? -1 : 1;
    const la = tourLot(day, a.id);
    const lb = tourLot(day, b.id);
    if (la !== lb) return la - lb;
    return compareIds(a.id, b.id);
  };
}

export interface OfferOrderOptions {
  now?: Date;
  /** День правила; задаётся один раз за запрос и передаётся вниз. */
  day?: string;
}

function resolveDay(opts?: OfferOrderOptions): string {
  return opts?.day ?? offerOrderDay(opts?.now ?? new Date());
}

/** Порядок по правилу 1в. Новый массив, вход не меняется. */
export function orderOffers<T extends OfferKeyInput>(rows: readonly T[], opts?: OfferOrderOptions): T[] {
  return [...rows].sort(compareTourOffers(resolveDay(opts)));
}

/**
 * То же правило для строк, у которых ключи названы иначе (`next_open_date`,
 * `nearest_free_date`): ключ достаётся функцией, строка возвращается как была.
 */
export function orderOffersBy<T>(
  rows: readonly T[],
  key: (row: T) => OfferKeyInput,
  opts?: OfferOrderOptions,
): T[] {
  const cmp = compareTourOffers(resolveDay(opts));
  return rows
    .map((row) => ({ row, k: key(row) }))
    .sort((a, b) => cmp(a.k, b.k))
    .map((x) => x.row);
}

export interface CompanyGroup<T> {
  partnerId: string;
  partnerName: string;
  tours: T[];
}

/**
 * Группы по компаниям (карточка места, главная). Компания с датой — выше
 * компании без дат, раньше дата — выше; ничья — жребий дня КОМПАНИИ: у
 * компании с четырьмя турами один билет, а не четыре. Внутри — порядок тура.
 */
export function groupOffersByCompany<T extends OfferKeyInput & { partnerId: string; partnerName: string }>(
  rows: readonly T[],
  opts?: OfferOrderOptions,
): CompanyGroup<T>[] {
  const day = resolveDay(opts);
  const byPartner = new Map<string, CompanyGroup<T>>();
  for (const r of rows) {
    const g = byPartner.get(r.partnerId);
    if (g) g.tours.push(r);
    else byPartner.set(r.partnerId, { partnerId: r.partnerId, partnerName: r.partnerName, tours: [r] });
  }
  const cmpTour = compareTourOffers(day);
  const groups = [...byPartner.values()].map((g) => {
    const tours = [...g.tours].sort(cmpTour);
    return { group: { ...g, tours }, first: dayKey(tours[0]?.nearestFreeDate) };
  });
  groups.sort((a, b) => {
    if ((a.first === null) !== (b.first === null)) return a.first === null ? 1 : -1;
    if (a.first !== null && b.first !== null && a.first !== b.first) return a.first < b.first ? -1 : 1;
    const la = companyLot(day, a.group.partnerId);
    const lb = companyLot(day, b.group.partnerId);
    if (la !== lb) return la - lb;
    return a.group.partnerId < b.group.partnerId ? -1 : a.group.partnerId > b.group.partnerId ? 1 : 0;
  });
  return groups.map((g) => g.group);
}

/** Круг по компаниям: первый тур каждой группы в порядке групп, затем второй… */
export function roundRobinByCompany<T>(groups: readonly CompanyGroup<T>[]): T[] {
  const out: T[] = [];
  const depth = groups.reduce((m, g) => Math.max(m, g.tours.length), 0);
  for (let i = 0; i < depth; i++) {
    for (const g of groups) if (i < g.tours.length) out.push(g.tours[i]);
  }
  return out;
}

// ── Подписи ──────────────────────────────────────────────────────────────

export const OFFER_ORDER_NOTE = {
  ru: 'Порядок: сначала туры со свободными местами — по ближайшему выезду; остальные раз в сутки меняются местами по жребию. Место в списке не продаётся.',
  en: 'Order: tours with open seats first, by the nearest departure; the rest are reshuffled by lot once a day. Positions are not for sale.',
  zh: '排序：有空位的团队游在前，按最近出发日期排列；其余每天抽签调换一次顺序。排名不出售。',
} as const;

/** Карточка места: порядок КОМПАНИЙ. */
export const OFFER_ORDER_NOTE_GROUPED_RU =
  'Компании идут так: сначала те, у кого есть свободные места, — по ближайшему выезду; остальные раз в сутки меняются местами по жребию. Место в списке не продаётся.';

/** Под кнопками сортировки (каталог, карточка маршрута). */
export const SORT_CHOICE_NOTE_RU =
  'Сортировку по цене включаете вы — без неё порядок как выше. Цена сравнивается как записана: за человека, за группу или за день.';

/** Для агента (каталог Кузьмича, get_tours, get_place_info): та же суть одной строкой. */
export const OFFER_ORDER_NOTE_AGENT =
  'Порядок туров — правило платформы: сначала со свободными местами по ближайшей дате, остальные раз в сутки по жребию; не «лучшие» и не «рекомендуемые». Место в списке не продаётся.';

/** «2 предложения от 2 компаний», «1 предложение от 1 компании», «21 предложение от 21 компании». */
export function offersSummary(tours: number, companies: number): string {
  return `${tours} ${plural(tours, 'предложение', 'предложения', 'предложений')} от ${companies} ${plural(companies, 'компании', 'компаний', 'компаний')}`;
}

// ── Фраза о датах ────────────────────────────────────────────────────────

export interface DatesPhraseInput {
  nearestFreeDate: string | null;
  /** Ведёт ли тур календарь (keepsScheduleSql); null — не прочитано. */
  keepsSchedule: boolean | null;
  season_start: string | null;
  season_end: string | null;
  duration_type: string | null;
  multi_day_count: number | null;
  duration_hours: number | null;
}

/**
 * Одна строка о датах тура для списков. Пять исходов: даты не загрузились;
 * есть свободная дата; даты по заявке в сезон; даты по заявке без сезона;
 * календарь есть, но на открытые даты мест нет (§4.0: это не «даты не
 * записаны»).
 */
export function offerDatesPhrase(t: DatesPhraseInput, today: string, datesState: 'ok' | 'failed'): string {
  if (datesState === 'failed') return 'даты не загрузились';
  const d = dayKey(t.nearestFreeDate);
  if (d) return `ближайшая дата со свободными местами — ${longDay(d)}`;
  if (t.keepsSchedule === false) {
    const w = requestWindow({
      season_start: t.season_start, season_end: t.season_end,
      duration_type: t.duration_type, multi_day_count: t.multi_day_count, duration_hours: t.duration_hours,
    }, today);
    return w.kind === 'season'
      ? `даты по заявке, ${windowLabel(w)}`
      : 'даты не записаны — оператор подтвердит дату по заявке';
  }
  if (t.keepsSchedule === true) return 'на открытые даты мест нет';
  return 'даты не загрузились';
}

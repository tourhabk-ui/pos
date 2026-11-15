/**
 * lib/planner/item-status.ts — одна метка у каждого пункта дня плана
 * (#3399, п. 7; слово владельца 15.11 «делай»).
 *
 * До этого у плана было три словаря, и ни один не говорил всего:
 * - карточка дня на сайте писала «С оператором / Сам / На выбор» и молчала о
 *   местах — день с туром без единого свободного места выглядел так же, как
 *   день, где места проверены;
 * - Кузьмич и MCP писали строку занятости своими словами (`tourAvailabilityLine`);
 * - страница поездки — своими (`lib/trips/day-availability`).
 *
 * Метка отвечает на один вопрос: что за пункт и проверено ли, что он
 * состоится. Тур с местами, тур без мест, тур, где места не подтверждены,
 * тур, который после правки не перечитан, свой выход по маршруту из базы и
 * идея без тура — разные состояния и разные слова (§4.0). Подробности —
 * дата, число мест, время проверки — остаются в своих строках.
 *
 * Чистый модуль: его зовут экран, печать, Кузьмич и MCP.
 */
import { TOUR_PRICE_PENDING_TEXT } from './calendar-days';

export type PlanItemStatus =
  | 'seats'
  | 'short'
  | 'full'
  | 'on_request'
  | 'no_slot'
  | 'unconfirmed'
  | 'stale'
  | 'continues'
  | 'self'
  | 'idea';

/** Подпись и подсказка — одни для экрана, печати, Кузьмича, MCP и страницы поездки. */
export const PLAN_ITEM_STATUS: Record<PlanItemStatus, { label: string; hint: string }> = {
  seats: {
    label: 'Тур · места есть',
    hint: 'Тур оператора в системе, свободные места на дату дня прочитаны',
  },
  short: {
    label: 'Тур · мест на группу не хватает',
    hint: 'Места на дату дня есть, но меньше, чем людей в группе',
  },
  full: {
    label: 'Тур · мест нет',
    hint: 'Тур ведёт расписание, на дату дня свободных мест нет',
  },
  on_request: {
    label: 'Тур · дату подтвердит оператор',
    hint: 'Расписания у тура в системе нет: места не подтверждены, но это не «мест нет» — дату подтверждает оператор по заявке',
  },
  no_slot: {
    label: 'Тур · места не найдены',
    hint: 'Свободных мест на дату дня в системе нет, а ведёт ли тур расписание, не проверено — дату может подтвердить оператор',
  },
  unconfirmed: {
    label: 'Тур · места не подтверждены',
    hint: 'Занятость тура не прочиталась или время проверки не записано',
  },
  stale: {
    label: 'Не перепроверено после правки',
    hint: 'Дату дня изменили — места и цену тура на новую дату ещё не перечитали',
  },
  continues: {
    label: 'Тур · продолжение',
    hint: 'Следующий день многодневного тура: места и цена — на его первом дне',
  },
  self: {
    label: 'Сам · маршрут из базы',
    hint: 'Тура нет: самостоятельный выход по месту или маршруту из базы',
  },
  idea: {
    label: 'Идея · тура нет',
    hint: 'Готового тура или маршрута под этот день в базе нет — выберите сами или спросите Кузьмича',
  },
};

/** Ведёт ли тур расписание: `request` — нет, дату подтверждает оператор. */
export type TourCalendar = 'dated' | 'request';

/** День плана в том объёме, что нужен метке. День движка и день экрана подходят. */
export interface PlanItemDay {
  type: string;
  realTour?: { tourId?: string; calendar?: TourCalendar } | null;
  /** Место или маршрут для самостоятельного выхода (`activityMode`). */
  activityMode?: 'operator' | 'self' | 'open';
  realPrice?: number;
  priceMissing?: string;
  availability?: 'open' | 'none' | 'unread';
  availabilityCheckedAt?: string;
  capacityWarning?: string;
}

/**
 * Метка пункта; null — день не про занятие (прилёт, отдых, резерв, переезд,
 * отъезд): у них своя подпись по типу дня.
 *
 * `calendar` — ведёт ли тур расписание, если день его не несёт (план
 * собран до поля, правка через Кузьмича): `undefined` — не знаем.
 */
export function planItemStatus(d: PlanItemDay, calendar?: TourCalendar | null): PlanItemStatus | null {
  if (d.type !== 'activity') return null;
  if (!d.realTour) return d.activityMode === 'self' ? 'self' : 'idea';
  // Перестановка дня сняла цену и места прежней даты (`renumberByPosition`):
  // пока не перечитали, ни «места есть», ни «мест нет» не верны.
  if (d.priceMissing === TOUR_PRICE_PENDING_TEXT) return 'stale';
  // День продолжения многодневного тура: ни цены, ни занятости он не несёт.
  if (!d.availability && d.realPrice == null && !d.priceMissing) return 'continues';
  if (d.availability === 'open') {
    // Нет времени проверки — ответ мог устареть как угодно (принцип 2, 07.11).
    if (!d.availabilityCheckedAt || !Number.isFinite(Date.parse(d.availabilityCheckedAt))) return 'unconfirmed';
    return d.capacityWarning ? 'short' : 'seats';
  }
  if (d.availability === 'none') {
    const cal = d.realTour.calendar ?? calendar ?? undefined;
    if (cal === 'request') return 'on_request';
    if (cal === 'dated') return 'full';
    return 'no_slot';
  }
  // `unread` или занятость не читалась вовсе (план без дат).
  return 'unconfirmed';
}

/** Пункт, про который нельзя сказать, что он состоится как записан. */
export function isUncheckedItem(s: PlanItemStatus | null): boolean {
  return s === 'stale' || s === 'unconfirmed' || s === 'no_slot' || s === 'on_request';
}

/**
 * Итог плана по меткам: сколько пунктов не проверено и каких дней. План с
 * такими пунктами не называется готовым — это черновик, и сказано почему.
 * `null` — непроверенных нет.
 */
export function uncheckedItemsLine(items: ReadonlyArray<{ day: number; status: PlanItemStatus | null }>): string | null {
  const days = items.filter((i) => isUncheckedItem(i.status)).map((i) => i.day);
  if (days.length === 0) return null;
  const stale = items.filter((i) => i.status === 'stale').length;
  const which = days.length === 1 ? `день ${days[0]}` : `дни ${days.join(', ')}`;
  return `Не всё проверено: ${which} — места тура не подтверждены${stale > 0 ? ' или не перечитаны после правки' : ''}. Подтверждает оператор по заявке.`;
}

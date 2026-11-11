/**
 * lib/planner/tour-day-reread.ts — места и цена тура дня на его дату и группу
 * (аудит планировщика 07.11, M3).
 *
 * Правка плана ставит тур на другую дату или другой группе: убрать,
 * переставить или добавить день, сдвинуть поездку, задержка рейса с
 * переносом обратного билета, новый состав группы. До этого места
 * (`availability`, `slotsRemaining`) и цена (`realPrice`) оставались от
 * прежней даты и прежней группы: план говорил «свободно 6 мест» про день, на
 * который их никто не проверял, и считал цену чужой группы.
 *
 * Источники и правила — те же, что у движка при сборке дня (`recommendTrip`):
 * занятость — `fetchAvailabilityForTour` на дату дня, цена — `planTourPrice`
 * (правило брони) для группы и даты, предупреждение о местах — тем же текстом.
 * Совпадение с движком держит сторож вызовом обоих на одних данных
 * (tests/unit/plan-edit-reread.test.ts). Движок пока считает это своим кодом:
 * перевести его на этот модуль — после волны 3 соседней сессии, которая
 * меняет ту же часть движка.
 *
 * Исходы (§4.0): места есть, мест нет, не прочитали; цена есть, цены для этой
 * группы нет, не посчитали. Тура больше нет на витрине — цены нет, и это
 * сказано своими словами, а не «проверить не удалось».
 */

import { pool } from '@/lib/db-pool';
import { createPlannerCache, fetchAvailabilityForTour } from './data';
import { planTourPrice, PRICE_UNREAD_TEXT } from './tour-price';
import { publicTourSql } from '@/lib/tours/public-visibility';

export interface TourDayInput {
  tourId: string;
  /** Потолок группы тура — для строки «свободно N из M мест»; нет — без ограничения. */
  maxParticipants: number | null;
  /** Дата дня плана, YYYY-MM-DD. */
  date: string;
  /** Сколько человек: взрослые и дети. */
  participants: number;
}

/** Поля дня с туром, которые зависят от даты и группы. */
export interface TourDayRead {
  availability: 'open' | 'none' | 'unread';
  availableDate?: string;
  slotsRemaining?: number;
  capacityWarning?: string;
  realPrice?: number;
  priceLabel?: string;
  priceMissing?: string;
  priceFrom: number;
  priceTo: number;
}

/** Тур сняли с витрины после того, как план собран. */
export const TOUR_OFF_SALE_TEXT = 'Тура сейчас нет на витрине — цену не называю.';

type PriceInputs =
  | { kind: 'ok'; basePrice: number; priceUnit: string; multiDayCount: number | null; durationHours: number | null }
  | { kind: 'off_sale' }
  | { kind: 'failed' };

async function loadPriceInputs(tourId: string): Promise<PriceInputs> {
  try {
    const { rows } = await pool.query<{
      base_price: string | number | null;
      price_unit: string | null;
      multi_day_count: number | null;
      duration_hours: string | number | null;
      on_sale: boolean;
    }>(
      `SELECT ot.base_price, ot.price_unit, ot.multi_day_count, ot.duration_hours,
              ${publicTourSql('ot')} AS on_sale
         FROM operator_tours ot
        WHERE ot.id = $1`,
      [tourId],
    );
    const row = rows[0];
    if (!row || !row.on_sale) return { kind: 'off_sale' };
    return {
      kind: 'ok',
      basePrice: parseFloat(String(row.base_price)) || 0,
      priceUnit: row.price_unit ?? 'per_person',
      multiDayCount: row.multi_day_count,
      durationHours: row.duration_hours === null ? null : Number(row.duration_hours),
    };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[planner] тур дня для правки плана не прочитан', { tourId, sqlstate: e?.code ?? null, message: e?.message ?? null });
    return { kind: 'failed' };
  }
}

/** «1 место / 2 места / 5 мест». */
function seatsWord(n: number): string {
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return 'мест';
  const m10 = n % 10;
  if (m10 === 1) return 'место';
  if (m10 >= 2 && m10 <= 4) return 'места';
  return 'мест';
}

/** «из 1 места / из 4 мест»: после «из» — родительный падеж. */
function ofSeats(n: number): string {
  return `из ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'места' : 'мест'}`;
}

/**
 * Строка о местах — тем же правилом, что у движка: мест меньше, чем людей, —
 * «возможно, придётся выбрать другую дату»; три и меньше — «высокий спрос».
 *
 * Группа больше потолка тура — другой разговор (разбор 08.11: 24 человека на
 * тур, который берёт четверых, получали «возможно, придётся выбрать другую
 * дату», хотя другая дата не поможет). Потолок называется как записанный у
 * тура: он бывает и заглушкой автора миграции, подтверждает оператор.
 */
export function capacityWarningFor(remaining: number, maxParticipants: number | null, participants: number): string | undefined {
  if (maxParticipants !== null && participants > maxParticipants) {
    return `На выезд тур берёт до ${maxParticipants} чел. (так записано у тура), вас ${participants}: на одну дату вся группа не войдёт. `
      + 'Заявка на всю группу уйдёт оператору запросом: несколько выездов или своя группа — по договорённости с ним.';
  }
  if (remaining < participants) {
    // Потолок не записан (группа без ограничения) — «из N» не выдумывается (E3).
    const seats = maxParticipants !== null ? `${remaining} ${ofSeats(maxParticipants)}` : `${remaining} ${seatsWord(remaining)}`;
    return `Свободно ${seats}, вас ${participants}. Возможно, придётся выбрать другую дату.`;
  }
  if (remaining <= 3) return `Осталось ${remaining} ${seatsWord(remaining)} — высокий спрос`;
  return undefined;
}

/** Места и цена тура на дату дня для группы. Отказ любого чтения — свой исход, не «хорошо». */
export async function rereadTourDay(input: TourDayInput): Promise<TourDayRead> {
  const cache = createPlannerCache();
  const [slots, priceInputs] = await Promise.all([
    fetchAvailabilityForTour(input.tourId, input.date, input.date, cache).catch((err: unknown) => {
      const e = err as { code?: string; message?: string };
      console.error('[planner] занятость тура для правки плана не прочитана', { tourId: input.tourId, sqlstate: e?.code ?? null, message: e?.message ?? null });
      return null;
    }),
    loadPriceInputs(input.tourId),
  ]);

  const out: TourDayRead = { availability: 'unread', priceFrom: 0, priceTo: 0 };
  if (slots !== null) {
    const slot = slots.find((s) => s.date === input.date);
    out.availability = slot ? 'open' : 'none';
    if (slot) {
      out.availableDate = slot.date;
      out.slotsRemaining = slot.remaining;
      const warn = capacityWarningFor(slot.remaining, input.maxParticipants, input.participants);
      if (warn) out.capacityWarning = warn;
    }
  }

  if (priceInputs.kind === 'off_sale') {
    out.priceMissing = TOUR_OFF_SALE_TEXT;
    return out;
  }
  if (priceInputs.kind === 'failed') {
    out.priceMissing = PRICE_UNREAD_TEXT;
    return out;
  }
  const priced = await planTourPrice({
    tourId: input.tourId, basePrice: priceInputs.basePrice, priceUnit: priceInputs.priceUnit,
    participants: input.participants,
    multiDayCount: priceInputs.multiDayCount,
    durationHours: priceInputs.durationHours,
    tourDate: input.date,
  });
  if (priced.kind === 'priced' && priced.unitPrice > 0) {
    out.realPrice = priced.unitPrice;
    out.priceFrom = priced.unitPrice;
    out.priceTo = priced.unitPrice;
    if (priced.label) out.priceLabel = priced.label;
  } else {
    out.priceMissing = priced.kind === 'missing' ? priced.text : PRICE_UNREAD_TEXT;
  }
  return out;
}

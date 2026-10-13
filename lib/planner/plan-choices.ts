/**
 * lib/planner/plan-choices.ts — жильё пунктами плана (#2304, шаг 3). Чистый
 * модуль: считает и браузер (/planner), и смета.
 *
 * ── Что было до 09.10 ─────────────────────────────────────────────────────
 *
 * «Что ещё нужно» показывало до трёх объектов жилья на стоянку и поездки
 * перевозчиков — списком, без выбора. В смете ночь оставалась ориентиром по
 * зоне, в заявку не уходило ничего: оператор узнавал о жилье и трансфере
 * звонком.
 *
 * ── Что здесь ─────────────────────────────────────────────────────────────
 *
 * Выбор человека — это только ключи: стоянка → объект.
 * Пункты плана собираются из ТЕКУЩЕГО ответа /api/planner/trip-extras: план
 * правится, стоянки пересчитываются, и выбор, которого в новом ответе нет
 * (объект занят на новые даты, стоянка исчезла), в смету не попадает —
 * старая цена за другие ночи была бы враньём.
 *
 * ── Трансфера здесь нет (13.10) ───────────────────────────────────────────
 *
 * До 13.10 в план брали и поездку перевозчика — «N мест × цена места». Такого
 * товара нет (владелец: «бронируют целую машину а не место в ней»): машину
 * заказывают целиком, направление и даты — в заявке перевозчику, и цену
 * машины до заявки не знает никто. Поэтому трансфер в смету не встаёт, а
 * экран ведёт на страницу перевозчика.
 */
import type { ZoneId } from '@/lib/planner/constants';
import type { StayPrice } from '@/lib/planner/trip-extras';

/** Выбор человека: ключ стоянки → id объекта. */
export interface ChoiceSelection {
  lodging: Record<string, string>;
}

export const EMPTY_SELECTION: ChoiceSelection = { lodging: {} };

/** Ключ стоянки: зона и дата заезда — то же, что ключ блока на экране. */
export const stayKey = (s: { zone: string; checkIn: string }) => `${s.zone}-${s.checkIn}`;

/** Выбранное жильё на стоянку — пункт плана. */
export interface ChosenStay {
  zone: ZoneId;
  checkIn: string;
  /** Дата выезда: ночь этого дня уже не входит. */
  checkOut: string;
  nights: number;
  accommodationId: string;
  name: string;
  /** null — цену стоянки на группу не посчитали (ответ без неё). */
  price: StayPrice | null;
}

export interface PlanChoices {
  stays: ChosenStay[];
}

/** Ответ дополнений в том объёме, что нужен выбору (совместим с экраном). */
export interface ExtrasForChoices {
  lodging?:
    | { state: 'no_dates' }
    | {
      state: 'checked';
      stays: Array<{
        zone: string; checkIn: string; checkOut: string; nights: number;
        result: { state: 'ok'; items: Array<{ id: string; name: string; stay?: StayPrice }> } | { state: 'empty' } | { state: 'unavailable' };
      }>;
    };
}

const ZONES: readonly string[] = ['avachinsky', 'western', 'eastern', 'northern'];

/** Пункты плана из текущего ответа и выбора; выбора, которого в ответе нет, — нет. */
export function resolveChoices(data: ExtrasForChoices | null | undefined, sel: ChoiceSelection): PlanChoices {
  const stays: ChosenStay[] = [];
  if (data?.lodging?.state === 'checked') {
    for (const s of data.lodging.stays) {
      const id = sel.lodging[stayKey(s)];
      if (!id || s.result.state !== 'ok' || !ZONES.includes(s.zone)) continue;
      const o = s.result.items.find((i) => i.id === id);
      if (!o) continue;
      stays.push({
        zone: s.zone as ZoneId, checkIn: s.checkIn, checkOut: s.checkOut, nights: s.nights,
        accommodationId: o.id, name: o.name, price: o.stay ?? null,
      });
    }
  }
  return { stays };
}

/** Выбрать объект на стоянку; повторное нажатие на выбранный — снять выбор. */
export function toggleLodging(sel: ChoiceSelection, key: string, id: string): ChoiceSelection {
  const lodging = { ...sel.lodging };
  if (lodging[key] === id) delete lodging[key]; else lodging[key] = id;
  return { ...sel, lodging };
}


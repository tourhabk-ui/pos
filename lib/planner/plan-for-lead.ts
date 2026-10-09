/**
 * lib/planner/plan-for-lead.ts — план поездки в заявке (#2304, шаг 2). Чистый
 * модуль: сводку собирает и браузер (/planner), и сервер (MCP по plan_id).
 *
 * ── Что было до 09.10 ─────────────────────────────────────────────────────
 *
 * Из /planner в заявку уходили названия дней (`day_plan`) и зоны — без
 * состава группы, уровня, туров и цен. Оператор видел «День 3. Вулканы —
 * Авачинская зона» и звонил переспрашивать то, что человек уже выбрал. Поля
 * `day_plan` и `recommendation` при этом не читал никто: ни админка, ни
 * уведомление — объявление без потребителя (§10.09).
 *
 * ── Что здесь ─────────────────────────────────────────────────────────────
 *
 * Одна форма плана для заявки: состав и уровень, дни с датами и турами (тур,
 * оператор, цена с единицей или «цену называет оператор»), смета на группу
 * (`estimateGroup` — та же формула, что на экране). И одна запись словами —
 * `planLeadLines`: её читают уведомление в Телеграм и карточка лида в
 * админке, чтобы две поверхности не разошлись в подписях.
 *
 * Персональных данных здесь нет и быть не должно: сводка уходит в разбор
 * лида моделью (lead-processor), а имя и телефон живут в своих колонках.
 */
import { estimateGroup, type EstimateDay, type EstimateProfile, type GroupEstimate } from '@/lib/planner/estimate';
import type { BudgetTier, DayType, ZoneId } from '@/lib/planner/constants';
import { asTripOrigin, type TripOrigin } from '@/lib/planner/trip-origin';
import { PRICE_UNIT_SHORT } from '@/lib/tours/labels';
import type { PlanChoices } from '@/lib/planner/plan-choices';

/** День в том объёме, что нужен заявке. День движка и день экрана подходят. */
export interface PlanLeadInputDay extends EstimateDay {
  realTour?: EstimateDay['realTour'] & { operatorName?: string };
  availableDate?: string;
}

export interface PlanLeadDay {
  day: number;
  /** Дата дня, `YYYY-MM-DD`; null — план без дат. */
  date: string | null;
  type: DayType;
  title: string;
  zone: ZoneId;
  tour?: {
    id: string;
    operator?: string;
    /** Цена за единицу по правилу брони; нет — смотри `price_missing`. */
    price?: number;
    unit?: string;
    price_missing?: string;
    /** Ближайшая свободная дата тура в окне поездки. */
    available_date?: string;
  };
  /** День продолжения многодневного тура: цена — в первом дне. */
  continues_tour?: true;
}

export interface PlanForLead {
  v: 1;
  party: { adults: number; children: number[] };
  budget_tier: BudgetTier;
  trip_origin: TripOrigin;
  arrival: string | null;
  days: PlanLeadDay[];
  estimate: {
    people: number;
    total: [number, number];
    per_person: [number, number];
    from_tours: [number, number];
    lines: Array<{ label: string; basis: string; total: [number, number] | null }>;
    unpriced: string[];
  };
  /** Выбранное жильё на стоянки (#2304, шаг 3); нет — не выбирали. */
  lodging?: Array<{
    accommodation_id: string; name: string; zone: ZoneId;
    check_in: string; check_out: string; nights: number;
    /** Цена стоянки на группу по правилу брони; нет — смотри price_note. */
    total?: number; rooms?: number; room?: string; price_note?: string;
  }>;
  /** Выбранные поездки перевозчиков; нет — не выбирали. */
  transfers?: Array<{
    trip_id: string; date: string; from: string; to: string; seats: number;
    price_per_seat?: number; carrier: string;
  }>;
}

function dateOf(arrival: string | null | undefined, day: number): string | null {
  if (!arrival) return null;
  const t = Date.parse(`${arrival.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) || day < 1 ? null : new Date(t + (day - 1) * 86_400_000).toISOString().slice(0, 10);
}

export function planForLead(
  days: PlanLeadInputDay[],
  profile: EstimateProfile & { arrivalDate?: string | null },
  choices?: PlanChoices,
): PlanForLead {
  const est: GroupEstimate = estimateGroup(days, profile, choices);
  return {
    v: 1,
    party: { adults: profile.adults, children: [...profile.children] },
    budget_tier: profile.budgetTier,
    trip_origin: asTripOrigin(profile.tripOrigin),
    arrival: profile.arrivalDate ?? null,
    days: days.map((d): PlanLeadDay => {
      const base: PlanLeadDay = { day: d.day, date: dateOf(profile.arrivalDate, d.day), type: d.type, title: d.title, zone: d.zone };
      if (!d.realTour) return base;
      // Продолжение многодневного тура — без второй цены: она в первом дне.
      if (!d.realPrice && !d.priceMissing) return { ...base, continues_tour: true };
      return {
        ...base,
        tour: {
          id: d.realTour.tourId,
          ...(d.realTour.operatorName ? { operator: d.realTour.operatorName } : {}),
          ...(d.realPrice ? { price: d.realPrice } : {}),
          ...(d.realTour.priceUnit ? { unit: d.realTour.priceUnit } : {}),
          ...(d.priceMissing ? { price_missing: d.priceMissing } : {}),
          ...(d.availableDate ? { available_date: d.availableDate } : {}),
        },
      };
    }),
    estimate: {
      people: est.people,
      total: est.total,
      per_person: est.perPerson,
      from_tours: est.fromTours,
      lines: est.lines.map((l) => ({ label: l.label, basis: l.basis, total: l.total })),
      unpriced: est.unpriced,
    },
    ...(choices && choices.stays.length > 0 ? {
      lodging: choices.stays.map((st) => ({
        accommodation_id: st.accommodationId, name: st.name, zone: st.zone,
        check_in: st.checkIn, check_out: st.checkOut, nights: st.nights,
        ...(st.price?.kind === 'priced'
          ? { total: st.price.total, rooms: st.price.rooms, room: st.price.roomName }
          : { price_note: st.price ? 'группа в один тип номеров не помещается — номера и цену подберёт хозяин' : 'цену на группу назовёт хозяин' }),
      })),
    } : {}),
    ...(choices && choices.transfers.length > 0 ? {
      transfers: choices.transfers.map((t) => ({
        trip_id: t.tripId, date: t.date, from: t.from, to: t.to, seats: t.seats, carrier: t.carrier,
        ...(t.pricePerSeat !== null ? { price_per_seat: t.pricePerSeat } : {}),
      })),
    } : {}),
  };
}

// ── Словами: уведомление и карточка лида ─────────────────────────────────────

const BUDGET_WORD: Record<BudgetTier, string> = { economy: 'эконом', comfort: 'комфорт', premium: 'премиум' };
const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const range = ([a, b]: [number, number]) => (a === b ? rub(a) : `${rub(a)}–${rub(b)}`);
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const plural = (n: number, one: string, few: string, many: string) =>
  (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);

/** Узнать сводку плана в source_data заявки (форма — с версией). */
export function asPlanForLead(v: unknown): PlanForLead | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Partial<PlanForLead>;
  if (p.v !== 1 || !p.party || !Array.isArray(p.days) || !p.estimate) return null;
  return p as PlanForLead;
}

/** Состав группы словами: «2 взр., дети 6, 10 лет». */
export function partyWords(party: PlanForLead['party']): string {
  const kids = party.children.length === 0 ? ''
    : party.children.length === 1 ? `, ребёнок ${party.children[0]} лет` : `, дети ${party.children.join(', ')} лет`;
  return `${party.adults} взр.${kids}`;
}

/** Тур дня словами: «Тур «Х» (ID12), Оператор, 13 000 ₽/чел., свободно с 03.08». */
export function tourWords(d: PlanLeadDay): string | null {
  if (!d.tour) return null;
  const price = d.tour.price_missing
    ? 'цену называет оператор'
    : d.tour.price
      ? `${rub(d.tour.price)}${(d.tour.unit && PRICE_UNIT_SHORT[d.tour.unit]) || ', за что — не записано'}`
      : null;
  return [
    `«${d.title}» (ID${d.tour.id})`,
    d.tour.operator,
    price,
    d.tour.available_date ? `свободно с ${ddmm(d.tour.available_date)}` : null,
  ].filter(Boolean).join(', ');
}

/** Строки для человека: состав, смета, туры по дням. */
export function planLeadLines(plan: PlanForLead): string[] {
  const lines = [
    `Группа: ${partyWords(plan.party)} · уровень «${BUDGET_WORD[plan.budget_tier] ?? plan.budget_tier}»`,
    `Смета: ${range(plan.estimate.total)} на группу (${range(plan.estimate.per_person)} на человека)`
      + (plan.estimate.unpriced.length > 0 ? ` · без цены: ${plan.estimate.unpriced.length}` : ''),
  ];
  for (const d of plan.days) {
    const t = tourWords(d);
    if (t) lines.push(`День ${d.day}${d.date ? ` (${ddmm(d.date)})` : ''}: ${t}`);
  }
  for (const l of plan.lodging ?? []) {
    const price = l.total !== undefined && l.rooms !== undefined
      ? `${l.rooms} ${plural(l.rooms, 'номер', 'номера', 'номеров')} «${l.room}», ${rub(l.total)}`
      : l.price_note ?? 'цену назовёт хозяин';
    lines.push(`Жильё: «${l.name}», ${ddmm(l.check_in)}–${ddmm(l.check_out)} `
      + `(${l.nights} ${plural(l.nights, 'ночь', 'ночи', 'ночей')}), ${price}`);
  }
  for (const t of plan.transfers ?? []) {
    const seats = `${t.seats} ${plural(t.seats, 'место', 'места', 'мест')}`;
    const price = t.price_per_seat !== undefined ? `${seats} × ${rub(t.price_per_seat)}` : `${seats}, цену назовёт перевозчик`;
    lines.push(`Трансфер: ${t.from} — ${t.to}, ${ddmm(t.date)}, ${price} (${t.carrier})`);
  }
  return lines;
}

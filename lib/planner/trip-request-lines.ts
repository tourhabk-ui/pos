/**
 * lib/planner/trip-request-lines.ts — что уходит в заявке из /planner, словами
 * (проверка сценариев 07.11).
 *
 * Человек выбрал в планировщике 10–17 июля, двоих взрослых и «укачивает на
 * воде — без катеров», открыл форму «Запросить подробное предложение» — и не
 * увидел ни одного из этих параметров, а поле пожеланий было пустым. По коду:
 * - галочка «без катеров» и режим риска в заявку не писались вовсе;
 * - состав группы уходил только внутри плана: на шаге «не знаю, что
 *   выбрать» заявка шла без него;
 * - оператор, получивший заявку напоминанием, видел имя, телефон, интересы и
 *   даты — без группы, плана и пожеланий.
 *
 * Здесь два правила, общие для всех поверхностей:
 * - `plannerLeadSource` — что форма отправляет (`source_data`);
 * - `tripRequestLines` — те же данные словами. Их рисует сводка в форме, и они
 *   же уходят менеджеру, оператору и в напоминание. Что человек видел перед
 *   отправкой, то и получил оператор: строки собирает одна функция из одного
 *   объекта.
 *
 * Персональных данных здесь нет: имя и телефон живут в своих колонках заявки.
 * Заметка о здоровье сюда не попадает намеренно — она остаётся в движке
 * (сторож planner-health-stays-local), и сводка говорит об этом прямо.
 */
import { asPlanForLead, partyWords, planLeadLines, type PlanForLead } from '@/lib/planner/plan-for-lead';

export type RiskMode = 'safe_only' | 'adventure' | 'available';

/** Пожелания из анкеты планировщика. Нет поля — не записано (заявка до 07.11). */
export interface TripWishes {
  /** «Укачивает на воде — обойтись без катеров, где можно». */
  seasickness: boolean;
  risk_mode: RiskMode;
}

/** Состав группы: взрослые и известные возраста детей; детей без возраста — числом. */
export interface TripParty {
  adults: number;
  children: number[];
  children_age_unknown?: number;
}

/** Поля `source_data`, которые заявка из /planner несёт о поездке. */
export interface TripRequestFacts {
  arrival?: string | null;
  departure?: string | null;
  trip_days?: number | null;
  party?: TripParty | null;
  wishes?: TripWishes | null;
  plan?: PlanForLead | null;
}

const RISK_WORDS: Record<RiskMode, string> = {
  safe_only: 'только проверенные места, без тревог',
  adventure: 'все маршруты, включая опасные',
  available: 'всё, где есть места',
};

/** Пожелания словами; ничего не отмечено сверх обычного — null. */
export function wishesWords(w: TripWishes | null | undefined): string | null {
  if (!w) return null;
  const parts = [
    w.seasickness ? 'укачивает на воде — без катеров, где можно' : null,
    // Обычный режим не называется: «только проверенные» — то, что по умолчанию.
    w.risk_mode && w.risk_mode !== 'safe_only' ? `режим: ${RISK_WORDS[w.risk_mode]}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : null;
}

/** Состав словами: «2 взр., дети 6, 10 лет; ещё ребёнок, возраст не указан». */
export function tripPartyWords(p: TripParty): string {
  const base = partyWords({ adults: p.adults, children: p.children });
  const unknown = p.children_age_unknown ?? 0;
  if (unknown <= 0) return base;
  return `${base}; ещё ${unknown === 1 ? 'ребёнок' : `детей: ${unknown}`}, возраст не указан`;
}

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Узнать пожелания в `source_data` (форма — с полями обоих видов). */
export function asTripWishes(v: unknown): TripWishes | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Partial<TripWishes>;
  if (typeof w.seasickness !== 'boolean') return null;
  const risk = w.risk_mode === 'adventure' || w.risk_mode === 'available' ? w.risk_mode : 'safe_only';
  return { seasickness: w.seasickness, risk_mode: risk };
}

/** Узнать состав группы в `source_data`. */
export function asTripParty(v: unknown): TripParty | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Partial<TripParty>;
  if (typeof p.adults !== 'number' || !Array.isArray(p.children)) return null;
  const children = p.children.filter((a): a is number => typeof a === 'number');
  const unknown = typeof p.children_age_unknown === 'number' && p.children_age_unknown > 0 ? p.children_age_unknown : 0;
  return { adults: p.adults, children, ...(unknown > 0 ? { children_age_unknown: unknown } : {}) };
}

/** Факты поездки из `source_data` любой заявки; чего нет — того нет. */
export function tripFactsOf(sd: unknown): TripRequestFacts {
  if (!sd || typeof sd !== 'object') return {};
  const o = sd as Record<string, unknown>;
  // Дата — только в виде ГГГГ-ММ-ДД, как её пишут все производители заявки
  // (так же судит CRM, lib/crm/inbox-sql). Строки уходят и в заглушку
  // Telegram, а `source_data` публичной формы — свободный ввод: телефон в
  // поле даты не должен дойти туда даже обрывками.
  const date = (k: string) => (typeof o[k] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(o[k] as string) ? (o[k] as string).slice(0, 10) : null);
  return {
    arrival: date('arrival') ?? date('date_from'),
    departure: date('departure') ?? date('date_to'),
    trip_days: typeof o.trip_days === 'number' ? o.trip_days : null,
    party: asTripParty(o.party),
    wishes: asTripWishes(o.wishes),
    plan: asPlanForLead(o.plan),
  };
}

/** Строка вместо плана, который не прочитался: план в заявке есть, но смотреть его — в карточке. */
export const PLAN_UNREADABLE = 'План: не прочитался — смотрите заявку в кабинете';

/**
 * Поездка словами: даты, группа, пожелания, план. Группа — из плана, если он
 * есть (там ещё уровень жилья), иначе отдельной строкой.
 */
export function tripRequestLines(f: TripRequestFacts): string[] {
  const lines: string[] = [];
  if (f.arrival || f.departure) {
    const from = f.arrival ? ddmmyyyy(f.arrival) : '?';
    const to = f.departure ? ddmmyyyy(f.departure) : '?';
    lines.push(`Даты: ${from} — ${to}${f.trip_days ? ` (${f.trip_days} дн.)` : ''}`);
  }
  if (!f.plan && f.party) lines.push(`Группа: ${tripPartyWords(f.party)}`);
  const wishes = wishesWords(f.wishes);
  if (wishes) lines.push(`Пожелания из анкеты: ${wishes}`);
  if (f.plan) {
    // План приходит в `source_data` публичной формы, а `asPlanForLead`
    // проверяет только каркас. Неполный план не должен ронять тех, кто
    // печатает строки: крон напоминаний прервался бы на этой заявке, и
    // напоминания о прочих перестали бы уходить (ревью PR #3133).
    try {
      lines.push(...planLeadLines(f.plan));
    } catch (err) {
      console.error('[trip-request-lines] план заявки не прочитался:', err instanceof Error ? err.message : String(err));
      lines.push(PLAN_UNREADABLE);
    }
  }
  return lines;
}

export interface PlannerLeadInput {
  interests: string[];
  arrival: string;
  departure: string;
  flightArrival?: string;
  flightDeparture?: string;
  flightArrivalTime?: string;
  flightDepartureTime?: string;
  tripDays: number | null;
  transportByDay: unknown;
  adults: number;
  /** Возраст каждого ребёнка; null — не указан. */
  childAges: Array<number | null>;
  seasickness: boolean;
  riskMode: RiskMode;
  plan: PlanForLead | null;
}

/**
 * `source_data` заявки из /planner. Состав и пожелания — всегда, не только с
 * планом; заметки о здоровье здесь нет и быть не должно.
 */
export function plannerLeadSource(i: PlannerLeadInput): Record<string, unknown> {
  const known = i.childAges.filter((a): a is number => a !== null);
  const unknown = i.childAges.length - known.length;
  return {
    // `trip_planner` — имя, которое знают оценка лида (+15) и подписи
    // админки и Телеграма.
    source: 'trip_planner',
    interests: i.interests,
    arrival: i.arrival || undefined,
    departure: i.departure || undefined,
    flight_arrival: i.flightArrival || undefined,
    flight_departure: i.flightDeparture || undefined,
    flight_arrival_time: i.flightArrivalTime || undefined,
    flight_departure_time: i.flightDepartureTime || undefined,
    trip_days: i.tripDays ?? undefined,
    transport_choices: i.transportByDay,
    party: { adults: i.adults, children: known, ...(unknown > 0 ? { children_age_unknown: unknown } : {}) } satisfies TripParty,
    wishes: { seasickness: i.seasickness, risk_mode: i.riskMode } satisfies TripWishes,
    ...(i.plan ? { plan: i.plan } : {}),
  };
}

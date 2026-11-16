/**
 * lib/planner/form-draft.ts — черновик анкеты планера на устройстве человека
 * (#3347, п. 10; слово владельца 15.11: «Да, без заметок о здоровье»).
 *
 * До этого перезагрузка страницы теряла анкету целиком. Теперь она лежит в
 * localStorage этого браузера и возвращается при следующем открытии /planner.
 *
 * Что НЕ хранится — по построению, а не по фильтру: в типе черновика нет поля
 * для заметок о здоровье и нет контактов (имя, телефон, комментарий заявки).
 * Сериализация собирает поля поимённо — лишнее поле состояния сюда не попадёт.
 *
 * Это удобство одного зрителя, а не состояние платформы: без localStorage
 * планер работает как раньше. Срок — 30 дней; прошедшие даты не
 * восстанавливаются.
 *
 * Черновик принадлежит аккаунту, а не браузеру (слово владельца 16.11
 * «Сделай правку»): в нём подвижность, морская болезнь, возраст детей и рейсы,
 * а устройство бывает общим. Поэтому:
 * - запись несёт id вошедшего (`owner`), и чтение отдаёт черновик только ему
 *   же — чужой, без владельца или при неизвестном вошедшем не возвращается.
 *   Это закрывает и сессию, истёкшую без «Выйти», и вход другим аккаунтом
 *   поверх чужой сессии;
 * - «Выйти» черновик стирает (`clearFormDraft` из signOut в AuthContext),
 *   чтобы он не лежал на устройстве после ухода хозяина;
 * - уже открытый планер после «Выйти» черновик больше не пишет: в этой вкладке
 *   его останавливает счётчик выходов (`draftSignOutGeneration`), в других —
 *   событие хранилища по ключу `DRAFT_SIGNOUT_KEY` (ревью безопасности PR 3452:
 *   вкладка со старым входом иначе записала бы черновик обратно при первой
 *   правке анкеты).
 */

import { MAX_ADULTS } from '@/lib/planner/party-limits';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

export const FORM_DRAFT_KEY = 'vedar_planner_form_v1';
/** Метка «из аккаунта вышли»: её запись другие вкладки получают событием storage. */
export const DRAFT_SIGNOUT_KEY = 'vedar_planner_signout';

let signOutGeneration = 0;
/** Сколько раз в этой вкладке выходили из аккаунта: планер сверяет с числом при открытии. */
export function draftSignOutGeneration(): number {
  return signOutGeneration;
}
export const FORM_DRAFT_TTL_DAYS = 30;

export type DraftFitness = 'beginner' | 'moderate' | 'active';
export type DraftBudget = 'economy' | 'comfort' | 'premium';
export type DraftMobility = 'full' | 'limited' | 'wheelchair';
export type DraftStyle = 'self' | 'operator' | 'mixed';
export type DraftOrigin = 'visitor' | 'local';

/** Поля анкеты, которые переживают перезагрузку. Здоровья и контактов здесь нет. */
export interface PlannerFormDraft {
  places: string[];
  activities: string[];
  arrival: string;
  departure: string;
  flightArrival: string;
  flightDeparture: string;
  flightArrivalTime: string;
  flightDepartureTime: string;
  needsAirportTransfer: boolean;
  needsLodging: boolean;
  needsCar: boolean;
  adults: number;
  childAges: Array<number | null>;
  fitnessLevel: DraftFitness;
  budgetTier: DraftBudget;
  seasickness: boolean;
  mobilityLevel: DraftMobility;
  travelStyle: DraftStyle;
  tripOrigin: DraftOrigin;
  restDays: number;
  restManual: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T =>
  (typeof v === 'string' && (list as readonly string[]).includes(v) ? v as T : fallback);
const strList = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 64).slice(0, 30) : []);
const short = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const flag = (v: unknown): boolean => v === true;

/** Записать черновик: поля поимённо, с отметкой времени и id владельца. */
export function serializeFormDraft(d: PlannerFormDraft, owner: string, now: Date = new Date()): string {
  const picked: PlannerFormDraft = {
    places: d.places, activities: d.activities,
    arrival: d.arrival, departure: d.departure,
    flightArrival: d.flightArrival, flightDeparture: d.flightDeparture,
    flightArrivalTime: d.flightArrivalTime, flightDepartureTime: d.flightDepartureTime,
    needsAirportTransfer: d.needsAirportTransfer, needsLodging: d.needsLodging, needsCar: d.needsCar,
    adults: d.adults, childAges: d.childAges,
    fitnessLevel: d.fitnessLevel, budgetTier: d.budgetTier, seasickness: d.seasickness,
    mobilityLevel: d.mobilityLevel, travelStyle: d.travelStyle, tripOrigin: d.tripOrigin,
    restDays: d.restDays, restManual: d.restManual,
  };
  return JSON.stringify({ savedAt: now.toISOString(), owner, draft: picked });
}

/**
 * Прочитать черновик. Битый, чужой формы, старше срока или другого владельца
 * — null. Пустой `owner` (вошедший неизвестен) черновика не открывает. Даты в
 * прошлом (`today` — по Камчатке, YYYY-MM-DD) не восстанавливаются: план на
 * прошедшее число был бы ловушкой.
 */
export function parseFormDraft(
  raw: string | null, today: string, owner: string | null | undefined, now: Date = new Date(),
): PlannerFormDraft | null {
  if (!raw || !owner) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const { savedAt, draft, owner: savedOwner } = parsed as { savedAt?: unknown; draft?: unknown; owner?: unknown };
  if (typeof savedAt !== 'string' || !draft || typeof draft !== 'object') return null;
  if (savedOwner !== owner) return null;
  const saved = Date.parse(savedAt);
  if (Number.isNaN(saved) || now.getTime() - saved > FORM_DRAFT_TTL_DAYS * 86400000) return null;
  const d = draft as Record<string, unknown>;

  const arrival = typeof d.arrival === 'string' && ISO_DATE.test(d.arrival) && d.arrival >= today ? d.arrival : '';
  const departure = arrival && typeof d.departure === 'string' && ISO_DATE.test(d.departure) && d.departure >= arrival ? d.departure : '';
  const adults = typeof d.adults === 'number' && Number.isInteger(d.adults) && d.adults >= 1 && d.adults <= MAX_ADULTS ? d.adults : 2;
  const childAges = Array.isArray(d.childAges)
    ? d.childAges.slice(0, 4).map((a) => (typeof a === 'number' && Number.isInteger(a) && a >= 0 && a <= 17 ? a : null))
    : [];
  const restDays = typeof d.restDays === 'number' && Number.isInteger(d.restDays) && d.restDays >= 0 && d.restDays <= 10 ? d.restDays : 0;

  return {
    places: strList(d.places),
    activities: strList(d.activities),
    arrival,
    departure,
    flightArrival: short(d.flightArrival, 16),
    flightDeparture: short(d.flightDeparture, 16),
    flightArrivalTime: typeof d.flightArrivalTime === 'string' && TIME.test(d.flightArrivalTime) ? d.flightArrivalTime : '',
    flightDepartureTime: typeof d.flightDepartureTime === 'string' && TIME.test(d.flightDepartureTime) ? d.flightDepartureTime : '',
    needsAirportTransfer: flag(d.needsAirportTransfer),
    needsLodging: flag(d.needsLodging),
    needsCar: flag(d.needsCar),
    adults,
    childAges,
    fitnessLevel: oneOf(d.fitnessLevel, ['beginner', 'moderate', 'active'] as const, 'moderate'),
    budgetTier: oneOf(d.budgetTier, ['economy', 'comfort', 'premium'] as const, 'comfort'),
    seasickness: flag(d.seasickness),
    mobilityLevel: oneOf(d.mobilityLevel, ['full', 'limited', 'wheelchair'] as const, 'full'),
    travelStyle: oneOf(d.travelStyle, ['self', 'operator', 'mixed'] as const, 'mixed'),
    tripOrigin: oneOf(d.tripOrigin, ['visitor', 'local'] as const, 'visitor'),
    restDays,
    restManual: flag(d.restManual),
  };
}

/**
 * Стереть черновик с этого устройства. Отказ хранилища не роняет вызывающего
 * (выход из аккаунта не должен ломаться из-за черновика), но и не молчит.
 */
export function clearFormDraft(): void {
  signOutGeneration += 1;
  if (typeof localStorage === 'undefined') return;
  try { localStorage.removeItem(FORM_DRAFT_KEY); } catch (err) {
    logSwallowedFailure('planner-form-draft', 'стирание черновика анкеты при выходе', err);
  }
  // Новое значение каждый раз: одинаковая запись события storage не даёт.
  try { localStorage.setItem(DRAFT_SIGNOUT_KEY, `${Date.now()}-${signOutGeneration}`); } catch (err) {
    logSwallowedFailure('planner-form-draft', 'метка выхода для других вкладок', err);
  }
}

/** Пустая анкета — как при первом открытии: «Начать заново». */
export const EMPTY_FORM_DRAFT: PlannerFormDraft = {
  places: [], activities: [], arrival: '', departure: '',
  flightArrival: '', flightDeparture: '', flightArrivalTime: '', flightDepartureTime: '',
  needsAirportTransfer: false, needsLodging: false, needsCar: false,
  adults: 2, childAges: [], fitnessLevel: 'moderate', budgetTier: 'comfort', seasickness: false,
  mobilityLevel: 'full', travelStyle: 'mixed', tripOrigin: 'visitor', restDays: 0, restManual: false,
};

/** Ссылка привела человека с уже названным выбором — черновик его не перебивает. */
export const LINK_PARAMS = ['interests', 'hint', 'mood', 'days', 'from', 'adults', 'children'] as const;
export function linkCarriesForm(params: { get(name: string): string | null }): boolean {
  return LINK_PARAMS.some((p) => params.get(p) !== null);
}

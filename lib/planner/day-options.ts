/**
 * lib/planner/day-options.ts — «Сравнить и заменить» день плана (супер-планер,
 * 22.11, слово владельца «нужно лучше чем на taaft»).
 *
 * У дня с туром на экране — другие туры того же вида на ту же дату, рядом с
 * текущим, и у каждого честные «за» и «против»: цена на группу, набор группы,
 * места на дату, погодный риск, оператор. Кнопка «Поставить» кладёт тур в
 * день; цена и места нового тура перечитываются на дату тем же путём, что
 * после перестановки дней (lib/planner/tour-day-apply), смета пересчитывается.
 *
 * Чего не знаем — так и сказано (§4.0): места не прочитались — «не прочитали»,
 * у тура нет календаря — «дату подтвердит оператор», минимума группы нет в
 * записи — «не указан». Варианты идут правилом 1в (lib/tours/offer-order), не
 * «дешевле выше». Заявка — не бронь.
 *
 * Чистый модуль: его читают экран и тесты, базы он не трогает.
 */
import { parseTourDayRead, type TourDayRead } from './tour-day-apply';
import { TOUR_PRICE_PENDING_TEXT } from './calendar-days';
import { tourGroupCost } from './estimate';
import { withGroupMinimum } from './group-minimum';
import { tourGroup } from './plan-ops';
import { ACTIVITY_CONSTRAINTS, normalizeActivity, type TransportType } from './constants';
import { weatherKindOfActivity, WEATHER_KIND_SHORT } from './weather-plan-b';
import { weatherKitLine } from './weather-kit';

/** Вариант дня — как его отдаёт GET /api/planner/day-options. */
export interface DayOption {
  id: string;
  title: string;
  shortDescription: string | null;
  activityType: string;
  operatorName: string;
  operatorSlug: string;
  /** Заголовочная цена тура; null — не записана. */
  basePrice: number | null;
  priceUnit: string | null;
  minParticipants: number | null;
  maxParticipants: number | null;
  /** Ведёт ли тур календарь выездов: `request` — дату подтверждает оператор. */
  calendar: 'dated' | 'request';
  /** Тур не из зоны дня (в зоне подходящих нет) — нужен переезд. */
  otherZone: boolean;
  coords: [number, number] | null;
  /** Сложность тура из карточки оператора (easy|moderate|hard); null — не указана. */
  difficulty?: string | null;
  /** Места и цена на дату дня для группы; null — не прочитали. */
  read: TourDayRead | null;
}

export type FactTone = 'pro' | 'con' | 'info';
export interface OptionFact { tone: FactTone; text: string }

/** День плана в том объёме, что нужен сравнению. */
export interface CompareDay {
  day: number;
  type: string;
  title: string;
  description: string;
  activityType: string;
  zone: string;
  coords: [number, number];
  priceFrom: number;
  priceTo: number;
  realPrice?: number;
  priceMissing?: string;
  availability?: 'open' | 'none' | 'unread';
  availabilityCheckedAt?: string;
  availableDate?: string;
  slotsRemaining?: number;
  capacityWarning?: string;
  dayWarnings: string[];
  activityMode?: 'operator' | 'self' | 'open';
  routeId?: string;
  placeHref?: string;
  realTour?: {
    tourId: string;
    operatorName?: string;
    operatorSlug?: string;
    priceUnit?: string;
    maxParticipants?: number;
    minParticipants?: number;
    weatherDependent?: boolean;
    durationDays?: number;
    lodgingIncluded: boolean | null;
    calendar?: 'dated' | 'request';
    priceLabel?: string;
  };
  defaultTransport?: TransportType;
  allowedTransports?: TransportType[];
  difficulty?: 'easy' | 'moderate' | 'hard';
  childFriendly?: boolean;
  minChildAge?: number;
  weatherForecast?: Parameters<typeof weatherKitLine>[0];
  weatherKit?: string;
}

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU').replace(/\u00a0/g, ' ');

/** Сумма тура на группу по правилу брони; null — цены нет или единица не распознана. */
export function groupTotal(unitPrice: number | null | undefined, priceUnit: string | null | undefined, people: number, maxParticipants?: number | null): number | null {
  if (typeof unitPrice !== 'number' || !(unitPrice > 0)) return null;
  const cost = tourGroupCost({ unitPrice, priceUnit, people, maxParticipants: maxParticipants ?? undefined, tourDays: 1 });
  return cost ? cost.total : null;
}

/** Сумма текущего тура дня на группу; null — не посчитана. */
export function currentDayTotal(day: CompareDay, people: number): number | null {
  if (!day.realTour || day.priceMissing) return null;
  return groupTotal(day.realPrice ?? null, day.realTour.priceUnit, people, day.realTour.maxParticipants);
}

/** Сумма варианта на группу на дату дня; null — не посчитана. */
export function optionTotal(o: DayOption, people: number): number | null {
  if (!o.read || o.read.priceMissing) return null;
  return groupTotal(o.read.realPrice ?? null, o.priceUnit, people, o.maxParticipants);
}

/** Строка о местах на дату — три исхода и тур без календаря. */
function seatsFact(availability: 'open' | 'none' | 'unread' | undefined, calendar: 'dated' | 'request' | undefined, remaining?: number): OptionFact {
  if (calendar === 'request') return { tone: 'info', text: 'Календаря выездов нет — дату подтвердит оператор по заявке' };
  if (availability === 'open') return { tone: 'pro', text: typeof remaining === 'number' ? `На эту дату есть места (свободно ${remaining})` : 'На эту дату есть места' };
  if (availability === 'none') return { tone: 'con', text: 'На эту дату свободных мест нет' };
  return { tone: 'info', text: 'Места на дату не прочитали — уточните у оператора' };
}

/** Строка о наборе группы. */
function groupFact(min: number | null | undefined, people: number): OptionFact {
  if (typeof min !== 'number' || !Number.isFinite(min) || min <= 1) {
    return min === 1 || min === 0 ? { tone: 'pro', text: 'Выезд и для одного человека' } : { tone: 'info', text: 'Минимум группы оператор не указал' };
  }
  return people >= min
    ? { tone: 'pro', text: `Выезд от ${min} чел. — ваша группа проходит` }
    : { tone: 'con', text: `Нужен набор от ${min} чел., вас ${people} — выезд подтверждает оператор` };
}

/** Строка о погоде по виду занятия. */
function weatherFact(activityType: string, title: string): OptionFact {
  const kind = weatherKindOfActivity(activityType, title);
  return kind
    ? { tone: 'con', text: `Зависит от погоды: ${WEATHER_KIND_SHORT[kind]}` }
    : { tone: 'pro', text: 'Не вертолёт и не море — от лётной и морской погоды не зависит' };
}

/** «за» и «против» варианта — рядом с текущим туром дня. */
export function optionFacts(o: DayOption, current: CompareDay, people: number): OptionFact[] {
  const facts: OptionFact[] = [];
  const total = optionTotal(o, people);
  const now = currentDayTotal(current, people);
  if (total === null) {
    facts.push({ tone: 'info', text: o.read?.priceMissing ?? 'Цену на эту дату не посчитали — назовёт оператор' });
  } else if (now === null) {
    facts.push({ tone: 'info', text: `${fmt(total)} ₽ на группу` });
  } else if (total < now) {
    facts.push({ tone: 'pro', text: `${fmt(total)} ₽ на группу — дешевле на ${fmt(now - total)} ₽` });
  } else if (total > now) {
    facts.push({ tone: 'con', text: `${fmt(total)} ₽ на группу — дороже на ${fmt(total - now)} ₽` });
  } else {
    facts.push({ tone: 'info', text: `${fmt(total)} ₽ на группу — столько же` });
  }
  facts.push(seatsFact(o.read?.availability, o.calendar, o.read?.slotsRemaining));
  if (o.read?.capacityWarning) facts.push({ tone: 'con', text: o.read.capacityWarning });
  facts.push(groupFact(o.minParticipants, people));
  facts.push(weatherFact(o.activityType, o.title));
  if (o.otherZone) facts.push({ tone: 'con', text: 'Тур в другой зоне — понадобится переезд' });
  facts.push({ tone: 'info', text: `Оператор: ${o.operatorName}` });
  return facts;
}

/** Факты текущего тура дня — тем же словарём, чтобы сравнивать строка к строке. */
export function currentFacts(day: CompareDay, people: number): OptionFact[] {
  const facts: OptionFact[] = [];
  const total = currentDayTotal(day, people);
  facts.push(total === null
    ? { tone: 'info', text: day.priceMissing ?? 'Цену на эту дату не посчитали — назовёт оператор' }
    : { tone: 'info', text: `${fmt(total)} ₽ на группу` });
  facts.push(seatsFact(day.availability, day.realTour?.calendar, day.slotsRemaining));
  if (day.capacityWarning) facts.push({ tone: 'con', text: day.capacityWarning });
  facts.push(groupFact(day.realTour?.minParticipants, people));
  facts.push(weatherFact(day.activityType, day.title));
  if (day.realTour?.operatorName) facts.push({ tone: 'info', text: `Оператор: ${day.realTour.operatorName}` });
  return facts;
}

/**
 * Можно ли сравнивать и менять тур дня: только день с туром на один день.
 * День многодневного тура заменяется целиком — правкой плана, не здесь.
 * null — можно; иначе причина словами.
 */
/** День многодневного тура: замена одного его дня разорвала бы тур. */
export function isMultiDayTourDay<T extends CompareDay>(days: readonly T[], day: T): boolean {
  return !!day.realTour && tourGroup(days, day).length > 1;
}

/** Ограничения вида занятия не известны движку — строка в предупреждениях дня. */
export const OPTION_LIMITS_UNKNOWN = 'Транспорт, сложность и возраст для этого тура уточните у оператора.';

export function compareRefusal<T extends CompareDay>(days: readonly T[], day: T): string | null {
  if (day.type !== 'activity' || !day.realTour) return 'В этот день нет тура — сравнивать не с чем';
  if (isMultiDayTourDay(days, day)) return 'Тур на несколько дней — замена целиком через правку плана';
  return null;
}

/**
 * День с поставленным вариантом. Цена и места нового тура — «ещё не
 * перечитали»: экран спрашивает их на дату дня (tour-day-apply), до ответа
 * смета тур не складывает. Предупреждения прежнего тура снимаются, строка
 * о наборе группы — новая.
 */
export function dayWithOption<T extends CompareDay>(day: T, o: DayOption, people: number, youngestChild: number | null = null): T {
  const next = { ...day } as T;
  delete next.realPrice;
  delete next.availability;
  delete next.availabilityCheckedAt;
  delete next.availableDate;
  delete next.slotsRemaining;
  delete next.capacityWarning;
  delete next.routeId;
  delete next.placeHref;
  next.title = o.title;
  next.description = o.shortDescription ?? '';
  next.activityType = normalizeActivity(o.activityType);
  next.activityMode = 'operator';
  if (o.coords) next.coords = o.coords;
  next.priceFrom = o.basePrice ?? 0;
  next.priceTo = o.basePrice ?? 0;
  next.priceMissing = TOUR_PRICE_PENDING_TEXT;
  next.realTour = {
    tourId: o.id,
    operatorName: o.operatorName,
    operatorSlug: o.operatorSlug,
    ...(o.priceUnit ? { priceUnit: o.priceUnit } : {}),
    ...(o.maxParticipants ? { maxParticipants: o.maxParticipants } : {}),
    ...(typeof o.minParticipants === 'number' ? { minParticipants: o.minParticipants } : {}),
    durationDays: 1,
    lodgingIncluded: null,
    calendar: o.calendar,
  };
  // Транспорт, сложность, возраст — нового тура, а не прежнего (ревью #3708):
  // по виду занятия, как у движка; сложность — из карточки тура, если указана.
  const c = ACTIVITY_CONSTRAINTS[next.activityType];
  const ownDifficulty = o.difficulty === 'easy' || o.difficulty === 'moderate' || o.difficulty === 'hard' ? o.difficulty : null;
  const warnings: string[] = [];
  if (c) {
    const allowed = [...c.allowedTransports];
    next.allowedTransports = allowed;
    next.defaultTransport = c.requiredTransport ?? (allowed.includes(c.defaultTransport) ? c.defaultTransport : allowed[0] ?? 'walking');
    next.difficulty = ownDifficulty ?? c.difficulty;
    next.minChildAge = c.minChildAge;
    next.childFriendly = youngestChild === null || youngestChild >= c.minChildAge;
    if (youngestChild !== null && youngestChild < c.minChildAge) {
      warnings.push(`Такие туры обычно — с ${c.minChildAge} лет, младшему ${youngestChild}: возраст подтверждает оператор.`);
    }
  } else {
    next.allowedTransports = ['walking'];
    next.defaultTransport = 'walking';
    if (ownDifficulty) next.difficulty = ownDifficulty;
    next.minChildAge = 0;
    warnings.push(OPTION_LIMITS_UNKNOWN);
  }
  next.dayWarnings = withGroupMinimum(warnings, o.minParticipants, people);
  // Совет по одежде — под новое занятие, по прогнозу этой даты (ревью #3708).
  const kit = next.weatherForecast ? weatherKitLine(next.weatherForecast, next.activityType) : null;
  if (kit) next.weatherKit = kit; else delete next.weatherKit;
  return next;
}

/** Ответ GET /api/planner/day-options — форма проверяется; не та — неответ (null). */
export function parseDayOptions(body: unknown): { options: DayOption[]; orderNote: string | null } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { success?: unknown; options?: unknown; orderNote?: unknown };
  if (b.success !== true || !Array.isArray(b.options)) return null;
  const options: DayOption[] = [];
  for (const raw of b.options) {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.title !== 'string' || typeof o.operatorName !== 'string') return null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const coords = Array.isArray(o.coords) && o.coords.length === 2 && o.coords.every((c) => typeof c === 'number' && Number.isFinite(c))
      ? [o.coords[0] as number, o.coords[1] as number] as [number, number] : null;
    options.push({
      id: o.id,
      title: o.title,
      shortDescription: typeof o.shortDescription === 'string' ? o.shortDescription : null,
      activityType: typeof o.activityType === 'string' ? o.activityType : '',
      operatorName: o.operatorName,
      operatorSlug: typeof o.operatorSlug === 'string' ? o.operatorSlug : '',
      basePrice: num(o.basePrice),
      priceUnit: typeof o.priceUnit === 'string' ? o.priceUnit : null,
      minParticipants: num(o.minParticipants),
      maxParticipants: num(o.maxParticipants),
      calendar: o.calendar === 'dated' ? 'dated' : 'request',
      otherZone: o.otherZone === true,
      coords,
      difficulty: typeof o.difficulty === 'string' ? o.difficulty : null,
      read: o.read ? parseTourDayRead({ success: true, read: o.read }) : null,
    });
  }
  return { options, orderNote: typeof b.orderNote === 'string' ? b.orderNote : null };
}

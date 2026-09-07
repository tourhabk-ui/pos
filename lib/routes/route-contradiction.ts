/**
 * lib/routes/route-contradiction.ts — противоречия ВНУТРИ записи маршрута.
 *
 * ── Зачем ─────────────────────────────────────────────────────────────────
 *
 * Разбор корпуса 07.09 (`route-analysis`, 33 находки) показал пять карточек,
 * которые обещают темп, которого не бывает:
 *
 *   Подножье Козельского   — треккинг, 80 км за 4 ч   (20 км/ч пешком)
 *   Озеро Тёплое           — треккинг, 44 км за 3 ч   (14.7 км/ч)
 *   Центральный–Таловские  — 12 км за 1 ч по бродам   (12 км/ч)
 *   Гора Юрчик             — «без подготовки, +300 м» против 1000 м в поле
 *   К озеру Зеленому       — «до 150 м» против 560 м, час, зима, лавины
 *
 * Каждую нашла модель за 600 ₽ и за один прогон. Но арифметика в них
 * школьная: расстояние делить на время. Значит находка не должна стоить
 * прогона и не должна ждать следующего — правило обязано быть в коде, и
 * новая такая запись обязана краснеть сама.
 *
 * ── Что здесь НЕ делается ─────────────────────────────────────────────────
 *
 * Судья не чинит данные и не решает, какое из двух чисел верное. Из «80 км
 * за 4 часа» не следует, что неверна длина: могли смешать пеший участок с
 * трансфером, и тогда неверно ВСЁ описание, а не одно поле. Выбор правды —
 * решение человека; здесь только доказательство, что правды в записи нет.
 *
 * ── Пороги названы, а не подобраны ────────────────────────────────────────
 *
 * Потолок скорости — не «быстро», а «заведомо неправда». Марафон по асфальту
 * бегут около 20 км/ч; по камчатской тропе с рюкзаком 6 км/ч — уже быстрый
 * темп. Порог 8 км/ч ставит границу так, что ниже неё ошибок не ловим вовсе,
 * зато выше — только настоящие. Ошибиться в сторону «не сужу» дёшево, в
 * обратную — нет: карточка, которую сняли зря, стоит недоверия, а карточка,
 * обещающая 20 км/ч пешком, стоит человека в поле.
 *
 * Способ передвижения берётся у `lib/routes/travel-mode` — своего
 * классификатора здесь нет и заводить его нельзя (§12: правило, написанное
 * дважды, — это два правила, и они разойдутся).
 */
import { detectTravelMode, type TravelMode } from './travel-mode';

export type ContradictionKind =
  /** Расстояние и время дают темп, которого у этого способа не бывает. */
  | 'impossible_pace'
  /** Сезон записи несовместим с её же родом активности. */
  | 'season_conflict'
  /** Набор высоты в описании и в поле расходятся кратно. */
  | 'elevation_conflict'
  /** Длина в описании и в поле расходятся кратно. */
  | 'distance_conflict';

export interface Contradiction {
  kind: ContradictionKind;
  /** Одна фраза, годная человеку. */
  what: string;
  /** Дословно из полей записи — чтобы не верить на слово. */
  evidence: string;
}

export interface RouteFacts {
  title: string | null;
  activityType: string | null;
  season: string | null;
  distanceKm: number | null;
  durationHours: number | null;
  elevationGainM: number | null;
  description: string | null;
}

/**
 * Потолок скорости по способу передвижения, км/ч.
 *
 * `null` — вопрос не наш: линию воздуха и моря не проходят (см. travel-mode),
 * скорость там задаёт пилот или капитан, и «медленно» для катера ничего не
 * значит.
 */
const PACE_CEILING: Record<TravelMode, number | null> = {
  foot: 8,
  water: 12,
  snow: 30,
  vehicle: 60,
  air: null,
  sea: null,
};

/** Во сколько раз число в описании должно разойтись с полем, чтобы судить. */
const TEXT_VS_FIELD_RATIO = 3;

/** Роды активности, у которых снег обязателен. */
const SNOW_BOUND = /^(ski|skitour|winter_hiking|snowmobile|snowshoe)$/i;
/** Сезоны, несовместимые со снегом. */
const NOT_WINTER = /^(all|summer|spring)$/i;

export type PaceVerdict =
  | { state: 'ok'; kmh: number; ceiling: number }
  | { state: 'contradiction'; kmh: number; ceiling: number; mode: TravelMode }
  /** Третий исход (§4.0): судить не смогли, и это НЕ «всё в порядке». */
  | { state: 'unknown'; why: string };

/**
 * Темп записи: возможен ли он вообще.
 *
 * Ноль и отрицательные значения — не «мгновенно», а отсутствие данных:
 * делить на них нельзя, и выдавать бесконечность за вердикт нельзя тем более.
 */
export function judgePace(facts: RouteFacts): PaceVerdict {
  const { distanceKm, durationHours } = facts;
  if (distanceKm === null || !Number.isFinite(distanceKm) || distanceKm <= 0) {
    return { state: 'unknown', why: 'длина не записана' };
  }
  if (durationHours === null || !Number.isFinite(durationHours) || durationHours <= 0) {
    return { state: 'unknown', why: 'длительность не записана' };
  }
  const mode = detectTravelMode(facts.title, facts.activityType);
  const ceiling = PACE_CEILING[mode];
  if (ceiling === null) {
    return { state: 'unknown', why: `линию не проходят сами (${mode}) — темп задаёт не турист` };
  }
  const kmh = distanceKm / durationHours;
  return kmh > ceiling
    ? { state: 'contradiction', kmh, ceiling, mode }
    : { state: 'ok', kmh, ceiling };
}

/** Первое число нужной размерности, названное в тексте описания. */
function firstNumber(text: string, re: RegExp): number | null {
  const m = re.exec(text);
  if (!m) return null;
  const raw = m[1].replace(',', '.');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** «набор высоты — примерно 300 метров», «набор высоты незначительный (до 150 метров)» */
const ELEVATION_IN_TEXT = /набор[а-я]*\s+высоты[^.]{0,60}?(\d{2,4})\s*(?:м\b|метр)/i;
/** «протяженностью около 12 километров», «Протяженность маршрута — 40 км» */
const DISTANCE_IN_TEXT = /прот[яеё]ж[её]нност[а-я]*[^.]{0,60}?(\d{1,4}(?:[.,]\d)?)\s*(?:км\b|килом)/i;

/** Во сколько раз одно число больше другого; оба обязаны быть положительными. */
function ratio(a: number, b: number): number {
  return a > b ? a / b : b / a;
}

/**
 * Все противоречия записи и всё, что судить НЕ ВЫШЛО.
 *
 * `unchecked` — не вежливость, а требование §4.0: место, где нельзя сказать
 * «не знаю», заполняется словом «хорошо». Пустой список противоречий при
 * непустом `unchecked` означает «не нашли», а не «в записи всё верно».
 */
export function judgeRoute(facts: RouteFacts): {
  contradictions: Contradiction[];
  unchecked: string[];
} {
  const contradictions: Contradiction[] = [];
  const unchecked: string[] = [];

  const pace = judgePace(facts);
  if (pace.state === 'contradiction') {
    contradictions.push({
      kind: 'impossible_pace',
      what: `темп ${pace.kmh.toFixed(1)} км/ч — выше возможного для способа «${pace.mode}» (потолок ${pace.ceiling} км/ч)`,
      evidence: `distance_km: ${facts.distanceKm}, duration_hours: ${facts.durationHours}, activity_type: ${facts.activityType ?? 'нет'}`,
    });
  } else if (pace.state === 'unknown') {
    unchecked.push(`темп: ${pace.why}`);
  }

  const activity = (facts.activityType ?? '').trim();
  const season = (facts.season ?? '').trim();
  if (activity === '' || season === '') {
    unchecked.push('сезон: род активности или сезон не записан');
  } else if (SNOW_BOUND.test(activity) && NOT_WINTER.test(season)) {
    contradictions.push({
      kind: 'season_conflict',
      what: `род «${activity}» требует снега, а сезон записан как «${season}»`,
      evidence: `activity_type: ${activity}, season: ${season}`,
    });
  }

  const description = (facts.description ?? '').trim();
  if (description === '') {
    unchecked.push('описание: пусто — сверять поля не с чем');
    return { contradictions, unchecked };
  }

  const saidElevation = firstNumber(description, ELEVATION_IN_TEXT);
  if (saidElevation === null) {
    unchecked.push('набор высоты: в описании не назван');
  } else if (facts.elevationGainM === null || facts.elevationGainM <= 0) {
    unchecked.push('набор высоты: в поле не записан');
  } else if (ratio(saidElevation, facts.elevationGainM) > TEXT_VS_FIELD_RATIO) {
    contradictions.push({
      kind: 'elevation_conflict',
      what: `описание обещает набор ${saidElevation} м, поле говорит ${facts.elevationGainM} м`,
      evidence: `elevation_gain_m: ${facts.elevationGainM}, в описании: «${ELEVATION_IN_TEXT.exec(description)?.[0] ?? ''}»`,
    });
  }

  const saidDistance = firstNumber(description, DISTANCE_IN_TEXT);
  if (saidDistance === null) {
    unchecked.push('длина: в описании не названа');
  } else if (facts.distanceKm === null || facts.distanceKm <= 0) {
    unchecked.push('длина: в поле не записана');
  } else if (ratio(saidDistance, facts.distanceKm) > TEXT_VS_FIELD_RATIO) {
    contradictions.push({
      kind: 'distance_conflict',
      what: `описание обещает ${saidDistance} км, поле говорит ${facts.distanceKm} км`,
      evidence: `distance_km: ${facts.distanceKm}, в описании: «${DISTANCE_IN_TEXT.exec(description)?.[0] ?? ''}»`,
    });
  }

  return { contradictions, unchecked };
}

/**
 * Можно ли показывать пару «длина и время» как факт.
 *
 * Ровно то, ради чего писался судья: экран, где эти два числа стоят рядом,
 * обязан спросить — и промолчать, если они друг другу противоречат. Молчание
 * честнее, чем «80 км за 4 часа» под словом «треккинг».
 */
export function paceIsShowable(facts: RouteFacts): boolean {
  return judgePace(facts).state !== 'contradiction';
}

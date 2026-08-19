/**
 * lib/routes/derived-stages.ts
 *
 * Этапы, ВЫЧИСЛЕННЫЕ по линии, и происхождение каждого из них.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * У половины линий нет ни одной путевой точки. Показать по такому маршруту
 * нечего: страница честно говорит «путь не описан», и человек уходит ни с чем,
 * хотя линия есть и места вдоль неё есть тоже.
 *
 * Найти их можно измерением: место в полусотне метров от линии эта линия
 * проходит. Мера та же, что у переписи предложений (`waypoint-proposals`), и
 * пороги берутся ОТТУДА — второй набор порогов означал бы, что «на линии» на
 * карточке и «на линии» в переписи значат разное.
 *
 * ── Почему это НЕ связь ─────────────────────────────────────────────────────
 *
 * Вычисленный этап никогда не становится записью в `route_waypoints` и никогда
 * не попадает во вход черты. Причина не в осторожности, а в логике: линию
 * поверяют путевыми точками, и если точки получены ИЗ линии, поверка
 * доказывает сама себя. Такой маршрут прошёл бы черту, ничего не доказав, и
 * платформа пообещала бы вести по линии, которую никто не сверял.
 *
 * Отсюда два разных слова:
 *
 *   established — установленная связь. Ею сверяется линия, она судит маршрут
 *   derived     — вычисленный ориентир. Он показывается и НЕ судит ничего
 *
 * Разница видима человеку на экране, а не только в типах: точка, которую
 * платформа нашла сама, и точка, о которой платформа знает, — разные по силе
 * утверждения, и смешивать их на одном списке значит выдать вторую за первую.
 */
import { projectOnTrack, type GeoPoint } from '@/lib/on-route/approach';
import { ON_LINE_KM, NEAR_LINE_KM } from '@/lib/routes/waypoint-proposals';

export { ON_LINE_KM, NEAR_LINE_KM };

/** Откуда взялась точка на экране. */
export type StageOrigin = 'established' | 'derived';

/** Насколько близко к линии лежит вычисленный ориентир. */
export type StageProximity = 'on_line' | 'near_line';

export interface DerivedStage {
  placeId: string;
  name: string;
  locationType: string | null;
  /** Порядок вдоль линии, 0 — ближе к началу. */
  position: number;
  /** Расстояние до линии, км, округлённое до метров. */
  offLineKm: number;
  proximity: StageProximity;
  origin: 'derived';
  /**
   * Почему точка показана — словами, для экрана.
   *
   * Строка живёт здесь, а не в компоненте, потому что объяснение обязано
   * следовать за мерой: изменится порог — изменится и фраза. Разъедься они, и
   * экран начнёт объяснять правило, которого больше нет.
   */
  why: string;
}

export interface DerivedStagesInput {
  /** Линия маршрута; меньше двух точек — вычислять нечего. */
  track: GeoPoint[];
  /** Кандидаты — места с координатами. */
  places: Array<{ id: string; name: string; lat: number; lng: number; locationType?: string | null }>;
  /**
   * Места, у которых уже ЕСТЬ установленная связь с маршрутом.
   *
   * Они исключаются из вычисления: показать одно место дважды — как
   * установленное и как найденное — значит удвоить путь на глазах у идущего.
   */
  establishedPlaceIds?: Iterable<string>;
}

export interface DerivedStagesResult {
  /** Лежащие на линии — ориентиры пути. */
  onLine: DerivedStage[];
  /** Лежащие около линии — не путь, но и не случайность. */
  nearLine: DerivedStage[];
  /**
   * Линия собирает больше мест, чем осмысленно показать.
   *
   * Ничего не отбрасывается: признак ПОМЕЧАЕТ такой набор, чтобы экран сказал
   * человеку «линия идёт через полкрая и цепляет всё по пути», а не показал
   * первую дюжину как весь путь.
   */
  sweeping: boolean;
  /** Пороги, по которым посчитано, — чтобы экран назвал меру, а не повторил её. */
  onLineKm: number;
  nearLineKm: number;
}

/** Больше этого числа ориентиров — линия собирает всё подряд. */
export const SWEEP_LIMIT = 12;

function explain(offLineKm: number, proximity: StageProximity): string {
  const m = Math.round(offLineKm * 1000);
  return proximity === 'on_line'
    ? `Вычислено: место лежит в ${m} м от линии маршрута`
    : `Вычислено: место в ${(offLineKm).toFixed(1)} км от линии — рядом, но не на пути`;
}

/**
 * Найти ориентиры вдоль линии. Чистая функция: ничего не читает и не пишет.
 */
export function deriveStages(i: DerivedStagesInput): DerivedStagesResult {
  const empty: DerivedStagesResult = {
    onLine: [], nearLine: [], sweeping: false,
    onLineKm: ON_LINE_KM, nearLineKm: NEAR_LINE_KM,
  };
  if (i.track.length < 2) return empty;

  const known = new Set(i.establishedPlaceIds ?? []);
  const onLine: DerivedStage[] = [];
  const nearLine: DerivedStage[] = [];

  for (const pl of i.places) {
    if (known.has(pl.id)) continue;
    if (!Number.isFinite(pl.lat) || !Number.isFinite(pl.lng)) continue;
    const proj = projectOnTrack({ lat: pl.lat, lng: pl.lng }, i.track);
    if (!proj) continue;
    if (proj.offTrackKm > NEAR_LINE_KM) continue;

    const proximity: StageProximity = proj.offTrackKm <= ON_LINE_KM ? 'on_line' : 'near_line';
    const offLineKm = Math.round(proj.offTrackKm * 1000) / 1000;
    const stage: DerivedStage = {
      placeId: pl.id,
      name: pl.name,
      locationType: pl.locationType ?? null,
      // Порядок вдоль линии: номер звена плюс доля внутри него. Сортировка по
      // расстоянию от начала неверна на маршруте, который возвращается той же
      // тропой, — там два разных места получили бы одно место в списке.
      position: proj.segment + proj.t,
      offLineKm,
      proximity,
      origin: 'derived',
      why: explain(offLineKm, proximity),
    };
    (proximity === 'on_line' ? onLine : nearLine).push(stage);
  }

  const renumber = (arr: DerivedStage[]) => {
    arr.sort((a, b) => a.position - b.position);
    arr.forEach((s, n) => { s.position = n; });
    return arr;
  };

  return {
    onLine: renumber(onLine),
    nearLine: renumber(nearLine),
    sweeping: onLine.length > SWEEP_LIMIT,
    onLineKm: ON_LINE_KM,
    nearLineKm: NEAR_LINE_KM,
  };
}

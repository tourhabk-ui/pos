/**
 * lib/routes/track-evidence.ts
 *
 * Улика записи: можно ли ДОКАЗАТЬ, что линию сняли, а не нарисовали.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * 17.08 слог `external` (скрейп с чужого сайта, 259 линий из 301) понижен из
 * «снятого трека» в «импорт»: доказательств, что по линии кто-то прошёл, у
 * платформы не было, а сплошная зелёная в четыре пикселя зовёт идти.
 *
 * В тот же вечер владелец сообщил то, чего в коде не было записано: сайт-
 * источник ЗАЯВЛЯЕТ, что треки ему предоставляли люди, которые их прошли.
 * Это меняет вес 259 линий: они не мусор, они кандидаты.
 *
 * Но заявление на чужом сайте — не доказательство о НАШЕЙ копии. Между их
 * страницей и нашей базой стоит наш разбор, и он уже уличён: регулярка ловила
 * любые вложенные числовые массивы, включая профиль высот `[[0, 795], ...]`,
 * формат определяла по одной точке — и писала в базу «геометрию», которая на
 * карте шла горизонталью через весь край (полевые скрины «Авачинский»,
 * «Козельский», исправлено в 86316be на границе записи).
 *
 * Значит вопрос не «честен ли источник», а «что мы можем проверить сами».
 *
 * ── Что можно проверить, никуда не выходя ─────────────────────────────────
 *
 * Оказалось — главное. Источник отдаёт треки в формате `[lng, lat, ele]`, и
 * импортёр пишет третье число в базу как есть. ВЫСОТА НА КАЖДОЙ ТОЧКЕ — это
 * след прибора: её несёт запись GPS и не несёт полилиния, нарисованная по
 * карте мышью. Свою высоту мы не дописываем — `computeElevationProfile`
 * геометрию только читает, так что признак не загрязнён.
 *
 * Остальные признаки берутся у тех, кто уже ими судит; своих порогов здесь
 * нет, иначе появится второе правило о том же:
 *
 *   границы края   — isPlausibleTrackPoint (lib/routes/track)
 *   непрерывность  — routeIntegrity        (lib/routes/shape-match)
 *   плотность      — trackFidelity         (lib/routes/track-fidelity)
 *
 * ── Чего этот модуль НЕ делает ────────────────────────────────────────────
 *
 * Он не повышает род линии сам. Он считает улики и называет их словами;
 * повышение — отдельное решение и отдельная запись в базу. Мера, которая
 * заодно и меняет измеряемое, перестаёт быть мерой.
 */

import { isPlausibleTrackPoint } from '@/lib/routes/track';
import { routeIntegrity } from '@/lib/routes/shape-match';
import { trackFidelity, type LatLng } from '@/lib/routes/track-fidelity';

/**
 * `recorded` — улики записи налицо: высота, непрерывность, плотность, край.
 * `drawn`    — высоты нет ни на одной точке: следа прибора нет.
 * `unclear`  — улики частичные: судить нельзя ни в ту, ни в другую сторону.
 */
export type TrackEvidenceVerdict = 'recorded' | 'drawn' | 'unclear';

export interface TrackEvidence {
  verdict: TrackEvidenceVerdict;
  points: number;
  /** Доля точек, несущих третье число (высоту), от 0 до 1. */
  elevationShare: number;
  /** Все ли точки лежат в границах края. */
  inBounds: boolean;
  /** Линия не рвётся на десятки километров. */
  continuous: boolean;
  /**
   * Плотность подтверждает запись. `false` означает и «редко», и «линия
   * коротка, судить нечем» — против записи говорит только первое, см.
   * `reasons`.
   */
  dense: boolean;
  /** Словами: что мешает считать линию записанной. Пусто у `recorded`. */
  reasons: string[];
}

/**
 * Доля точек с высотой, ниже которой запись не признаётся.
 *
 * Не единица: у настоящей записи прибор изредка теряет высоту, и требовать
 * идеала значило бы отбраковывать по единственной дырке. Не половина: если
 * высота есть у трети точек, это уже не след прибора, а обрывок чего-то.
 */
export const ELEVATION_SHARE_FOR_RECORDED = 0.9;

/** Точка геометрии как она лежит в базе: [lng, lat] или [lng, lat, ele]. */
type RawPoint = number[];

function rawPoints(geometry: unknown): RawPoint[] {
  const g = geometry as { coordinates?: unknown } | null;
  if (!Array.isArray(g?.coordinates)) return [];
  return g.coordinates.filter(
    (p): p is RawPoint =>
      Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]),
  );
}

export function trackEvidence(geometry: unknown): TrackEvidence {
  const pts = rawPoints(geometry);
  const reasons: string[] = [];

  if (pts.length < 2) {
    return {
      verdict: 'unclear', points: pts.length, elevationShare: 0,
      inBounds: false, continuous: false, dense: false,
      reasons: ['В линии меньше двух точек — улик нет'],
    };
  }

  // Высота: третье ЧИСЛО. Нулевая высота — законное значение (берег океана),
  // поэтому считается наличие числа, а не его правдивость.
  const withEle = pts.filter((p) => p.length >= 3 && Number.isFinite(p[2])).length;
  const elevationShare = withEle / pts.length;

  const pairs: LatLng[] = pts.map((p) => [p[1], p[0]]);
  const inBounds = pts.every((p) => isPlausibleTrackPoint(p[1], p[0]));
  // Путевые точки здесь не при чём: спрашивается непрерывность самой линии,
  // и пустой список точек routeIntegrity понимает как «сверять не с чем».
  const continuous = routeIntegrity(pairs.map(([lat, lng]) => ({ lat, lng })), []).verdict !== 'not_a_path';
  // Плотность: судит trackFidelity. Её «unknown» — это «судить нечем»
  // (маршрут короче MIN_KM_TO_JUDGE, деление на малое число даёт шум), и
  // считать такой ответ уликой ПРОТИВ записи нельзя: неизвестность стала бы
  // обвинением — тот же класс, что `Number(null) === 0`. Плотность здесь
  // подтверждает, а не требуется: короткая тропа с высотой на каждой точке
  // записана прибором ничуть не меньше длинной.
  const fidelity = trackFidelity(pairs);
  const dense = fidelity === 'surveyed';

  if (elevationShare < ELEVATION_SHARE_FOR_RECORDED) {
    reasons.push(
      elevationShare === 0
        ? 'Ни у одной точки нет высоты — следа прибора в линии нет'
        : `Высота есть только у ${Math.round(elevationShare * 100)}% точек`,
    );
  }
  if (!inBounds) reasons.push('Линия выходит за границы края — в разбор попали посторонние числа');
  if (!continuous) reasons.push('Линия рвётся на десятки километров');
  if (fidelity === 'sketch') reasons.push('Точки стоят редко — по плотности это не запись прибора');

  if (reasons.length === 0) {
    return { verdict: 'recorded', points: pts.length, elevationShare, inBounds, continuous, dense, reasons };
  }
  // «Нарисована» говорится только когда следа прибора нет ВОВСЕ. Линия с
  // высотой, но редкая или рваная, нарисованной не объявляется: это запись,
  // с которой что-то не так, и чинить её надо иначе.
  return {
    verdict: elevationShare === 0 ? 'drawn' : 'unclear',
    points: pts.length, elevationShare, inBounds, continuous, dense, reasons,
  };
}

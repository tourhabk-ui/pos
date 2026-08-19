/**
 * lib/routes/track-clean.ts
 *
 * Отделить мусор от настоящего трека — не починить, а отделить.
 *
 * ── Откуда мусор ───────────────────────────────────────────────────────────
 *
 * Из нашего разбора, не из источника. Импортёр искал координаты регуляркой по
 * любым вложенным числовым массивам страницы, под неё попадал профиль высот
 * (`[[0, 795], [1.2, 810], ...]`), формат определялся по ОДНОЙ точке — и в
 * базу писалось то, что треком не является. На карте это давало сплошную
 * зелёную горизонталь через весь край: полевые скрины «Авачинский» и
 * «Козельский» 16–17.08.
 *
 * Правка 86316be закрыла ГРАНИЦУ ЗАПИСИ: блок принимается, только если каждая
 * его точка лежит на Камчатке. Но записанное до неё осталось записанным.
 *
 * ── Почему отделять, а не выбрасывать целиком ─────────────────────────────
 *
 * Владелец 17.08: источник заявляет треки как полученные от людей, которые их
 * прошли, — «если треки реальные, но замусоренные». Улика записи это
 * подтверждает поимённо (`track-evidence`: высота на каждой точке — след
 * прибора). Выбрасывать пятьсот честных точек из-за двух посторонних значит
 * терять настоящий путь ради чистоты правила.
 *
 * ── Чего здесь НЕ делается ────────────────────────────────────────────────
 *
 * Ни сглаживания, ни интерполяции, ни перестановки, ни «подтягивания» точки к
 * соседям. Всё это — ВЫДУМЫВАНИЕ координат там, где данных нет, а по этой
 * линии человек пойдёт. Точка либо доказуемо посторонняя и удаляется целиком,
 * либо остаётся как есть.
 *
 * Каждое удаление названо причиной и сосчитано. Чистка, о результатах которой
 * нельзя спросить «что именно ты убрала», неотличима от порчи.
 */

import { isPlausibleTrackPoint } from '@/lib/routes/track';
import { straightKm } from '@/lib/on-route/approach';
import { LINE_BREAK_KM } from '@/lib/routes/shape-match';

/** Точка геометрии как она лежит в базе: [lng, lat] или [lng, lat, ele]. */
export type RawPoint = number[];

export type RemovalReason = 'out_of_bounds' | 'spike' | 'duplicate';

export interface Removal {
  /** Позиция в ИСХОДНОЙ линии — чтобы удаление можно было найти глазами. */
  index: number;
  point: RawPoint;
  reason: RemovalReason;
}

export type CleanVerdict = 'clean' | 'cleaned' | 'not_cleanable';

export interface CleanResult {
  verdict: CleanVerdict;
  points: RawPoint[];
  removed: Removal[];
  /** Доля удалённого от исходного числа точек. */
  removedShare: number;
  reasons: string[];
}

/**
 * Сколько можно убрать, продолжая называть это чисткой.
 *
 * Десятая часть — уже не шум. Линия, у которой каждая десятая точка
 * посторонняя, не «замусорена»: это либо не тот блок разобрали, либо две
 * склеенные записи. Чинить такое чисткой значило бы выдать за трек то, чего
 * мы не понимаем.
 */
export const MAX_REMOVED_SHARE = 0.1;

const near = (a: RawPoint, b: RawPoint) =>
  straightKm({ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] });

const same = (a: RawPoint, b: RawPoint) => a[0] === b[0] && a[1] === b[1];

/**
 * Выброс — точка, УДАЛЕНИЕ КОТОРОЙ ВОССТАНАВЛИВАЕТ НЕПРЕРЫВНОСТЬ.
 *
 * Определение намеренно опирается на тот же порог разрыва, которым
 * `routeIntegrity` судит, путь перед нами или набор мест. Свой порог означал
 * бы, что «разрыв» при чистке и «разрыв» при оценке — разные величины, а это
 * одно и то же утверждение о линии.
 *
 * Скачок GPS выглядит именно так: ушла на десятки километров и вернулась,
 * соседи при этом рядом друг с другом. Настоящий длинный перегон соседей
 * рядом не оставляет.
 */
function isSpike(prev: RawPoint, p: RawPoint, next: RawPoint): boolean {
  return near(prev, p) > LINE_BREAK_KM
    && near(p, next) > LINE_BREAK_KM
    && near(prev, next) <= LINE_BREAK_KM;
}

export function cleanTrack(input: RawPoint[]): CleanResult {
  const pts = input.filter(
    (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]),
  );
  if (pts.length < 2) {
    return {
      verdict: 'not_cleanable', points: [], removed: [], removedShare: 0,
      reasons: ['В линии меньше двух годных точек — отделять нечего'],
    };
  }

  const removed: Removal[] = [];
  const kept: RawPoint[] = [];

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];

    // Вне края — доказуемо посторонняя: маршрут Камчатки такой точки не
    // содержит ни одной. Это и есть тот самый профиль высот, прочитанный как
    // координаты (`lng = 795, lat = 0` — Гвинейский залив).
    if (!isPlausibleTrackPoint(p[1], p[0])) {
      removed.push({ index: i, point: p, reason: 'out_of_bounds' });
      continue;
    }

    // Повтор координаты пути не описывает и мерам мешает: нулевые сегменты
    // занижают плотность и удлиняют счёт.
    const last = kept[kept.length - 1];
    if (last && same(last, p)) {
      removed.push({ index: i, point: p, reason: 'duplicate' });
      continue;
    }

    // Выброс судится по СОСЕДЯМ ПО ИСХОДНОЙ линии: сравнивать с уже
    // очищенным значило бы, что решение зависит от того, что удалили раньше.
    const prev = pts[i - 1];
    const next = pts[i + 1];
    if (prev && next && isSpike(prev, p, next)) {
      removed.push({ index: i, point: p, reason: 'spike' });
      continue;
    }

    kept.push(p);
  }

  const removedShare = removed.length / pts.length;
  const reasons: string[] = [];

  if (removed.length === 0) {
    return { verdict: 'clean', points: kept, removed, removedShare: 0, reasons };
  }
  if (kept.length < 2) {
    reasons.push('После отделения постороннего точек не осталось — это была не линия');
    return { verdict: 'not_cleanable', points: [], removed, removedShare, reasons };
  }
  if (removedShare > MAX_REMOVED_SHARE) {
    reasons.push(
      `Посторонней оказалась ${Math.round(removedShare * 100)}% линии — это не мусор, а другая запись`,
    );
    return { verdict: 'not_cleanable', points: kept, removed, removedShare, reasons };
  }

  const byReason: Record<string, number> = {};
  for (const r of removed) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  for (const [why, n] of Object.entries(byReason)) {
    reasons.push(
      why === 'out_of_bounds' ? `Вне края: ${n}`
        : why === 'spike' ? `Скачков: ${n}`
          : `Повторов: ${n}`,
    );
  }
  return { verdict: 'cleaned', points: kept, removed, removedShare, reasons };
}

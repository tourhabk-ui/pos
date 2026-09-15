/**
 * lib/field/track-preview.ts
 *
 * Показать снятую запись КАРТИНКОЙ, а не таблицей чисел.
 *
 * ── Зачем (15.09, слово владельца об экране очереди: «это кринж») ──────────
 *
 * Первая редакция экрана `/hub/admin/track-imports` печатала запись столбцом
 * величин: точек, длина, состояние `pending`. Человек, прошедший маршрут
 * ногами, о своей записи по ним не узнаёт НИЧЕГО: 1240 точек и 8.3 км — это
 * и подъём на вулкан, и круг по посёлку. Единственное, что отвечает на
 * вопрос «это мой выход?», — форма линии.
 *
 * ── Почему куски и провалы рисуются РАЗНЫМИ линиями ───────────────────────
 *
 * Запись рекордера рвётся там, где прибор терял небо (`splitAtGaps`). Если
 * склеить куски в одну сплошную зелёную, то прямая через молчание прибора
 * получит вид снятого пути — то самое обещание «здесь идут», ради которого
 * писался §12. Поэтому:
 *
 *   куски   → снятый путь: их прибор действительно записал;
 *   провалы → построение: прямая, которую никто не проходил.
 *
 * Вид назначает не этот модуль, а `lib/map/line-standard` — здесь только
 * РАЗДЕЛЕНИЕ на то и другое. Собирать стиль рядом с геометрией запрещено:
 * так правило и разъезжалось по экранам.
 *
 * ── Прореживание объявляется вслух ────────────────────────────────────────
 *
 * В записи бывают тысячи точек; гнать их все в браузер незачем — экран в 300
 * пикселей разницы не покажет. Но прореженная линия УЖЕ НЕ РАВНА той, что
 * ляжет в маршрут, и умолчать об этом нельзя: `shown` и `of` едут в ответе,
 * и экран говорит их словами. Применение всегда считает линию заново из
 * файла — этот модуль к записи в базу отношения не имеет вовсе.
 */

import type { SegmentPoint, TrackSegment } from '@/lib/field/track-segments';

/** Точка карты в порядке Leaflet: широта, долгота. */
export type PreviewPoint = [number, number];

export interface TrackPreview {
  /** Куски записи — то, что прибор снял. Каждый рисуется снятым путём. */
  pieces: PreviewPoint[][];
  /**
   * Прямые между концом одного куска и началом следующего. Путём не
   * являются: прибор в это время молчал, и что там под линией — неизвестно.
   */
  gaps: [PreviewPoint, PreviewPoint][];
  /** Сколько точек нарисовано. */
  shown: number;
  /** Сколько их в записи. `shown < of` — линия прорежена для показа. */
  of: number;
  /** Рамка всей записи — по ней экран ставит камеру. `null` — точек нет. */
  bounds: { south: number; west: number; north: number; east: number } | null;
}

/**
 * Прорядить кусок до `limit` точек, СОХРАНИВ концы.
 *
 * Концы важнее середины: по ним сходятся куски с провалами, и по ним человек
 * узнаёт начало и конец выхода. Равномерная выборка, а не «каждая N-я»:
 * последняя точка обязана остаться последней при любой длине.
 */
function thin<P>(points: readonly P[], limit: number): P[] {
  if (limit < 2 || points.length <= limit) return [...points];
  const out: P[] = [];
  const step = (points.length - 1) / (limit - 1);
  for (let i = 0; i < limit; i++) {
    out.push(points[Math.round(i * step)]!);
  }
  // Концы сохраняются самой формулой: при i = limit-1 индекс равен
  // (limit-1)·(n-1)/(limit-1) = n-1. Дописывать последнюю точку отдельно не
  // нужно — проверено мутацией: строка-«страховка» ничего не страховала, а
  // код, который нельзя сломать, нельзя и проверить.
  return out;
}

/**
 * Собрать превью записи из её кусков.
 *
 * `maxPoints` — потолок на ВСЮ запись, а не на кусок: длинный кусок получает
 * больше точек, короткий — меньше, но не меньше двух (кусок из одной точки
 * линией не является и выбрасывается).
 */
export function buildTrackPreview<P extends SegmentPoint>(
  segments: readonly TrackSegment<P>[],
  maxPoints = 600,
): TrackPreview {
  const usable = segments.filter(s => s.points.length >= 2);
  const total = usable.reduce((n, s) => n + s.points.length, 0);

  const pieces: PreviewPoint[][] = usable.map((s) => {
    // Доля куска в записи — его доля в бюджете точек. Минимум два: иначе
    // кусок исчезнет с карты, а он в записи есть.
    const share = total > 0 ? s.points.length / total : 0;
    const budget = Math.max(2, Math.round(maxPoints * share));
    return thin(s.points, budget).map(p => [p.lat, p.lng] as PreviewPoint);
  });

  const gaps: [PreviewPoint, PreviewPoint][] = [];
  for (let i = 1; i < pieces.length; i++) {
    const prev = pieces[i - 1]!;
    const next = pieces[i]!;
    gaps.push([prev[prev.length - 1]!, next[0]!]);
  }

  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (const piece of pieces) {
    for (const [lat, lng] of piece) {
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
    }
  }

  return {
    pieces,
    gaps,
    shown: pieces.reduce((n, p) => n + p.length, 0),
    of: total,
    bounds: Number.isFinite(south)
      ? { south, west, north, east }
      // Точек нет вовсе — рамки не существует. Ноль здесь был бы координатой
      // в Гвинейском заливе, то есть выдумкой вместо отсутствия (§4.0).
      : null,
  };
}

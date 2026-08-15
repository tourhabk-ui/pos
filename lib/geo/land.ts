/**
 * Точка на суше или в море — по контуру берега, детерминированно.
 *
 * Повод: фильтр «Источники» на карте показал термальные источники посреди
 * Охотского моря (скрин владельца 14.08). Источник в море — это не экзотика
 * природы, а битые координаты в `places`: точка с перепутанными знаками,
 * усечённой долготой или лишним градусом падает в воду молча и живёт там
 * месяцами — на карте она выглядит так же уверенно, как настоящая.
 *
 * Глазами такое не ловится: 779 точек никто не пересматривает. Арифметикой —
 * ловится: контур берега уже лежит в репозитории (Natural Earth 10m,
 * lib/geo/coastline.ts), осталось собрать его куски в замкнутые кольца и
 * спросить чёт-нечет пересечений луча.
 *
 * ── Сборка колец ───────────────────────────────────────────────────────────
 *
 * Контур нарезан рамкой Камчатки, поэтому куски двух сортов: замкнутые
 * острова (первая точка равна последней) и разомкнутые куски, у которых
 * рамка отрезала продолжение. Разомкнутые склеиваются по совпадающим концам,
 * а дальше два случая:
 *
 *   концы рядом (доли градуса) — пролив, разрезанный краем рамки; замыкаем
 *   напрямую, погрешность меньше шага упрощения контура;
 *
 *   концы далеко — материковый берег, уходящий за рамку с запада и востока;
 *   замыкаем через СЕВЕРНЫЕ углы рамки: суша продолжается на север
 *   (континент), море — на юг. Перепутать стороны здесь значит вывернуть
 *   мир наизнанку, поэтому ориентацию стерегут тесты на городах и морях.
 *
 * ── Что эта проверка обещает и чего не обещает ─────────────────────────────
 *
 * Контур упрощён (~1 км): бухты и косы мельче порога стёрты. Поэтому ответ
 * «в море» надёжен на километрах от берега и НЕ надёжен на пляже — точка на
 * пирсе может попасть по обе стороны упрощённой линии. Аудит обязан
 * показывать расстояние и отдавать решение человеку, а не чинить координаты
 * сам: имена и места на Камчатке путаные (ср. lib/routes/relief-sanity.ts).
 */

import { COASTLINE, type CoastPoint } from '@/lib/geo/coastline';

/** Ближе этого (в градусах) концы кусков считаются разрезом рамки, не разрывом. */
const JOIN_EPS_DEG = 0.2;

const KM_PER_DEG_LAT = 111.32;

function degDist(a: CoastPoint, b: CoastPoint): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Склейка разомкнутых кусков по совпадающим концам (жадно, с разворотом). */
function chainOpenParts(parts: CoastPoint[][]): CoastPoint[][] {
  const pool = parts.map((p) => [...p]);
  const chains: CoastPoint[][] = [];

  while (pool.length > 0) {
    let chain = pool.shift()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i];
        const tail = chain[chain.length - 1];
        const head = chain[0];
        if (degDist(tail, c[0]) < JOIN_EPS_DEG) {
          chain = chain.concat(c.slice(1));
        } else if (degDist(tail, c[c.length - 1]) < JOIN_EPS_DEG) {
          chain = chain.concat([...c].reverse().slice(1));
        } else if (degDist(head, c[c.length - 1]) < JOIN_EPS_DEG) {
          chain = c.concat(chain.slice(1));
        } else if (degDist(head, c[0]) < JOIN_EPS_DEG) {
          chain = [...c].reverse().concat(chain.slice(1));
        } else {
          continue;
        }
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains;
}

function buildRings(): CoastPoint[][] {
  const rings: CoastPoint[][] = [];
  const open: CoastPoint[][] = [];

  for (const part of COASTLINE.parts) {
    const closed = degDist(part[0], part[part.length - 1]) === 0;
    if (closed) rings.push(part);
    else open.push(part);
  }

  const [, , east, north] = COASTLINE.bbox;
  const west = COASTLINE.bbox[0];

  for (const chain of chainOpenParts(open)) {
    const head = chain[0];
    const tail = chain[chain.length - 1];
    if (degDist(head, tail) < JOIN_EPS_DEG * 2) {
      rings.push([...chain, head]);
    } else {
      // Материк: суша к северу от берега, замыкаем через верх рамки.
      rings.push([
        ...chain,
        [east, tail[1]], [east, north], [west, north], [west, head[1]],
        head,
      ]);
    }
  }
  return rings;
}

const RINGS: CoastPoint[][] = buildRings();

export type LandVerdict = 'land' | 'sea' | 'outside_region';

/** Чёт-нечет пересечений горизонтального луча со всеми кольцами. */
function insideRings(lng: number, lat: number): boolean {
  let inside = false;
  for (const ring of RINGS) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Где точка: на суше, в море или вне камчатской рамки.
 *
 * Вне рамки — отдельный ответ, а не «море»: точка в Магадане битая иначе,
 * чем точка в Охотском море, и чинится иначе.
 */
export function landVerdict(lat: number, lng: number): LandVerdict {
  const [w, s, e, n] = COASTLINE.bbox;
  if (lng < w || lng > e || lat < s || lat > n) return 'outside_region';
  return insideRings(lng, lat) ? 'land' : 'sea';
}

/**
 * Расстояние до ближайшего звена контура, км. Для точки «в море» это мера
 * уверенности: 40 км от берега — точно битые координаты, 800 м — возможно,
 * упрощение контура съело косу, решает человек.
 */
export function distanceToCoastKm(lat: number, lng: number): number {
  let best = Infinity;
  const kx = KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  const px = lng * kx;
  const py = lat * KM_PER_DEG_LAT;

  for (const ring of RINGS) {
    for (let i = 0; i < ring.length - 1; i++) {
      const ax = ring[i][0] * kx, ay = ring[i][1] * KM_PER_DEG_LAT;
      const bx = ring[i + 1][0] * kx, by = ring[i + 1][1] * KM_PER_DEG_LAT;
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
      const d = Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
      if (d < best) best = d;
    }
  }
  return best;
}

/** Для тестов сборки: все кольца замкнуты, ничего не потеряно. */
export function ringStats(): { rings: number; allClosed: boolean; points: number } {
  return {
    rings: RINGS.length,
    allClosed: RINGS.every((r) => degDist(r[0], r[r.length - 1]) === 0),
    points: RINGS.reduce((s, r) => s + r.length, 0),
  };
}

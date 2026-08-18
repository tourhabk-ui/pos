/**
 * lib/services/ingest/track-parse.ts — разбор трека со страницы источника.
 *
 * ── Зачем отдельный модуль ────────────────────────────────────────────────
 *
 * Разбор был в двух местах, и у каждой копии оказалась своя дыра:
 *
 *   lib/services/ingest/idilesom-importer.ts (им работает ПРОД)
 *       высоту бережёт в обоих порядках осей — починено 09.08, когда
 *       выяснилось, что 289 маршрутов и 119 683 точки лежат без единой
 *       высоты, хотя источник её даёт;
 *       границ края НЕ проверяет вовсе.
 *
 *   scripts/import-idilesom-tracks.ts
 *       границы проверяет у каждой точки — правка 16.08 после полевых
 *       скринов, где профиль высот, прочитанный как координаты, рисовал
 *       сплошную зелёную линию через весь край;
 *       а высоту в порядке «широта первой» молча теряет — ту самую, ради
 *       которой правили lib.
 *
 * Каждая копия несёт баг, вылеченный в другой. Это ровно тот случай, ради
 * которого писался §12: правило, реализованное дважды, — это два правила.
 *
 * ── Порядок осей определяется по ВСЕМ точкам, а не по первой ──────────────
 *
 * Обе копии решали порядок по одному числу (`|first[0]| > 90`). Профиль
 * высот `[[0, 795], [1.2, 810], …]` под эту проверку попадает как «широта
 * первой»: первое число там — расстояние от старта, оно меньше 90.
 *
 * Здесь порядок не угадывается, а ПРОВЕРЯЕТСЯ: блок принимается в том
 * прочтении, при котором ВСЕ точки лежат на Камчатке. Двусмысленности быть
 * не может — при перестановке широта стала бы 155–167°, чего не бывает.
 * Не сошлось ни одно прочтение — блок не наш, и догадками его чинить хуже,
 * чем пропустить.
 */

import { isPlausibleTrackPoint } from '@/lib/routes/track';

/** Почему блок отвергнут — словами, пригодными для отчёта сверки. */
export type BlockReject =
  | 'malformed'      // не разобрался как массив пар
  | 'too_short'      // меньше трёх точек — линии нет
  | 'not_on_map';    // ни одно прочтение не даёт точек Камчатки

export interface ParsedTrack {
  /** Точки в порядке GeoJSON: [долгота, широта, высота?]. Пусто — трека нет. */
  coordinates: number[][];
  /** Сколько числовых блоков нашлось на странице. */
  blocksSeen: number;
  /** Почему отвергнуты остальные. */
  rejected: Record<BlockReject, number>;
  /** Есть ли высота хотя бы у одной точки принятого блока. */
  hasElevation: boolean;
}

/**
 * Числовые блоки на странице. Регулярка широкая намеренно: она ищет любые
 * вложенные числовые массивы, а отбор делает проверка ниже — сузить её
 * значило бы решать по форме записи, а не по содержанию.
 */
const BLOCK_RE = /\[\s*\[\s*[\d.]+\s*,\s*[\d.]+[\s\S]*?\]\s*\]/g;

/** Прочтение блока в заданном порядке осей, с сохранением высоты. */
function readAs(parsed: number[][], lngFirst: boolean): number[][] {
  return lngFirst
    ? parsed.map((p) => (p.length >= 3 ? [p[0], p[1], p[2]] : [p[0], p[1]]))
    : parsed.map((p) => (p.length >= 3 ? [p[1], p[0], p[2]] : [p[1], p[0]]));
}

/** Все точки лежат на Камчатке. Проверяется КАЖДАЯ: эвристика по одной уже ошибалась. */
function allOnMap(coords: number[][]): boolean {
  return coords.every((p) => isPlausibleTrackPoint(p[1], p[0]));
}

export function parseTrackBlocks(html: string): ParsedTrack {
  const blocks = html.match(BLOCK_RE) ?? [];
  const rejected: Record<BlockReject, number> = { malformed: 0, too_short: 0, not_on_map: 0 };
  let best: number[][] = [];

  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      rejected.malformed += 1;
      continue;
    }
    if (!Array.isArray(parsed) || !Array.isArray(parsed[0]) || (parsed[0] as unknown[]).length < 2) {
      rejected.malformed += 1;
      continue;
    }
    if (parsed.length < 3) { rejected.too_short += 1; continue; }

    const pairs = parsed as number[][];
    // Порядок ПРОВЕРЯЕТСЯ, а не угадывается: принимается то прочтение, при
    // котором на карте оказываются все точки до единой.
    const lngFirst = readAs(pairs, true);
    const latFirst = readAs(pairs, false);
    const coords = allOnMap(lngFirst) ? lngFirst : allOnMap(latFirst) ? latFirst : null;
    if (!coords) { rejected.not_on_map += 1; continue; }

    // Из принятых берётся самый длинный: страница отдаёт трек одним блоком,
    // а короткие рядом — это обзорные врезки и куски соседних объектов.
    if (coords.length > best.length) best = coords;
  }

  return {
    coordinates: best,
    blocksSeen: blocks.length,
    rejected,
    hasElevation: best.some((p) => p.length >= 3 && Number.isFinite(p[2])),
  };
}

/**
 * В каком порядке записаны оси — по ВСЕМУ блоку, а не по первой точке.
 *
 * Нужна осмотру страницы (`inspectIdilesomShape`), который смотрит на сырые
 * блоки и отвечает на вопрос «есть ли у источника высоты вообще». Осмотр
 * намеренно ничего не фильтрует — но и врать о порядке осей не должен:
 * у профиля высот первое число меньше 90, и прежний ответ «lat-first» был
 * не наблюдением, а той же ошибочной догадкой.
 *
 * `null` — ни одно прочтение не даёт точек Камчатки: это не координаты.
 */
export function axisOrder(pairs: number[][]): 'lng-first' | 'lat-first' | null {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  if (allOnMap(readAs(pairs, true))) return 'lng-first';
  if (allOnMap(readAs(pairs, false))) return 'lat-first';
  return null;
}

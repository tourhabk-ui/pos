/**
 * Сдвиги вёрстки глазами браузера на проде (14.10) — разбор для map-page-check.
 *
 * Lighthouse (прогоны 9 и 10) назвал на /map сдвиг 0,171 узла `div.px-4` —
 * контейнера карты — и не назвал причину. Локальная сборка без данных его не
 * воспроизводит (0,003 при подставленных местах). Значит, смотреть надо на
 * проде: какие узлы сдвинулись и на сколько (записи layout-shift с
 * прямоугольниками до и после) и какой блок над ними вырос (раскладка верхних
 * блоков по времени). Здесь — только разбор собранного; собирает браузер.
 */

/** Узел и его [y, высота] до и после сдвига, в пикселях CSS. */
export interface ShiftSource {
  node: string;
  prev: [number, number] | null;
  cur: [number, number] | null;
}

export interface ShiftEntry {
  /** Время записи от начала навигации, мс. */
  t: number;
  value: number;
  sources: ShiftSource[];
}

export interface LayoutBlock {
  node: string;
  y: number;
  h: number;
}

export interface LayoutSnap {
  t: number;
  blocks: LayoutBlock[];
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)}с`;

/** «сдвиг 0.1712 на 2.3с: div.px-4 y 141→316, h 643→643». */
export function describeShift(e: ShiftEntry): string {
  const src = e.sources
    .map((s) => (s.prev && s.cur ? `${s.node} y ${s.prev[0]}→${s.cur[0]}, h ${s.prev[1]}→${s.cur[1]}` : s.node))
    .join('; ');
  return `сдвиг ${e.value.toFixed(4)} на ${sec(e.t)}: ${src || 'узлы не названы'}`;
}

/** Сумма сдвигов — то, что Lighthouse называет CLS (без окон сессий: страница одна). */
export function totalShift(entries: ShiftEntry[]): number {
  return entries.reduce((sum, e) => sum + e.value, 0);
}

/**
 * Раскладка верхних блоков — только снимки, где что-то сдвинулось или
 * выросло: одинаковые подряд не печатаются, по ним видно, какой блок и когда
 * поменял высоту.
 */
export function layoutChanges(snaps: LayoutSnap[]): string[] {
  const out: string[] = [];
  let prev = '';
  for (const s of snaps) {
    const key = s.blocks.map((b) => `${b.node}:${b.y}+${b.h}`).join('|');
    if (key === prev) continue;
    prev = key;
    out.push(`раскладка ${sec(s.t)}: ${s.blocks.map((b) => `${b.node} ${b.y}+${b.h}`).join(' | ') || 'блоков нет'}`);
  }
  return out;
}

/**
 * Наблюдатель сдвигов в странице (14.10). Селектор как у Lighthouse: тег и
 * первый класс, три уровня вверх, — чтобы узел совпадал с его расшифровкой.
 * Строкой, а не функцией: tsx (esbuild) оборачивает именованные функции в
 * помощник __name, которого в странице нет, и наблюдатель падал до записи.
 */
export const SHIFT_OBSERVER = `(() => {
  function sel(n) {
    var parts = [];
    var el = n && n.nodeType === 1 ? n : null;
    for (var i = 0; el && i < 3; i++, el = el.parentElement) {
      var first = el.classList[0];
      parts.unshift(el.tagName.toLowerCase() + (el.id ? '#' + el.id : first ? '.' + first : ''));
    }
    return parts.join(' > ') || String(n && n.nodeName || '?');
  }
  window.__sel = sel;
  window.__shifts = [];
  new PerformanceObserver(function (list) {
    list.getEntries().forEach(function (e) {
      if (e.hadRecentInput) return;
      window.__shifts.push({
        t: Math.round(e.startTime),
        value: e.value,
        sources: (e.sources || []).map(function (s) {
          return {
            node: sel(s.node),
            prev: s.previousRect ? [Math.round(s.previousRect.y), Math.round(s.previousRect.height)] : null,
            cur: s.currentRect ? [Math.round(s.currentRect.y), Math.round(s.currentRect.height)] : null,
          };
        }),
      });
    });
  }).observe({ type: 'layout-shift', buffered: true });
})();`;

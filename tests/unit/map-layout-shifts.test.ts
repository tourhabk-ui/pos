// @vitest-environment jsdom
/**
 * Сдвиги вёрстки для map-page-check (14.10) — вызовом разбора и исполнением
 * наблюдателя в jsdom (правило 13.10).
 *
 * Lighthouse (прогоны 9 и 10) назвал на /map сдвиг 0,171 контейнера карты
 * `div.px-4` и не назвал причину; локальная сборка без данных его не
 * воспроизводит. Флаг --layout-shifts снимает с прода записи layout-shift с
 * прямоугольниками до и после и раскладку верхних блоков по времени.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  SHIFT_OBSERVER, describeShift, layoutChanges, totalShift, type ShiftEntry,
} from '@/scripts/map-tiles/layout-shifts';

describe('разбор сдвигов', () => {
  const entry: ShiftEntry = {
    t: 2340, value: 0.17123,
    sources: [{ node: 'div.min-h-screen > div.px-4', prev: [141, 643], cur: [316, 643] }, { node: 'nav.flex', prev: null, cur: null }],
  };

  it('сдвиг называет узлы, их y и высоту до и после, время и долю', () => {
    expect(describeShift(entry)).toBe('сдвиг 0.1712 на 2.3с: div.min-h-screen > div.px-4 y 141→316, h 643→643; nav.flex');
    expect(describeShift({ t: 0, value: 0.01, sources: [] })).toBe('сдвиг 0.0100 на 0.0с: узлы не названы');
  });

  it('сумма — по всем записям', () => {
    expect(totalShift([entry, { ...entry, value: 0.02877 }])).toBeCloseTo(0.2, 6);
    expect(totalShift([])).toBe(0);
  });

  it('раскладка печатается только когда что-то сдвинулось или выросло', () => {
    const a = { node: 'header.relative', y: 0, h: 69 };
    const chips = (h: number) => ({ node: 'div.relative', y: 69, h });
    const lines = layoutChanges([
      { t: 300, blocks: [a, chips(64)] },
      { t: 700, blocks: [a, chips(64)] },
      { t: 1200, blocks: [a, chips(239)] },
      { t: 2000, blocks: [] },
    ]);
    expect(lines).toEqual([
      'раскладка 0.3с: header.relative 0+69 | div.relative 69+64',
      'раскладка 1.2с: header.relative 0+69 | div.relative 69+239',
      'раскладка 2.0с: блоков нет',
    ]);
  });
});

describe('наблюдатель в странице', () => {
  type Observed = { cb: (list: { getEntries: () => unknown[] }) => void; opts: unknown };
  const w = window as unknown as { __shifts?: ShiftEntry[]; __sel?: (n: Node) => string; PerformanceObserver: unknown };
  const original = w.PerformanceObserver;
  afterEach(() => { w.PerformanceObserver = original; document.body.innerHTML = ''; });

  function install(): Observed[] {
    const seen: Observed[] = [];
    w.PerformanceObserver = class {
      cb: Observed['cb'];
      constructor(cb: Observed['cb']) { this.cb = cb; }
      observe(opts: unknown) { seen.push({ cb: this.cb, opts }); }
    };
    // Та же строка, что уходит в page.addInitScript.
    new Function(SHIFT_OBSERVER)();
    return seen;
  }

  it('подписывается на layout-shift с буфером: сдвиги до загрузки скрипта тоже видны', () => {
    const seen = install();
    expect(seen).toHaveLength(1);
    expect(seen[0].opts).toEqual({ type: 'layout-shift', buffered: true });
  });

  it('пишет узел селектором как у Lighthouse — тег и первый класс — и прямоугольники', () => {
    document.body.className = 'min-h-screen bg-x';
    document.body.innerHTML = '<div class="min-h-screen pb-24"><div class="px-4 pb-4" id=""><p>карта</p></div></div>';
    const node = document.querySelector('.px-4') as Element;
    const [obs] = install();
    obs.cb({ getEntries: () => [
      { startTime: 2340.4, value: 0.171, hadRecentInput: false,
        sources: [{ node, previousRect: { y: 141.2, height: 643 }, currentRect: { y: 316.4, height: 643 } }] },
      // Сдвиг сразу после нажатия браузер не считает — и мы тоже.
      { startTime: 5000, value: 0.5, hadRecentInput: true, sources: [] },
    ] });
    expect(w.__shifts).toEqual([
      { t: 2340, value: 0.171, sources: [{ node: 'body.min-h-screen > div.min-h-screen > div.px-4', prev: [141, 643], cur: [316, 643] }] },
    ]);
    expect(w.__sel?.(node)).toBe('body.min-h-screen > div.min-h-screen > div.px-4');
  });
});

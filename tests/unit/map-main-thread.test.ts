// @vitest-environment jsdom
/**
 * Главный поток /map (14.10) — разбор вызовом и проба исполнением в jsdom
 * (правило 13.10).
 *
 * Lighthouse (прогон 16) мерит на /map TBT 12,9 с, а самовремя JS по профилю
 * ЦП — 0,75 с на всю страницу. Флаг --main-thread в map-page-check считает на
 * проде, сколько главный поток стоит внутри вызовов WebGL (в headless Chromium
 * WebGL рисует программно, SwiftShader).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAIN_THREAD_PROBE, describeMainThread, type GlStats, type LongTask } from '@/scripts/map-tiles/main-thread';

describe('разбор главного потока', () => {
  const gl: GlStats = {
    calls: {
      drawElements: { n: 3100, ms: 1210.4 },
      texImage2D: { n: 240, ms: 610 },
      getProgramParameter: { n: 40, ms: 300.2 },
      compileShader: { n: 80, ms: 12 },
      uniform1f: { n: 9000, ms: 40 },
    },
    bySec: { '2': 120, '3': 900.4, '5': 40 },
    frames: 412,
    glFrames: 380,
    glFrameMs: 3050.3,
    // Два кадра в задаче на 3,1 с, один — в задаче на 4,0 с, один — вне длинных задач.
    frameLog: [[3105, 2.5], [3500, 3], [4010, 1.5], [8000, 4]],
    contexts: { n: 1, ms: 1250.6 },
  };
  const longtasks: LongTask[] = [{ t: 3100, d: 1238 }, { t: 4000, d: 640 }, { t: 900, d: 51 }, { t: 7000, d: 50 }];

  it('называет WebGL, длинные задачи, задачи с кадром карты, роды вызовов, методы, кадры и секунды', () => {
    expect(describeMainThread({ renderer: 'ANGLE (SwiftShader driver)', windowMs: 20_000, gl, longtasks })).toEqual([
      'WebGL: ANGLE (SwiftShader driver)',
      'длинные задачи за 20.0 с: 4, всего 1 979 мс, сверх 50 мс — 1 779 мс (как TBT, но без замедления ЦП; Lighthouse считает с замедлением ×4)',
      'самые длинные: 1 238 мс на 3.1 с; 640 мс на 4.0 с; 51 мс на 0.9 с; 50 мс на 7.0 с',
      // Главное показание: задача карты длинная, а JS в её кадрах — единицы мс.
      // Журнал в странице короче числа кадров — обрезка называется, а не молчит.
      'длинные задачи с кадром WebGL внутри: 2 из 4, всего 1 878 мс, сверх 50 мс — 1 778 мс; JS кадров в них — 7 мс; журнал кадров обрезан: 4 из 380',
      'создание контекста WebGL: 1, стояло 1 251 мс',
      'внутри вызовов WebGL: 2 173 мс, вызовов 12 460, из них рисования (draw*) 3 100',
      'по родам: шейдеры (сборка программ) 312 мс; загрузка текстур и буферов 610 мс; рисование 1 210 мс; синхронные чтения (ждут GPU-процесс) 0 мс; прочее 40 мс',
      'методы по времени: drawElements 1 210 мс ×3 100; texImage2D 610 мс ×240; getProgramParameter 300 мс ×40; uniform1f 40 мс ×9 000; compileShader 12 мс ×80',
      'кадры requestAnimationFrame: 412, из них с WebGL 380, внутри кадров с WebGL 3 050 мс',
      // Пустая секунда посередине — тоже показание: поток в ней WebGL не трогал.
      'WebGL по секундам, мс: 2с 120 · 3с 900 · 4с 0 · 5с 40',
    ]);
  });

  it('не измеренное называется «не измерено», а не нулём (§4.0)', () => {
    expect(describeMainThread({
      renderer: 'WebGL2 недоступен', windowMs: 20_000, gl: null, longtasks: null, longtasksError: 'longtask не поддержан',
    })).toEqual([
      'WebGL: WebGL2 недоступен',
      'длинные задачи: не измерены — longtask не поддержан',
      'вызовы WebGL: проба не установилась — не измерено',
    ]);
    expect(describeMainThread({ renderer: 'x', windowMs: 15_000, gl: null, longtasks: null })[1])
      .toBe('длинные задачи: не измерены — наблюдатель не установился');
    // Кадры есть, длинных задач нет — сопоставлять не с чем, и это сказано.
    expect(describeMainThread({ renderer: 'x', windowMs: 15_000, gl, longtasks: null }))
      .toContain('длинные задачи с кадром WebGL: не сопоставить — длинные задачи не измерены; журнал кадров обрезан: 4 из 380');
  });

  it('измерено и пусто — ноль задач, без строки «самые длинные» и без обрезки журнала', () => {
    const lines = describeMainThread({
      renderer: 'x', windowMs: 15_000, longtasks: [],
      gl: { calls: {}, bySec: {}, frames: 0, glFrames: 0, glFrameMs: 0, frameLog: [], contexts: { n: 0, ms: 0 } },
    });
    expect(lines[1]).toBe('длинные задачи за 15.0 с: 0, всего 0 мс, сверх 50 мс — 0 мс (как TBT, но без замедления ЦП; Lighthouse считает с замедлением ×4)');
    expect(lines.some((l) => l.startsWith('самые длинные'))).toBe(false);
    expect(lines).toContain('длинные задачи с кадром WebGL внутри: 0 из 0, всего 0 мс, сверх 50 мс — 0 мс; JS кадров в них — 0 мс');
    expect(lines).toContain('создание контекста WebGL: 0, стояло 0 мс');
    expect(lines).toContain('внутри вызовов WebGL: 0 мс, вызовов 0, из них рисования (draw*) 0');
  });
});

describe('проба в странице', () => {
  type W = {
    __gl?: GlStats; __longtasks?: LongTask[] | null; __longtasksError?: string;
    WebGL2RenderingContext?: unknown; PerformanceObserver: unknown; requestAnimationFrame: unknown;
  };
  const w = window as unknown as W;
  const saved = {
    po: w.PerformanceObserver, raf: w.requestAnimationFrame, gl2: w.WebGL2RenderingContext,
    getContext: HTMLCanvasElement.prototype.getContext,
  };
  afterEach(() => {
    w.PerformanceObserver = saved.po;
    w.requestAnimationFrame = saved.raf;
    w.WebGL2RenderingContext = saved.gl2;
    HTMLCanvasElement.prototype.getContext = saved.getContext;
    delete w.__gl; delete w.__longtasks; delete w.__longtasksError;
    vi.restoreAllMocks();
  });

  /** Часы страницы под рукой теста: обёртка меряет performance.now(). */
  let clock = 0;
  /** Свой класс на каждую установку: обёртка не ложится на обёртку прошлого теста. */
  function fakeGL2() {
    return class FakeGL2 {
      tag = 'ctx';
      drawElements(a: number, b: number) { clock += 30; return `${this.tag}:${a + b}`; }
      getProgramParameter(): never { clock += 5; throw new Error('контекст потерян'); }
      get drawingBufferWidth() { return 640; }
    };
  }
  let FakeGL2 = fakeGL2();

  function install(observe: (opts: unknown) => void = () => {}) {
    clock = 1_990;
    FakeGL2 = fakeGL2();
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const seen: Array<{ cb: (list: { getEntries: () => unknown[] }) => void; opts: unknown }> = [];
    w.PerformanceObserver = class {
      cb: (list: { getEntries: () => unknown[] }) => void;
      constructor(cb: (list: { getEntries: () => unknown[] }) => void) { this.cb = cb; }
      observe(opts: unknown) { observe(opts); seen.push({ cb: this.cb, opts }); }
    };
    const pending: Array<(ts: number) => void> = [];
    w.requestAnimationFrame = (cb: (ts: number) => void) => { pending.push(cb); return pending.length; };
    w.WebGL2RenderingContext = FakeGL2;
    // Та же строка, что уходит в page.addInitScript.
    new Function(MAIN_THREAD_PROBE)();
    return { seen, pending };
  }

  it('вызов WebGL проходит как был — аргументы, this, значение, исключение — и считается по секундам', () => {
    install();
    const ctx = new FakeGL2();
    expect(ctx.drawElements(2, 3)).toBe('ctx:5');
    expect(() => ctx.getProgramParameter()).toThrow('контекст потерян');
    // Свойства-геттеры не трогаются: оборачиваются только методы.
    expect(ctx.drawingBufferWidth).toBe(640);
    expect(w.__gl?.calls).toEqual({ drawElements: { n: 1, ms: 30 }, getProgramParameter: { n: 1, ms: 5 } });
    // 1990 + 30 — вызов начался в секунде 1; исключение тоже посчитано (начало 2020 — секунда 2).
    expect(w.__gl?.bySec).toEqual({ '1': 30, '2': 5 });
  });

  it('кадры: всего, с WebGL и время внутри кадров с WebGL', () => {
    const { pending } = install();
    const ctx = new FakeGL2();
    const raf = w.requestAnimationFrame as (cb: (ts: number) => void) => number;
    raf(() => { ctx.drawElements(1, 1); clock += 4; });
    raf(() => { clock += 100; });
    for (const cb of pending.splice(0)) cb(0);
    expect(w.__gl).toMatchObject({ frames: 2, glFrames: 1, glFrameMs: 34 });
    // В журнал — только кадр с WebGL: начало и JS внутри.
    expect(w.__gl?.frameLog).toEqual([[1990, 34]]);
  });

  it('создание контекста WebGL считается, прочие контексты проходят мимо счёта', () => {
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string) {
      clock += type === 'webgl2' ? 700 : 1;
      return { type } as unknown as RenderingContext;
    } as typeof HTMLCanvasElement.prototype.getContext;
    install();
    const canvas = document.createElement('canvas');
    expect(canvas.getContext('webgl2')).toEqual({ type: 'webgl2' });
    expect(canvas.getContext('2d')).toEqual({ type: '2d' });
    expect(w.__gl?.contexts).toEqual({ n: 1, ms: 700 });
  });

  it('длинные задачи — с буфером, до загрузки скрипта тоже видны', () => {
    const { seen } = install();
    expect(seen).toHaveLength(1);
    expect(seen[0].opts).toEqual({ type: 'longtask', buffered: true });
    expect(w.__longtasks).toEqual([]);
    seen[0].cb({ getEntries: () => [{ startTime: 3100.4, duration: 1237.6 }] });
    expect(w.__longtasks).toEqual([{ t: 3100, d: 1238 }]);
  });

  it('наблюдатель не поддержан — null и причина, а не пустой список', () => {
    install(() => { throw new TypeError('longtask не поддержан'); });
    expect(w.__longtasks).toBeNull();
    expect(w.__longtasksError).toBe('longtask не поддержан');
  });
});

describe('флаг --main-thread в map-page-check', () => {
  it('ставит ту же пробу до первого скрипта страницы и печатает её разбор', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/map-tiles/map-page-check.ts'), 'utf-8');
    expect(script).toMatch(/const mainThread = process\.argv\.includes\('--main-thread'\)/);
    expect(script).toMatch(/if \(mainThread\) \{\s*await page\.addInitScript\(MAIN_THREAD_PROBE\);/);
    // Проба ставится ДО перехода на страницу: иначе MapLibre возьмёт методы без обёртки.
    expect(script.indexOf('addInitScript(MAIN_THREAD_PROBE)')).toBeLessThan(script.indexOf('await page.goto('));
    expect(script).toMatch(/describeMainThread\(\{ renderer, windowMs, \.\.\.got \}\)/);
  });
});

/**
 * Главный поток /map глазами браузера на проде (14.10) — разбор для
 * map-page-check --main-thread.
 *
 * Lighthouse (site-audit, прогон 16, медиана трёх) мерит на /map TBT 12,9 с и
 * 14,9 с выполнения приписывает чанку MapLibre, а самовремя JS по профилю ЦП
 * за ту же загрузку — 0,75 с на всю страницу. Остальное главный поток провёл
 * не в JS. Подозрение — внутри вызовов WebGL: в headless Chromium, которым
 * мерят и Lighthouse, и PageSpeed Insights, WebGL рисует программно,
 * SwiftShader (проверено 14.10 в контейнере разработки, Chromium 141:
 * «ANGLE … SwiftShader driver», и failIfMajorPerformanceCaveat такой контекст
 * не отсекает). У человека с видеочипом этой цены нет — но подозрение не
 * причина, пока не измерено.
 *
 * Проба в странице оборачивает методы WebGL и считает время внутри них —
 * всего, по родам вызовов и по секундам, — рядом с длинными задачами браузера
 * и кадрами requestAnimationFrame. Здесь — разбор собранного; собирает браузер.
 *
 * Первая же проверка в контейнере разработки (тот же Chromium 141, страница
 * с одним тяжёлым шейдером) показала, что одного счёта вызовов мало: длинных
 * задач 5,7 с, а внутри вызовов WebGL — 66 мс. Программный рендер стоит не в
 * вызовах, а после кадра: браузер без видеочипа сводит слои тоже программно и
 * для этого читает холст обратно («GPU stall due to ReadPixels» в консоли), —
 * и при создании первого контекста. Поэтому проба пишет ещё кадры с WebGL по
 * времени и время getContext, а разбор кладёт кадры на длинные задачи:
 * задача, в которой карта рисовала кадр, — задача карты, сколько бы JS в ней
 * ни было.
 */

export interface GlCall {
  /** Сколько раз вызван. */
  n: number;
  /** Время внутри вызова, мс. */
  ms: number;
}

export interface GlStats {
  /** Время внутри методов WebGL по имени метода. */
  calls: Record<string, GlCall>;
  /** Время внутри WebGL по секундам от начала навигации: ключ — номер секунды. */
  bySec: Record<string, number>;
  /** Кадры requestAnimationFrame за окно. */
  frames: number;
  /** Из них кадры, в которых были вызовы WebGL, и время внутри этих кадров. */
  glFrames: number;
  glFrameMs: number;
  /**
   * Кадры с WebGL по порядку: [начало от навигации, мс; JS внутри кадра, мс].
   * Не больше FRAME_LOG_CAP — обрезка называется в отчёте, а не молчит.
   */
  frameLog: Array<[number, number]>;
  /** Создание контекстов WebGL (canvas.getContext webgl/webgl2): сколько и сколько стояло. */
  contexts: GlCall;
}

/** Потолок журнала кадров в странице (тот же, что в пробе). */
export const FRAME_LOG_CAP = 5000;

export interface LongTask {
  /** Начало от навигации, мс. */
  t: number;
  /** Длительность, мс. */
  d: number;
}

export interface MainThreadReport {
  renderer: string;
  /** Окно наблюдения от начала навигации, мс. */
  windowMs: number;
  /** null — проба WebGL не установилась: не измерено, а не «нуль». */
  gl: GlStats | null;
  /** null — наблюдатель длинных задач не поддержан или не установился. */
  longtasks: LongTask[] | null;
  longtasksError?: string | null;
}

/**
 * Роды вызовов. Синхронные чтения отдельно и с оговоркой: вызов, который
 * возвращает значение, ждёт, пока GPU-процесс доделает всё ранее отправленное,
 * — в нём оседает время чужого рисования.
 */
const KINDS: Array<{ label: string; names: ReadonlySet<string> }> = [
  {
    label: 'шейдеры (сборка программ)',
    names: new Set([
      'createShader', 'shaderSource', 'compileShader', 'attachShader', 'createProgram', 'linkProgram',
      'getShaderParameter', 'getProgramParameter', 'getShaderInfoLog', 'getProgramInfoLog',
      'bindAttribLocation', 'getAttribLocation', 'getUniformLocation', 'getActiveUniform',
      'getActiveAttrib', 'getUniformBlockIndex', 'uniformBlockBinding',
    ]),
  },
  {
    label: 'загрузка текстур и буферов',
    names: new Set([
      'texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'texStorage2D',
      'bufferData', 'bufferSubData', 'generateMipmap',
    ]),
  },
  {
    label: 'рисование',
    names: new Set([
      'drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements',
      'clear', 'blitFramebuffer',
    ]),
  },
  {
    label: 'синхронные чтения (ждут GPU-процесс)',
    names: new Set([
      'readPixels', 'getError', 'finish', 'getParameter', 'getExtension', 'getSupportedExtensions',
      'checkFramebufferStatus', 'clientWaitSync', 'getSyncParameter', 'getContextAttributes',
    ]),
  },
];

/** Тысячи через пробел, без неразрывных: строки читаются в логе раннера. */
function group(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
const ms = (n: number) => `${group(n)} мс`;
const sec = (n: number) => `${(n / 1000).toFixed(1)} с`;

/** Строки отчёта: что видел главный поток и сколько из этого — WebGL. */
export function describeMainThread(r: MainThreadReport): string[] {
  const lines: string[] = [`WebGL: ${r.renderer}`];

  if (r.longtasks === null) {
    lines.push(`длинные задачи: не измерены — ${r.longtasksError || 'наблюдатель не установился'}`);
  } else {
    const sum = r.longtasks.reduce((s, x) => s + x.d, 0);
    const over = r.longtasks.reduce((s, x) => s + Math.max(0, x.d - 50), 0);
    const top = [...r.longtasks].sort((a, b) => b.d - a.d).slice(0, 5);
    lines.push(
      `длинные задачи за ${sec(r.windowMs)}: ${r.longtasks.length}, всего ${ms(sum)}, сверх 50 мс — ${ms(over)}`
      + ' (как TBT, но без замедления ЦП; Lighthouse считает с замедлением ×4)',
    );
    if (top.length) lines.push(`самые длинные: ${top.map((x) => `${ms(x.d)} на ${sec(x.t)}`).join('; ')}`);
  }

  if (!r.gl) {
    lines.push('вызовы WebGL: проба не установилась — не измерено');
    return lines;
  }

  // Главное показание: длинные задачи, внутри которых карта рисовала кадр.
  // Программный рендер стоит в них после JS кадра, а не в вызовах.
  const log = r.gl.frameLog;
  const cut = r.gl.glFrames > log.length ? `; журнал кадров обрезан: ${group(log.length)} из ${group(r.gl.glFrames)}` : '';
  if (r.longtasks === null) {
    lines.push(`длинные задачи с кадром WebGL: не сопоставить — длинные задачи не измерены${cut}`);
  } else {
    const inside = (lt: LongTask, t: number) => t >= lt.t - 1 && t <= lt.t + lt.d + 1;
    const withFrame = r.longtasks.filter((lt) => log.some(([t]) => inside(lt, t)));
    const sum = withFrame.reduce((s, x) => s + x.d, 0);
    const over = withFrame.reduce((s, x) => s + Math.max(0, x.d - 50), 0);
    const js = log.filter(([t]) => withFrame.some((lt) => inside(lt, t))).reduce((s, [, d]) => s + d, 0);
    lines.push(
      `длинные задачи с кадром WebGL внутри: ${withFrame.length} из ${r.longtasks.length}, всего ${ms(sum)}, `
      + `сверх 50 мс — ${ms(over)}; JS кадров в них — ${ms(js)}${cut}`,
    );
  }
  lines.push(`создание контекста WebGL: ${group(r.gl.contexts.n)}, стояло ${ms(r.gl.contexts.ms)}`);

  const entries = Object.entries(r.gl.calls);
  const total = entries.reduce((s, [, c]) => s + c.ms, 0);
  const count = entries.reduce((s, [, c]) => s + c.n, 0);
  const draws = entries.filter(([name]) => name.startsWith('draw')).reduce((s, [, c]) => s + c.n, 0);
  lines.push(`внутри вызовов WebGL: ${ms(total)}, вызовов ${group(count)}, из них рисования (draw*) ${group(draws)}`);

  const kinds = KINDS.map((k) => ({
    label: k.label,
    ms: entries.filter(([name]) => k.names.has(name)).reduce((s, [, c]) => s + c.ms, 0),
  }));
  const known = kinds.reduce((s, k) => s + k.ms, 0);
  lines.push(`по родам: ${[...kinds, { label: 'прочее', ms: total - known }].map((k) => `${k.label} ${ms(k.ms)}`).join('; ')}`);

  const topCalls = entries.sort((a, b) => b[1].ms - a[1].ms).slice(0, 8);
  if (topCalls.length) {
    lines.push(`методы по времени: ${topCalls.map(([name, c]) => `${name} ${ms(c.ms)} ×${group(c.n)}`).join('; ')}`);
  }

  lines.push(
    `кадры requestAnimationFrame: ${group(r.gl.frames)}, из них с WebGL ${group(r.gl.glFrames)}, `
    + `внутри кадров с WebGL ${ms(r.gl.glFrameMs)}`,
  );

  const secs = Object.keys(r.gl.bySec).map(Number).filter((s) => Number.isFinite(s));
  if (secs.length) {
    const from = Math.min(...secs);
    const to = Math.max(...secs);
    const cells: string[] = [];
    for (let s = from; s <= to; s++) cells.push(`${s}с ${group(r.gl.bySec[String(s)] ?? 0)}`);
    lines.push(`WebGL по секундам, мс: ${cells.join(' · ')}`);
  }
  return lines;
}

/**
 * Проба в странице (14.10). Строкой, а не функцией: tsx (esbuild) оборачивает
 * именованные функции в помощник __name, которого в странице нет (урок
 * SHIFT_OBSERVER в layout-shifts).
 *
 * Методы WebGL оборачиваются на прототипах до первого скрипта страницы —
 * MapLibre получает контекст уже с обёрнутыми методами. Обёртка ничего не
 * меняет в вызове: те же аргументы, тот же this, то же значение и то же
 * исключение; только время до и после.
 */
export const MAIN_THREAD_PROBE = `(() => {
  var now = function () { return performance.now(); };
  var gl = {
    calls: {}, bySec: {}, frames: 0, glFrames: 0, glFrameMs: 0,
    frameLog: [], contexts: { n: 0, ms: 0 },
  };
  var total = 0;
  window.__gl = gl;
  window.__longtasks = null;
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        window.__longtasks.push({ t: Math.round(e.startTime), d: Math.round(e.duration) });
      });
    }).observe({ type: 'longtask', buffered: true });
    window.__longtasks = [];
  } catch (e) {
    window.__longtasksError = String((e && e.message) || e);
  }
  function wrap(proto) {
    if (!proto) return;
    Object.getOwnPropertyNames(proto).forEach(function (name) {
      var desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc || typeof desc.value !== 'function' || name === 'constructor') return;
      var orig = desc.value;
      proto[name] = function () {
        var s = now();
        try {
          return orig.apply(this, arguments);
        } finally {
          var d = now() - s;
          var c = gl.calls[name] || (gl.calls[name] = { n: 0, ms: 0 });
          c.n++;
          c.ms += d;
          total += d;
          var k = String(Math.floor(s / 1000));
          gl.bySec[k] = (gl.bySec[k] || 0) + d;
        }
      };
    });
  }
  wrap(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
  wrap(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
  var canvas = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
  var getContext = canvas && canvas.getContext;
  if (typeof getContext === 'function') {
    canvas.getContext = function (type) {
      if (!/webgl/i.test(String(type))) return getContext.apply(this, arguments);
      var s = now();
      try {
        return getContext.apply(this, arguments);
      } finally {
        gl.contexts.n++;
        gl.contexts.ms += now() - s;
      }
    };
  }
  var raf = window.requestAnimationFrame;
  if (typeof raf === 'function') {
    window.requestAnimationFrame = function (cb) {
      return raf.call(window, function (ts) {
        var s = now();
        var before = total;
        try {
          return cb(ts);
        } finally {
          gl.frames++;
          if (total > before) {
            var js = now() - s;
            gl.glFrames++;
            gl.glFrameMs += js;
            if (gl.frameLog.length < ${FRAME_LOG_CAP}) gl.frameLog.push([Math.round(s), Math.round(js * 10) / 10]);
          }
        }
      });
    };
  }
})()`;

/** Имя рендерера WebGL — то же, что пишет webglReport карты при сбое. */
export const WEBGL_RENDERER = `(() => {
  try {
    var gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'WebGL2 недоступен';
    var dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)).slice(0, 120);
  } catch (e) {
    return 'WebGL2: исключение ' + String((e && e.name) || e);
  }
})()`;

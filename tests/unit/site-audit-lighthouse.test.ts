// @vitest-environment node
/**
 * Расшифровка Lighthouse в scripts/site-audit.py (14.10) — вызовом на
 * синтетическом отчёте, а не по тексту скрипта (правило 13.10).
 *
 * Прогон 8 показал TBT 11,7 с на /map и 1,3 с на главной, а чьи это секунды,
 * отчёт не говорил: в итог попадали только баллы. Теперь под таблицей —
 * «что тормозит»: элемент LCP и его фазы, главный поток, скрипты по времени
 * выполнения, сторонние, неиспользуемый JS, длинные задачи, вес. Чего нет в
 * отчёте, того нет и в расшифровке: молчание не печатается как «хорошо».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts/site-audit.py');
const PAGE = 'https://vedarai.ru/map';
let dir = '';

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'site-audit-lh-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function run(report: unknown, name: string): { row: string; details: string | null } {
  const json = join(dir, `${name}.json`);
  const md = join(dir, `${name}.md`);
  writeFileSync(json, typeof report === 'string' ? report : JSON.stringify(report));
  const row = execFileSync('python3', [SCRIPT, 'lighthouse', PAGE, json, md], { encoding: 'utf-8' }).trim();
  return { row, details: existsSync(md) ? readFileSync(md, 'utf-8') : null };
}

/** Отчёт формы Lighthouse 12: узел LCP и фазы — внутри списка таблиц. */
const LH12 = {
  categories: {
    performance: { score: 0.33 }, seo: { score: 0.92 }, accessibility: { score: 0.92 }, 'best-practices': { score: 0.96 },
  },
  audits: {
    'largest-contentful-paint': { displayValue: '6.2 s' },
    'cumulative-layout-shift': { displayValue: '0.153' },
    'total-blocking-time': { displayValue: '11,720 ms' },
    'largest-contentful-paint-element': {
      details: {
        type: 'list',
        items: [
          { type: 'table', items: [{ node: { selector: 'main > div.map-hero > img', snippet: '&lt;img src="/images/map.webp" alt="Карта"&gt;' } }] },
          { type: 'table', items: [
            { phase: 'TTFB', timing: 612.4 }, { phase: 'Load Delay', timing: 1203 },
            { phase: 'Load Time', timing: 288 }, { phase: 'Render Delay', timing: 4101 },
          ] },
        ],
      },
    },
    'mainthread-work-breakdown': { details: { items: [
      { group: 'other', groupLabel: 'Прочее', duration: 900 },
      { group: 'scriptEvaluation', groupLabel: 'Выполнение скриптов', duration: 8200 },
      { group: 'styleLayout', groupLabel: 'Стили и вёрстка', duration: 1400 },
      { group: 'garbageCollection', groupLabel: 'Сборка мусора', duration: 100 },
    ] } },
    'bootup-time': { details: { items: [
      { url: 'https://vedarai.ru/_next/static/chunks/app/map/page-1a2b.js', total: 2100 },
      { url: 'https://vedarai.ru/_next/static/chunks/maplibre-9f8e.js', total: 5400 },
      { url: 'https://mc.yandex.ru/metrika/tag.js', total: 310 },
    ] } },
    'third-party-summary': { details: { items: [
      { entity: 'unpkg', blockingTime: 40, transferSize: 51200 },
      { entity: { text: 'Yandex Metrica' }, blockingTime: 290, transferSize: 122880 },
    ] } },
    'unused-javascript': { details: { overallSavingsBytes: 460800, items: [
      { url: 'https://vedarai.ru/_next/static/chunks/maplibre-9f8e.js', wastedBytes: 204800 },
      { url: 'https://mc.yandex.ru/metrika/tag.js', wastedBytes: 40960 },
    ] } },
    'long-tasks': { details: { items: [{ duration: 2100 }, { duration: 640 }, { duration: 95 }] } },
    'layout-shifts': { details: { items: [
      { node: { selector: 'div.chips' }, score: 0.021 },
      { node: { selector: 'div.map-panel > p' }, score: 0.142,
        subItems: { type: 'subitems', items: [{ cause: 'Web font loaded' }, { cause: 'Injected iframe' }] } },
    ] } },
    'total-byte-weight': { numericValue: 3145728 },
  },
};

describe('lighthouse_summary: строка таблицы и «что тормозит»', () => {
  it('строка таблицы — баллы и метрики, как прежде', () => {
    const { row } = run(LH12, 'lh12');
    expect(row).toBe(`| ${PAGE} | 33 | 92 | 92 | 96 | 6.2 s | 0.153 | 11,720 ms |`);
  });

  it('расшифровка называет элемент LCP, фазы, главный поток и самые тяжёлые скрипты по убыванию', () => {
    const { details } = run(LH12, 'lh12-det');
    const d = details ?? '';
    expect(d).toContain(`**${PAGE}** — TBT 11,720 ms, LCP 6.2 s`);
    expect(d).toContain('элемент LCP: `main > div.map-hero > img` — `<img src="/images/map.webp" alt="Карта">`');
    expect(d).toContain('фазы LCP: ответ сервера 612 мс, задержка загрузки 1 203 мс, загрузка 288 мс, задержка отрисовки 4 101 мс');
    // Главный поток — три самые тяжёлые группы по убыванию.
    expect(d).toContain('главный поток: Выполнение скриптов 8 200 мс, Стили и вёрстка 1 400 мс, Прочее 900 мс');
    // Свой скрипт — путём, чужой — с хостом; порядок — по времени выполнения.
    const line = d.split('\n').find((l) => l.includes('скрипты по времени выполнения')) ?? '';
    expect(line.indexOf('maplibre-9f8e.js 5 400 мс')).toBeGreaterThan(-1);
    expect(line.indexOf('maplibre-9f8e.js')).toBeLessThan(line.indexOf('page-1a2b.js'));
    expect(line).toContain('/_next/static/chunks/app/map/page-1a2b.js 2 100 мс');
    expect(line).toContain('mc.yandex.ru/metrika/tag.js 310 мс');
  });

  it('сторонние — по времени блокировки, неиспользуемый JS, длинные задачи и вес', () => {
    const { details } = run(LH12, 'lh12-tail');
    const d = details ?? '';
    expect(d).toContain('сторонние: Yandex Metrica — блокировка 290 мс, 120 КБ; unpkg — блокировка 40 мс, 50 КБ');
    expect(d).toContain('неиспользуемый JS: 450 КБ (/_next/static/chunks/maplibre-9f8e.js 200 КБ; mc.yandex.ru/metrika/tag.js 40 КБ)');
    expect(d).toContain('длинных задач: 3, самая длинная 2 100 мс');
    expect(d).toContain('вес страницы: 3 072 КБ');
  });

  it('сдвиги вёрстки: самый сильный первым, с долей и причиной', () => {
    const { details } = run(LH12, 'lh12-cls');
    const line = (details ?? '').split('\n').find((l) => l.startsWith('- сдвиги вёрстки')) ?? '';
    expect(line).toBe('- сдвиги вёрстки (CLS 0.153): `div.map-panel > p` 0.142 (Web font loaded); `div.chips` 0.021');
  });

  it('сдвиги в формате Lighthouse 10–11 (layout-shift-elements, без причин) — тоже названы', () => {
    const { ['layout-shifts']: _drop, ...rest } = LH12.audits;
    void _drop;
    const old = { ...LH12, audits: { ...rest,
      'layout-shift-elements': { details: { items: [{ node: { nodeLabel: 'Панель места' }, score: 0.09 }] } } } };
    const { details } = run(old, 'lh11-cls');
    expect(details ?? '').toContain('- сдвиги вёрстки (CLS 0.153): `Панель места` 0.090');
  });

  it('отчёт Lighthouse 10–11: узел LCP прямо в таблице — тоже найден', () => {
    const old = { ...LH12, audits: { ...LH12.audits,
      'largest-contentful-paint-element': { details: { type: 'table', items: [{ node: { nodeLabel: 'Карта края', snippet: '<canvas>' } }] } } } };
    const { details } = run(old, 'lh11');
    expect(details ?? '').toContain('элемент LCP: `Карта края` — `<canvas>`');
  });

  it('аудитов нет — расшифровки нет: молчание не печатается как «хорошо»', () => {
    const { row, details } = run({ categories: { performance: { score: 0.9 } }, audits: {} }, 'empty');
    expect(row).toBe(`| ${PAGE} | 90 | — | — | — | — | — | — |`);
    expect(details).toBeNull();
  });

  it('отчёт не читается — строка «не измерено», а не тишина и не падение', () => {
    const { row, details } = run('{"categories": ', 'broken');
    expect(row).toMatch(new RegExp(`^\\| ${PAGE.replace(/[.]/g, '\\.')} \\| не измерено: отчёт Lighthouse не прочитан`));
    expect(details).toBeNull();
  });
});

/**
 * Горячие функции по трассе Lighthouse (14.10) — вызовом на синтетической
 * трассе и локальном сервере со «своим» чанком.
 *
 * «Скрипты по времени выполнения» называют файл, а файл чанка — сотни модулей:
 * прогон 9 показал 1,4 с на главной в общем чанке 31255 и 7,7 с на /map в
 * ca4dcb09, и править было не по чему. Профиль ЦП называет функцию и место;
 * по месту в своём чанке видны номер модуля webpack и кусок кода.
 */
describe('hot_functions: функции, которые держат главный поток', () => {
  const CHUNK = '(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[31255],{'
    + '7676:(e,t,r)=>{function eB(e){return JSON.parse(e)}},'
    + '8100:function(e,t){function parseModel(){return 1}}}]);';
  const at = (needle: string) => CHUNK.indexOf(needle);
  let server: Server;
  let base = '';
  const seen: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.url ?? '');
      if (req.url === '/_next/static/chunks/31255-abc.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(CHUNK);
        return;
      }
      res.writeHead(404);
      res.end('нет');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); });

  /** Трасса Chrome: профиль ЦП приходит кусками ProfileChunk, время — дельтами в мкс. */
  function trace(own: string) {
    const frame = (id: number, functionName: string, url = '', columnNumber = 0, parent?: number) =>
      ({ id, callFrame: { functionName, url, lineNumber: 0, columnNumber }, ...(parent ? { parent } : {}) });
    const main = {
      nodes: [
        frame(1, '(root)'), frame(2, '(program)', '', 0, 1), frame(3, '(idle)', '', 0, 1),
        frame(4, 'eB', `${own}/_next/static/chunks/31255-abc.js`, at('eB('), 1),
        frame(5, 'parseModel', `${own}/_next/static/chunks/31255-abc.js`, at('parseModel('), 1),
        frame(6, '', 'https://mc.yandex.ru/metrika/tag.js', 10, 1),
        frame(7, 'render', `${own}/`, 5, 1),
        frame(8, 'gone', `${own}/_next/static/chunks/missing-1.js`, 3, 1),
      ],
    };
    // Время выборки i — это дельта i+1 (так считают DevTools); длины равны,
    // как в настоящем профиле. Последняя выборка времени не получает.
    const samples = [4, 4, 4, 5, 3, 2, 6, 7, 8, 4];
    const deltas = [0, 100_000, 100_000, 100_000, 100_000, 5_000_000, 50_000, 50_000, 30_000, 10_000];
    return { traceEvents: [
      { name: 'Profile', pid: 1, id: '0x1', args: { data: { startTime: 0 } } },
      { name: 'ProfileChunk', pid: 1, id: '0x1', args: { data: { cpuProfile: { nodes: main.nodes, samples: samples.slice(0, 5) }, timeDeltas: deltas.slice(0, 5) } } },
      { name: 'ProfileChunk', pid: 1, id: '0x1', args: { data: { cpuProfile: { samples: samples.slice(5) }, timeDeltas: deltas.slice(5) } } },
      // Воркер занят меньше главного потока — его профиль не берётся.
      { name: 'ProfileChunk', pid: 2, id: '0x2', args: { data: {
        cpuProfile: { nodes: [frame(1, '(root)'), frame(2, 'workerFn', `${own}/w.js`, 0, 1)], samples: [2, 2] },
        timeDeltas: [0, 30_000] } } },
    ] };
  }

  function runWithTrace(page: string, traceBody: unknown | null, name: string): Promise<string> {
    const json = join(dir, `${name}.json`);
    const md = join(dir, `${name}.md`);
    const tr = join(dir, `${name}.trace.json`);
    writeFileSync(json, JSON.stringify(LH12));
    if (traceBody !== null) writeFileSync(tr, typeof traceBody === 'string' ? traceBody : JSON.stringify(traceBody));
    return new Promise((ok, fail) => {
      // Асинхронно: сервер в этом же процессе должен успеть ответить скрипту.
      execFile('python3', [SCRIPT, 'lighthouse', page, json, md, tr], { encoding: 'utf-8' }, (err) => {
        if (err) return fail(err);
        ok(existsSync(md) ? readFileSync(md, 'utf-8') : '');
      });
    });
  }

  const hotLines = (d: string) => {
    const lines = d.split('\n');
    const head = lines.findIndex((l) => l.startsWith('- горячие функции'));
    if (head < 0) return [];
    const out = [lines[head]];
    for (const l of lines.slice(head + 1)) { if (!l.startsWith('  - ')) break; out.push(l); }
    return out;
  };

  it('самые затратные функции — первыми, с долей; простой и служебные узлы не в счёт', async () => {
    const d = await runWithTrace(`${base}/`, trace(base), 'hot');
    const [head, first, second, ...rest] = hotLines(d);
    // 300 + 100 + 50 + 30 + 10 мс; (idle) 5 с и (program) не считаются, воркер не взят.
    expect(head).toBe('- горячие функции (самовремя по профилю ЦП, без замедления; занято всего 490 мс):');
    expect(first).toMatch(/^ {2}- 300 мс \(61%\) `eB` — \/_next\/static\/chunks\/31255-abc\.js:1:\d+, модуль 7676: `.*JSON\.parse.*`$/);
    expect(second).toMatch(/^ {2}- 100 мс \(20%\) `parseModel` — \/_next\/static\/chunks\/31255-abc\.js:1:\d+, модуль 8100: `.*parseModel.*`$/);
    expect(rest.join('\n')).toContain('50 мс (10%) `(аноним)` — mc.yandex.ru/metrika/tag.js:1:11');
    expect(d).not.toContain('workerFn');
    expect(d).not.toContain('(idle)');
  });

  it('чужой хост и документ страницы не читаются: место в них не то же между запросами', async () => {
    seen.length = 0;
    const d = await runWithTrace(`${base}/`, trace(base), 'hot-fetch');
    // Свой чанк прочитан один раз на оба места, документ «/» — ни разу.
    expect(seen.filter((u) => u === '/_next/static/chunks/31255-abc.js')).toHaveLength(1);
    expect(seen).not.toContain('/');
    // Чужой скрипт — только место, без чтения и без «не прочитан».
    const yandex = hotLines(d).find((l) => l.includes('mc.yandex.ru')) ?? '';
    expect(yandex).toBe('  - 50 мс (10%) `(аноним)` — mc.yandex.ru/metrika/tag.js:1:11');
    const doc = hotLines(d).find((l) => l.includes('`render`')) ?? '';
    expect(doc).toBe('  - 30 мс (6%) `render` — /:1:6');
  });

  it('свой скрипт не прочитался — так и сказано, а не кусок пустоты', async () => {
    const d = await runWithTrace(`${base}/`, trace(base), 'hot-404');
    const gone = hotLines(d).find((l) => l.includes('missing-1.js')) ?? '';
    expect(gone).toBe('  - 10 мс (2%) `gone` — /_next/static/chunks/missing-1.js:1:4, скрипт не прочитан');
  });

  it('строка встаёт внутрь расшифровки страницы, остальное на месте', async () => {
    const d = await runWithTrace(`${base}/`, trace(base), 'hot-order');
    const lines = d.split('\n');
    const boot = lines.findIndex((l) => l.startsWith('- скрипты по времени выполнения'));
    const hot = lines.findIndex((l) => l.startsWith('- горячие функции'));
    expect(boot).toBeGreaterThan(-1);
    expect(hot).toBeGreaterThan(boot);
    expect(d).toContain('- вес страницы: 3 072 КБ');
  });

  it('трассы нет или она битая — «не прочитана», а не тишина', async () => {
    const missing = await runWithTrace(`${base}/`, null, 'hot-none');
    expect(missing).toMatch(/- горячие функции: трасса не прочитана \(/);
    const broken = await runWithTrace(`${base}/`, '{"traceEvents": [', 'hot-broken');
    expect(broken).toMatch(/- горячие функции: трасса не прочитана \(/);
  });

  it('в трассе нет профиля ЦП — сказано словами', async () => {
    const d = await runWithTrace(`${base}/`, { traceEvents: [{ name: 'TracingStartedInBrowser' }] }, 'hot-noprof');
    expect(d).toContain('- горячие функции: в трассе нет профиля ЦП');
  });

  it('без трассы в аргументах расшифровка прежняя: строки о функциях нет', () => {
    const { details } = run(LH12, 'hot-absent');
    expect(details ?? '').not.toContain('горячие функции');
  });
});

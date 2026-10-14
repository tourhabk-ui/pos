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
import { execFileSync } from 'node:child_process';
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

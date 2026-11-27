#!/usr/bin/env node
/**
 * scripts/seo/gsc-weigh.mjs — вес SEO-находки по трафику из выгрузки Google
 * Search Console (слово владельца 27.11 «1 вариант по seo»).
 *
 * Идея взята у SEO Audit Console (houtini-ai/seo-audit, Apache-2.0): чинить
 * первым то, что вернёт больше кликов, а не то, что громче звучит. Код свой,
 * чужой в проект не копировался.
 *
 * Вход — папка распакованной выгрузки «Эффективность» (Search Console →
 * Эффективность → Экспорт → CSV): «Страницы.csv», «Запросы.csv»,
 * «Диаграмма.csv» или английские «Pages.csv», «Queries.csv», «Chart.csv».
 * Выгрузку в репозиторий не кладут: в ней запросы людей.
 *
 * Как считается вес:
 *  - ожидаемый CTR — CTR САМОГО сайта на той же полосе позиций (1–2, 3–4, …),
 *    а не чужая кривая: у отраслевых кривых здесь нет источника (§4.0);
 *  - недобор кликов страницы — показы × ожидаемый CTR − клики;
 *  - полоса, где показов меньше MIN_BUCKET_IMPRESSIONS, ожидаемого CTR не
 *    даёт: «не известно», а не ноль;
 *  - находка на адресе, которого нет в выгрузке, получает вес «не известен»,
 *    а не нулевой: Google мог не показывать страницу вовсе.
 *
 * Запуск: node scripts/seo/gsc-weigh.mjs <папка> [--findings находки.json]
 * Находки — JSON-массив объектов с полем url (остальные поля сохраняются).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Полосы позиций: нижняя граница включительно, верхняя — нет. */
export const POSITION_BUCKETS = [[1, 3], [3, 5], [5, 8], [8, 11], [11, 16], [16, 21], [21, 31], [31, Infinity]];
/** Меньше показов в полосе — ожидаемый CTR не считается. */
export const MIN_BUCKET_IMPRESSIONS = 100;
/** Меньше показов у страницы — её недобор не ранжируется: шум. */
export const MIN_PAGE_IMPRESSIONS = 30;
/** Меньше кликов за период — отчёт говорит, что числа годятся для порядка, а не для обещаний. */
export const LOW_DATA_CLICKS = 100;

const FILES = {
  pages: ['Страницы.csv', 'Pages.csv'],
  queries: ['Запросы.csv', 'Queries.csv'],
  chart: ['Диаграмма.csv', 'Chart.csv', 'Dates.csv'],
};

/** CSV с кавычками: запрос может содержать запятую. BOM снимается. */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

/** «1.25%», «1,25», «8.6» → число; пусто или мусор — null, а не ноль. */
export function toNumber(s) {
  const t = String(s ?? '').trim().replace('%', '').replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Строки таблицы: ключ (страница, запрос, дата), клики, показы, позиция. */
export function tableRows(text) {
  const [, ...body] = parseCsv(text);
  return body.map((r) => ({
    key: r[0],
    clicks: toNumber(r[1]),
    impressions: toNumber(r[2]),
    position: toNumber(r[4]),
  }));
}

export function positionBucket(position) {
  if (position === null || !(position >= 1)) return null;
  const b = POSITION_BUCKETS.find(([lo, hi]) => position >= lo && position < hi);
  if (!b) return null;
  return b[1] === Infinity ? `${b[0]}+` : `${b[0]}-${b[1] - 1}`;
}

/** CTR сайта по полосе позиций. Полоса с малым числом показов CTR не даёт. */
export function siteCtrByBucket(pages) {
  const acc = new Map();
  for (const p of pages) {
    const b = positionBucket(p.position);
    if (!b || p.impressions === null || p.clicks === null) continue;
    const a = acc.get(b) ?? { clicks: 0, impressions: 0, pages: 0 };
    a.clicks += p.clicks; a.impressions += p.impressions; a.pages += 1;
    acc.set(b, a);
  }
  for (const a of acc.values()) {
    a.ctr = a.impressions >= MIN_BUCKET_IMPRESSIONS ? a.clicks / a.impressions : null;
  }
  return acc;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Шаблон адреса: «/places/[slug]», «/routes/[uuid]», «/flights». */
export function urlTemplate(url) {
  const path = String(url).replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
  const segs = path.split('/').filter(Boolean);
  if (segs.length === 0) return '/';
  return '/' + segs.slice(0, 2).map((s, i) => (UUID.test(s) ? '[uuid]' : i === 0 ? s : '[slug]')).join('/');
}

/** Недобор кликов по каждой странице с достаточным числом показов, крупный — первым. */
export function weighPages(pages, baseline = siteCtrByBucket(pages)) {
  return pages
    .filter((p) => p.impressions !== null && p.impressions >= MIN_PAGE_IMPRESSIONS && p.clicks !== null)
    .map((p) => {
      const ctr = baseline.get(positionBucket(p.position))?.ctr ?? null;
      return {
        url: p.key, clicks: p.clicks, impressions: p.impressions, position: p.position,
        expectedCtr: ctr,
        missedClicks: ctr === null ? null : Math.max(0, p.impressions * ctr - p.clicks),
      };
    })
    .sort((a, b) => (b.missedClicks ?? -1) - (a.missedClicks ?? -1) || b.impressions - a.impressions);
}

/** Вес находок аудита: по адресу из выгрузки; адреса нет — вес не известен. */
export function weighFindings(findings, pages) {
  const baseline = siteCtrByBucket(pages);
  const byUrl = new Map(pages.map((p) => [normalizeUrl(p.key), p]));
  return findings
    .map((f) => {
      const p = byUrl.get(normalizeUrl(f.url));
      if (!p) return { ...f, weight: null, weight_note: 'адреса нет в выгрузке: Google его не показывал или выгрузка обрезана — вес не известен' };
      const ctr = baseline.get(positionBucket(p.position))?.ctr ?? null;
      return {
        ...f,
        weight: {
          clicks: p.clicks, impressions: p.impressions, position: p.position, expectedCtr: ctr,
          missedClicks: ctr === null || p.clicks === null || p.impressions === null ? null : Math.max(0, p.impressions * ctr - p.clicks),
        },
      };
    })
    .sort((a, b) => score(b) - score(a));
}

/** Порядок: недобор, затем клики, затем показы; без веса — в конце, но не нулём в данных. */
function score(f) {
  if (!f.weight) return -1;
  return (f.weight.missedClicks ?? 0) * 1e6 + (f.weight.clicks ?? 0) * 1e3 + (f.weight.impressions ?? 0) / 1e3;
}

function normalizeUrl(u) {
  return String(u).trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
}

/** Прочитать выгрузку из папки. Чего нет — так и сказано, а не пустой список. */
export function readExport(dir) {
  const out = { missing: [] };
  for (const [kind, names] of Object.entries(FILES)) {
    const name = names.find((n) => existsSync(join(dir, n)));
    if (!name) { out.missing.push(kind); out[kind] = null; continue; }
    out[kind] = tableRows(readFileSync(join(dir, name), 'utf8'));
  }
  return out;
}

/** Отчёт словами. */
export function report(exp) {
  const lines = [];
  if (!exp.pages) return ['Файла со страницами в выгрузке нет: вес находок посчитать не из чего.'];
  const clicks = exp.pages.reduce((s, p) => s + (p.clicks ?? 0), 0);
  const impressions = exp.pages.reduce((s, p) => s + (p.impressions ?? 0), 0);
  if (exp.chart?.length) lines.push(`Период: ${exp.chart[0].key} — ${exp.chart[exp.chart.length - 1].key}.`);
  lines.push(`Страниц в выгрузке: ${exp.pages.length}; клики ${clicks}, показы ${impressions}.`);
  if (clicks < LOW_DATA_CLICKS) {
    lines.push(`Кликов за период меньше ${LOW_DATA_CLICKS}: недобор в доли клика — шум. Числа годятся, чтобы выбрать порядок работы, а не чтобы обещать трафик.`);
  }
  lines.push('', 'CTR сайта по позиции (ожидаемый CTR берётся отсюда):');
  const baseline = siteCtrByBucket(exp.pages);
  for (const [lo, hi] of POSITION_BUCKETS) {
    const b = hi === Infinity ? `${lo}+` : `${lo}-${hi - 1}`;
    const a = baseline.get(b);
    if (!a) continue;
    lines.push(`  ${b}: ${a.clicks}/${a.impressions} показов, ${a.pages} стр. — ${a.ctr === null ? `не известно (меньше ${MIN_BUCKET_IMPRESSIONS} показов)` : `${(a.ctr * 100).toFixed(2)}%`}`);
  }
  const tmpl = new Map();
  for (const p of exp.pages) {
    const t = urlTemplate(p.key);
    const a = tmpl.get(t) ?? { clicks: 0, impressions: 0, pages: 0 };
    a.clicks += p.clicks ?? 0; a.impressions += p.impressions ?? 0; a.pages += 1; tmpl.set(t, a);
  }
  lines.push('', 'Шаблоны адресов по показам:');
  for (const [t, a] of [...tmpl].sort((x, y) => y[1].impressions - x[1].impressions).slice(0, 15)) {
    lines.push(`  ${t}: ${a.pages} стр., показы ${a.impressions}, клики ${a.clicks}`);
  }
  lines.push('', `Недобор кликов (страницы от ${MIN_PAGE_IMPRESSIONS} показов):`);
  for (const w of weighPages(exp.pages).slice(0, 15)) {
    const miss = w.missedClicks === null ? 'не известно' : w.missedClicks.toFixed(1);
    lines.push(`  ${miss}  ${w.url} — клики ${w.clicks}, показы ${w.impressions}, позиция ${w.position}`);
  }
  if (exp.missing.length) lines.push('', `В выгрузке нет: ${exp.missing.join(', ')}.`);
  return lines;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Укажите папку распакованной выгрузки Search Console.');
    process.exit(2);
  }
  const exp = readExport(dir);
  const fi = process.argv.indexOf('--findings');
  if (fi > 0) {
    if (!exp.pages) { console.error('Файла со страницами в выгрузке нет: вес находок посчитать не из чего.'); process.exit(1); }
    const findings = JSON.parse(readFileSync(process.argv[fi + 1], 'utf8'));
    process.stdout.write(JSON.stringify(weighFindings(findings, exp.pages), null, 2) + '\n');
  } else {
    process.stdout.write(report(exp).join('\n') + '\n');
  }
}

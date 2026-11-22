/**
 * lib/planner/print-html.ts — документ «Скачать PDF» планера (/planner).
 *
 * Документ пишется в новое окно через `document.write` — окно того же
 * источника, что сайт. До разбора 06.11 название и описание тура, строки
 * предупреждений дня и плана вставлялись в разметку как есть, а название и
 * описание тура пишет оператор — роль с самостоятельной регистрацией. Тур с
 * `<img onerror=…>` в названии выполнял бы чужой скрипт у туриста при нажатии
 * «Скачать PDF», с его сессией.
 *
 * Поэтому сборка вынесена из компонента в чистую функцию, и КАЖДОЕ значение
 * проходит `escapeHtml` здесь, а не у вызывающего: забытый вызов у одного из
 * полей и был дырой. Класс строки предупреждения — только из закрытого
 * списка; адрес снимка — только https или путь сайта. Сторож — исполнение:
 * tests/unit/planner-print-html.test.tsx.
 *
 * Макет 21.11 (слово владельца: «дизайн плана в PDF — кринж лютый»):
 *   1. обложка — название, даты, кто едет, снимок из тура с подписью автора;
 *   2. программа по дням компактно: многодневный тур одним блоком, превью
 *      снимка, короткая строка погоды, ссылка и QR на тур vedarai.ru, не
 *      больше одной строки-предупреждения о месте программы дня;
 *   3. смета таблицей с «Посчитано X из Y позиций»;
 *   4. одна страница «Безопасность и разрешения» без повторов;
 *   подвал на каждой странице: «Заявка — не бронь, подтверждает оператор».
 * Шрифты с кириллицей — свои (public/fonts/print, OFL), цвета — сайта (лава,
 * ночь, океан); цен на снимках и водяных знаков нет.
 */
import QRCode from 'qrcode';
import { escapeHtml } from '@/lib/text/escape-html';
import { countedLine, NO_PRICES_YET } from '@/lib/planner/estimate';
import {
  dayCardWarning, planShapeWarnings, runLabel, safetyBlock, safetyItemText, SAFETY_BLOCK_TITLE, tourRuns,
  type ViewDay,
} from '@/lib/planner/day-card-view';

export interface PrintPlanDay {
  /** Номер карточки в списке (1, 2, 3 …), а не ключ дня. */
  num: number;
  confirmed: boolean;
  title: string;
  /** Подпись рода дня («Прилёт», «Тур оператора») или null. */
  badge: string | null;
  priceLine: string;
  description: string;
  /** Зона и сложность одной строкой. */
  meta: string;
  warnings: readonly string[];
  /** Что взять по прогнозу (#3394, п.6); нет прогноза — нет строки. */
  weatherKit?: string | null;
  /** Род дня (arrival, activity, …); нет — занятие. */
  dayType?: string;
  /** Тур дня: по нему многодневный тур собирается в один блок, ему — снимок и QR. */
  tourId?: string | null;
  tourTitle?: string | null;
  /** Адрес страницы тура на vedarai.ru (абсолютный или путь сайта). */
  tourHref?: string | null;
}

export interface PrintPlanEstimate {
  people: number;
  lines: ReadonlyArray<{ label: string; basis: string; source: string; total: readonly [number, number] | null }>;
  total: readonly [number, number];
  perPerson: readonly [number, number];
  assumptions: readonly string[];
  /** Строки без цены — «не вошло в итог» (разбор планера 14.11, смета-7); нет — не передали. */
  unpriced?: readonly string[];
}

export interface PrintPhoto { src: string; caption: string }

export interface PrintPlanInput {
  dateRange: string;
  adults: number;
  childAges: readonly number[];
  days: readonly PrintPlanDay[];
  estimate: PrintPlanEstimate | null;
  warnings: ReadonlyArray<{ severity: string; message: string; type?: string }>;
  fmt: (n: number) => string;
  /** Источник сайта — шрифты и пути снимков; нет — vedarai.ru. */
  origin?: string;
  /** Снимок обложки — из тура плана, с подписью автора; без подписи не ставится. */
  cover?: PrintPhoto | null;
  /** Снимки туров по ID — превью в программе; только с подписью автора. */
  photos?: Readonly<Record<string, PrintPhoto>>;
}

const WARNING_CLASSES = new Set(['critical', 'important', 'info']);
const SITE = 'https://vedarai.ru';

/** Фирменные цвета сайта (app/globals.css): лава, ночь, океан. */
const C = { lava: '#E8734A', night: '#0D1117', ocean: '#00A8CC', ink: '#1A1714', mist: '#6B6560', line: '#ECE5DD', cream: '#FBF7F2', warn: '#9A6A0B', danger: '#B91C1C' };

function style(origin: string): string {
  const f = (file: string) => `${origin}/fonts/print/${file}.woff2`;
  const CYR = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116';
  const LAT = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
  return `
  @font-face { font-family: 'VInter'; font-weight: 100 900; src: url(${f('inter-cyrillic-wght-normal')}) format('woff2'); unicode-range: ${CYR}; }
  @font-face { font-family: 'VInter'; font-weight: 100 900; src: url(${f('inter-latin-wght-normal')}) format('woff2'); unicode-range: ${LAT}; }
  @font-face { font-family: 'VPlayfair'; font-weight: 400 900; src: url(${f('playfair-display-cyrillic-wght-normal')}) format('woff2'); unicode-range: ${CYR}; }
  @font-face { font-family: 'VPlayfair'; font-weight: 400 900; src: url(${f('playfair-display-latin-wght-normal')}) format('woff2'); unicode-range: ${LAT}; }
  @page { size: A4; margin: 14mm 14mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: 'VInter', 'Noto Sans', 'DejaVu Sans', Arial, sans-serif; color: ${C.ink}; margin: 0; line-height: 1.45; font-size: 11.5px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { max-width: 182mm; margin: 0 auto; }
  h1, h2 { font-family: 'VPlayfair', Georgia, 'DejaVu Serif', serif; font-weight: 700; margin: 0; }
  .brand { font-size: 10px; letter-spacing: .18em; text-transform: uppercase; color: ${C.lava}; font-weight: 700; }
  .cover { page-break-after: always; padding-top: 18mm; }
  .cover h1 { font-size: 34px; line-height: 1.15; margin: 10px 0 8px; color: ${C.night}; }
  .cover .who { font-size: 14px; color: ${C.mist}; }
  .cover .rule { width: 56px; height: 4px; background: ${C.lava}; border-radius: 2px; margin: 18px 0; }
  .cover figure { margin: 22px 0 0; }
  .cover img { width: 100%; height: 92mm; object-fit: cover; border-radius: 10px; display: block; }
  figcaption { font-size: 9.5px; color: ${C.mist}; margin-top: 5px; }
  .contents { margin-top: 18px; display: flex; gap: 18px; font-size: 11px; color: ${C.mist}; }
  .contents strong { color: ${C.night}; }
  h2 { font-size: 20px; color: ${C.night}; margin: 0 0 10px; }
  .section { margin-bottom: 18px; }
  /* Заголовок не отрывается от своего содержимого (прод 22.11: «Смета на
     группу» внизу страницы, таблица — на следующей). */
  h2 { break-after: avoid; page-break-after: avoid; }
  .estimate-block { break-inside: avoid; page-break-inside: avoid; }
  table.estimate thead { display: table-header-group; }
  table.estimate tr { break-inside: avoid; page-break-inside: avoid; }
  .note { font-size: 10.5px; color: ${C.mist}; margin: 0 0 8px; }
  .plan-note { font-size: 10.5px; border-left: 3px solid ${C.lava}; padding: 4px 8px; margin: 0 0 6px; background: ${C.cream}; }
  .row { display: grid; grid-template-columns: 22mm 1fr auto; gap: 10px; padding: 9px 0; border-top: 1px solid ${C.line}; page-break-inside: avoid; }
  .row:first-of-type { border-top: 0; }
  .day-num { font-weight: 700; color: ${C.lava}; font-size: 12px; white-space: nowrap; }
  .day-when { font-size: 9.5px; color: ${C.mist}; margin-top: 1px; }
  .day-date { font-size: 9.5px; color: ${C.mist}; }
  .day-title { font-weight: 650; font-size: 12.5px; color: ${C.night}; }
  .day-badge { display: inline-block; font-size: 9px; font-weight: 600; padding: 1px 6px; border-radius: 999px; background: ${C.cream}; color: ${C.mist}; margin-left: 6px; vertical-align: 1px; }
  .day-price { font-size: 10.5px; color: ${C.ink}; font-weight: 600; margin-left: 6px; white-space: nowrap; }
  .day-desc { font-size: 10.5px; color: ${C.mist}; margin-top: 2px; }
  .day-meta { font-size: 10px; color: ${C.mist}; margin-top: 3px; }
  .day-warn { font-size: 10px; color: ${C.warn}; margin-top: 3px; }
  .day-link { font-size: 10px; color: ${C.ocean}; margin-top: 3px; word-break: break-all; }
  .aside { display: flex; gap: 8px; align-items: flex-start; }
  .thumb { width: 34mm; }
  .thumb img { width: 34mm; height: 22mm; object-fit: cover; border-radius: 6px; display: block; }
  .thumb figcaption { font-size: 8px; margin-top: 2px; }
  .qr { width: 20mm; height: 20mm; display: block; }
  .confirmed .day-title::after { content: ' ✓'; color: #2E7D32; }
  table.estimate { width: 100%; border-collapse: collapse; font-size: 11px; }
  table.estimate th { text-align: left; font-weight: 600; color: ${C.mist}; font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em; border-bottom: 1.5px solid ${C.night}; padding: 5px 4px; }
  table.estimate td { border-bottom: 1px solid ${C.line}; padding: 5px 4px; vertical-align: top; }
  table.estimate td.sum, table.estimate th.sum { text-align: right; white-space: nowrap; }
  table.estimate td.none { color: ${C.mist}; }
  table.estimate tfoot td { border-bottom: 0; font-weight: 700; font-size: 12.5px; color: ${C.night}; padding-top: 8px; }
  .price-row { display: flex; justify-content: space-between; font-size: 11px; margin-top: 4px; }
  .counted { font-size: 10.5px; color: ${C.night}; font-weight: 600; margin-top: 6px; }
  .safety { page-break-before: always; }
  .warning { font-size: 10.5px; padding: 5px 0 5px 10px; border-left: 3px solid ${C.line}; margin-bottom: 5px; }
  .warning-critical { border-color: ${C.danger}; color: ${C.danger}; }
  .warning-important { border-color: ${C.lava}; }
  .warning-info { border-color: ${C.ocean}; color: ${C.ink}; }
  .page-foot { position: fixed; bottom: 0; left: 0; right: 0; text-align: center; font-size: 9px; color: ${C.mist}; border-top: 1px solid ${C.line}; padding-top: 3px; background: #fff; }
  .sheet { padding-bottom: 9mm; }
  .glance { margin-top: 16px; border-top: 1px solid ${C.line}; }
  .glance div { display: flex; gap: 10px; font-size: 11px; padding: 5px 0; border-bottom: 1px solid ${C.line}; }
  .glance strong { color: ${C.lava}; min-width: 20mm; }
  @media screen { body { background: #f3f0ec; } .sheet { background: #fff; padding: 14mm; margin: 12px auto; } .page-foot { position: static; margin: 10px 0 20px; } }
`;
}

/** Адрес снимка или ссылки — только https или путь сайта; остальное отброшено. */
function safeUrl(u: string | null | undefined, origin: string): string | null {
  if (!u) return null;
  if (u.startsWith('/') && !u.startsWith('//')) return `${origin}${u}`;
  if (/^https:\/\/[^\s"'<>]+$/.test(u)) return u;
  return null;
}

/** QR ссылки — свой SVG из матрицы qrcode, без чужой разметки. */
function qrSvg(url: string): string {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(y, x)) d += `M${x + 2} ${y + 2}h1v1h-1z`;
  return `<svg data-print-qr class="qr" viewBox="0 0 ${n + 4} ${n + 4}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="${C.night}"/></svg>`;
}

/** «Прогноз для зоны дня: Пасмурно, -18…-9 °C, …» → «−18…−9 °C, пасмурно». */
export function shortWeatherFromKit(kit: string | null | undefined): string | null {
  const m = kit ? /^Прогноз для зоны дня: ([^,]+), ([+-]?\d+)…([+-]?\d+) °C/.exec(kit) : null;
  if (!m) return null;
  const t = (s: string) => { const n = Number(s); return n < 0 ? `−${Math.abs(n)}` : String(n); };
  return `${t(m[2])}…${t(m[3])} °C, ${m[1].trim().toLowerCase()}`;
}

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
/** «2026-11-24 — 2026-12-04» → «24 ноября — 4 декабря 2026»; не разобрано — как есть. */
function humanRange(range: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s*—\s*(\d{4})-(\d{2})-(\d{2})$/.exec(range.trim());
  if (!m) return range;
  const [, y1, m1, d1, y2, m2, d2] = m;
  const a = `${Number(d1)} ${MONTHS_GEN[Number(m1) - 1]}${y1 !== y2 ? ` ${y1}` : ''}`;
  return `${a} — ${Number(d2)} ${MONTHS_GEN[Number(m2) - 1]} ${y2}`;
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
/** Дата дня N от начала поездки: «24 ноя»; начала нет — пусто. */
function dayDate(range: string, num: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(range.trim());
  if (!m) return '';
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + num - 1));
  return `${t.getUTCDate()} ${MONTHS_SHORT[t.getUTCMonth()]}`;
}

export function buildPlanPrintHtml(input: PrintPlanInput): string {
  const e = escapeHtml;
  const { fmt } = input;
  // Источник — только https-адрес сайта или локальный (разработка, снимок макета).
  const origin = input.origin && /^(https:\/\/[^/\s"'<>]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/.test(input.origin) ? input.origin : SITE;
  // Вилка, у которой нижняя граница равна верхней, — одна сумма, а не «X — X».
  const rubRange = ([a, b]: readonly [number, number]) => (a === b ? `${fmt(a)} ₽` : `${fmt(a)} — ${fmt(b)} ₽`);
  const range = input.dateRange ? e(humanRange(input.dateRange)) : '';
  const daysCount = input.days.length;
  const people = `${e(input.adults)} ${pluralRu(input.adults, 'взрослый', 'взрослых', 'взрослых')}`;
  const kids = input.childAges.length > 0 ? ` и дети: ${input.childAges.map((a) => e(a)).join(', ')} лет` : '';

  const view: ViewDay[] = input.days.map((d) => ({
    day: d.num, type: d.dayType ?? (d.tourId ? 'activity' : undefined), title: d.title,
    dayWarnings: d.warnings, weatherKit: d.weatherKit ?? undefined,
    realTour: d.tourId ? { tourId: d.tourId, title: d.tourTitle ?? undefined } : null,
  }));
  const runs = tourRuns(view);
  // Подряд одинаковые дни без тура («подходящего тура нет» ×4) — тоже одним
  // блоком: четыре одинаковые строки читаются как шум.
  for (let i = 0; i < input.days.length; i++) {
    const a = input.days[i];
    if (runs.has(a.num) || a.tourId) continue;
    let j = i;
    while (j + 1 < input.days.length && !input.days[j + 1].tourId && input.days[j + 1].num === input.days[j].num + 1
      && input.days[j + 1].title === a.title && input.days[j + 1].description === a.description
      && (input.days[j + 1].dayType ?? '') === (a.dayType ?? '') && a.dayType !== 'activity' && a.dayType !== undefined) j++;
    if (j > i) for (let k = i; k <= j; k++) runs.set(input.days[k].num, { tourId: '', first: a.num, last: input.days[j].num });
    i = j;
  }
  const photoFor = (d: PrintPlanDay): PrintPhoto | null => {
    const p = d.tourId ? input.photos?.[d.tourId] : undefined;
    return p && p.caption?.trim() && safeUrl(p.src, origin) ? p : null;
  };

  const when = (first: number, last?: number) => {
    const a = dayDate(input.dateRange, first);
    if (!a) return '';
    return `<div class="day-when">${e(last ? `${a} — ${dayDate(input.dateRange, last)}` : a)}</div>`;
  };
  // Коротко на обложке — те же блоки, что в программе.
  const glance = input.days.flatMap((d) => {
    const run = runs.get(d.num);
    if (run && run.first !== d.num) return [];
    return [`<div><strong>${run ? `Дни ${e(run.first)}–${e(run.last)}` : `День ${e(d.num)}`}</strong><span>${e(d.title)}</span></div>`];
  }).join('');
  const rows = input.days.map((d, i) => {
    const run = runs.get(d.num);
    if (run && run.first !== d.num) return '';
    const label = run ? runLabel(run).replace(/^Дни /, '') : String(d.num);
    const warn = dayCardWarning(view[i]);
    const weather = shortWeatherFromKit(d.weatherKit);
    const href = safeUrl(d.tourHref ?? null, origin);
    const photo = photoFor(d);
    const photoHtml = photo
      ? `<figure class="thumb"><img data-print-photo src="${e(safeUrl(photo.src, origin)!)}" alt=""/><figcaption>${e(photo.caption)}</figcaption></figure>`
      : '';
    const desc = d.description.length > 220 ? `${d.description.slice(0, 219).trimEnd()}…` : d.description;
    return `<div class="row${d.confirmed ? ' confirmed' : ''}">
  <div><div class="day-num">${run ? 'Дни ' : 'День '}${e(label)}</div>${when(d.num, run?.last)}</div>
  <div>
    <div><span class="day-title">${e(d.title)}</span>${d.badge ? `<span class="day-badge">${e(d.badge)}</span>` : ''}${d.priceLine ? `<span class="day-price">${e(d.priceLine)}</span>` : ''}</div>
    ${desc ? `<div class="day-desc">${e(desc)}</div>` : ''}
    <div class="day-meta">${e(d.meta)}${weather ? ` · ${e(weather)}` : ''}</div>
    ${warn ? `<div class="day-warn">${e(warn)}</div>` : ''}
    ${href ? `<div class="day-link">${e(href.replace(/^https:\/\//, ''))}</div>` : ''}
  </div>
  <div class="aside">${photoHtml}${href ? qrSvg(href) : ''}</div>
</div>`;
  }).filter(Boolean).join('\n');

  const shape = planShapeWarnings(input.warnings.map((w) => ({ type: w.type ?? '', severity: w.severity, message: w.message })));
  const planNotes = shape.map((w) => `<p class="plan-note">${e(w.message)}</p>`).join('');

  const est = input.estimate;
  // Сумма — только цены туров и выбранного жилья (слово владельца 14.11
  // «5 -1»); строка без суммы говорит, кто называет цену. Ни одной суммы —
  // итога нет: «0 ₽» его бы выдумал.
  const priced = est ? est.lines.some((l) => l.total) : false;
  const estimateHtml = est ? `<div class="section estimate-block">
  <h2>Смета на группу · ${e(est.people)} чел.</h2>
  <p class="note">Цены туров — от операторов, выбранного жилья — по ценам на платформе; остальное называет исполнитель. Без авиабилетов до Камчатки.</p>
  <table class="estimate"><thead><tr><th>Позиция</th><th>Основа</th><th class="sum">Сумма</th></tr></thead>
  <tbody>${est.lines.map((l) => `<tr><td>${e(l.label)}</td><td>${e(l.basis)}${l.source === 'offer' ? ' · выбрано' : ''}</td><td class="sum${l.total ? '' : ' none'}"><span>${l.total ? e(rubRange(l.total)) : 'цены нет'}</span></td></tr>`).join('')}</tbody>
  <tfoot><tr><td colspan="2">Итого на группу</td><td class="sum">${priced ? e(rubRange(est.total)) : 'не посчитано'}</td></tr></tfoot></table>
  <div class="counted">${e(countedLine(est.lines))}${priced && est.unpriced && est.unpriced.length > 0 ? ` — не вошло в итог: ${e(est.unpriced.join('; '))}` : ''}</div>
  ${priced ? `<div class="price-row"><span>На человека</span><span>${e(rubRange(est.perPerson))}</span></div>` : `<div class="price-row"><span>${e(NO_PRICES_YET)}</span><span></span></div>`}
  ${est.assumptions.map((a) => `<p class="note" style="margin-top:4px">${e(a)}</p>`).join('')}
</div>` : '';

  const items = safetyBlock(view, input.warnings.map((w) => ({ type: w.type ?? '', severity: w.severity, message: w.message })));
  const safetyHtml = items.length > 0 ? `<div class="section safety">
  <h2>${e(SAFETY_BLOCK_TITLE)}</h2>
  <p class="note">Всё, что касается безопасности, разрешений и снаряжения, — один раз, с днями, к которым относится. Обстановку на свои даты проверьте ближе к выезду.</p>
  ${items.map((it) => `<div class="warning warning-${WARNING_CLASSES.has(it.severity) ? it.severity : 'info'}">${e(safetyItemText(it))}</div>`).join('\n')}
</div>` : '';

  const cover = input.cover && input.cover.caption?.trim() ? safeUrl(input.cover.src, origin) : null;
  const coverHtml = cover && input.cover
    ? `<figure><img data-print-photo src="${e(cover)}" alt=""/><figcaption>${e(input.cover.caption)}</figcaption></figure>`
    : '';

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"/>
<title>Маршрут по Камчатке${range ? ` | ${range}` : ''}</title>
<style>${style(origin)}</style></head><body>
<div class="page-foot">Заявка — не бронь, подтверждает оператор · vedarai.ru</div>
<div class="sheet">
<section class="cover">
  <div class="brand">Ведар · Камчатка</div>
  <h1>Маршрут по Камчатке</h1>
  <div class="who">${range ? `${range} · ` : ''}${e(daysCount)} ${pluralRu(daysCount, 'день', 'дня', 'дней')} · ${people}${kids}</div>
  <div class="rule"></div>
  ${coverHtml}
  <div class="contents"><span><strong>1</strong> Программа по дням</span><span><strong>2</strong> Смета</span><span><strong>3</strong> ${e(SAFETY_BLOCK_TITLE)}</span></div>
  <div class="glance">${glance}</div>
</section>
<section class="section program">
  <h2>Программа по дням</h2>
  ${planNotes}
  ${rows}
</section>
${estimateHtml}
${safetyHtml}
</div>
</body></html>`;
}

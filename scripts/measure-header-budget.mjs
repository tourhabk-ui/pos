/**
 * Измерение бюджета ширины шапки главной в реальном рендере (issue #893).
 *
 * Зачем скрипт, если есть юнит-сторож. Класс дефекта, из-за которого он написан,
 * текстом не ловится: `.v7 .icn` объявлял `width:44px;height:44px`, всё
 * формально верно, а фактическая зона нажатия сжималась до 19–37px дефолтным
 * `flex-shrink:1`. Видно это только layout'ом, то есть браузером.
 * `tests/unit/home-header-budget.test.ts` следит за декларациями, которые делают
 * сжатие невозможным; этот скрипт проверяет результат.
 *
 * Две вещи, без которых измерение было бы фантазией:
 *   1. CSS берётся ИЗ ИСХОДНИКА `_HomeV8Client.tsx`, не копируется руками —
 *      иначе стенд разойдётся с кодом и будет мерить свою фантазию;
 *   2. шрифт — настоящий Manrope из `.next` (метрики глифов определяют ширину
 *      бренда и пилюли, а значит и весь дефицит). Без сборки скрипт честно
 *      предупреждает, что мерит fallback-шрифтом.
 *
 * Запуск:
 *   npm run build                      # нужен один раз, за шрифтами
 *   node scripts/measure-header-budget.mjs
 *
 * Код возврата 1, если нарушен любой инвариант: зона нажатия < 44px,
 * горизонтальное переполнение, обрезанная пилюля статуса.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const MIN_TOUCH = 44;
// Ширины: 320 — крайний узкий, 360/390/412 — реальные телефоны,
// 439/440 — границы порога бренда, 480 — max-width полосы, 768 — планшет.
const WIDTHS = [320, 360, 390, 412, 439, 440, 480, 768];

// Состояния пилюли из lib/home/safety-pill.ts. Худшее по ширине обязательно:
// именно оно определяет, сходится ли бюджет.
const PILLS = [
  { tone: 'calm', text: 'Спокойно' },
  { tone: 'danger', text: 'Опасность' },
  { tone: 'warning', text: '5+ предупреждений' },
];

const SRC = readFileSync(join(ROOT, 'app/_home/_HomeV8Client.tsx'), 'utf-8');
const CSS = /const CSS = `([\s\S]*?)\n`;/.exec(SRC)?.[1];
if (!CSS) {
  console.error('Не разобран CSS из _HomeV8Client.tsx — изменилась форма `const CSS = ...`');
  process.exit(1);
}

/** Настоящие @font-face Manrope из собранного CSS; URL → абсолютный file://. */
function manropeFaces() {
  const cssDir = join(ROOT, '.next/static/css');
  if (!existsSync(cssDir)) return '';
  let built = '';
  for (const f of readdirSync(cssDir)) {
    if (f.endsWith('.css')) built += readFileSync(join(cssDir, f), 'utf-8');
  }
  return (built.match(/@font-face\{[^}]*Manrope[^}]*\}/g) ?? [])
    .map((r) => r.replace(/url\(\/_next\/static\/media\/([^)]+)\)/g,
      (_m, file) => `url(file://${join(ROOT, '.next/static/media', file)})`))
    .join('\n');
}

const faces = manropeFaces();
if (!faces) {
  console.warn('ВНИМАНИЕ: Manrope не найден в .next — мерим fallback-шрифтом.');
  console.warn('Абсолютные ширины будут неточны. Сначала `npm run build`.\n');
}

// EmergencyAction, variant=header — инлайновые стили из компонента.
const SOS_STYLE = [
  'display:inline-flex', 'align-items:center', 'justify-content:center',
  'min-width:44px', 'min-height:44px', 'color:var(--danger)', 'text-decoration:none',
  'font-weight:700', 'letter-spacing:0.08em', 'text-transform:uppercase',
  'gap:6px', 'padding:0 12px', 'border-radius:999px', 'font-size:11px',
  'border:1px solid color-mix(in srgb, var(--danger) 45%, transparent)',
  'background:color-mix(in srgb, var(--danger) 8%, transparent)',
].join(';');
const ICON = '<svg class="li" viewBox="0 0 24 24" width="19" height="19"><path d="M12 3v2"/></svg>';

function html(pill, unconstrained = false) {
  return `<!doctype html><html data-v7theme="light"><head><meta charset="utf-8">
<style>${faces}
html,body{margin:0;padding:0}
/* next/font выставляет переменную на body; в стенде задаём тем же именем. */
:root{--font-manrope:Manrope}
${CSS}</style></head>
<body><div class="v7" data-v7theme="light"><div class="topbar">
<div class="in"${unconstrained ? ' style="max-width:none;flex-wrap:nowrap"' : ''}>
<span class="brand" id="brand">Ведар</span><span class="sp"></span>
<a class="pill pill-${pill.tone}" id="pill"><i></i>${pill.text}</a>
<a id="sos" href="/sos" style="${SOS_STYLE}"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 3v2"/></svg><span>SOS</span></a>
<button class="icn" id="theme" aria-label="Тема">${ICON}</button>
<a class="icn" id="profile" href="/profile" aria-label="Личный кабинет">${ICON}</a>
</div></div></div></body></html>`;
}

// Браузер: сначала пробуем штатный, затем браузер образа (в CI-образах сборка
// может не совпадать с версией playwright — тогда `playwright install` не нужен).
async function launch() {
  const fallback = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  try {
    return await chromium.launch();
  } catch (e) {
    if (!existsSync(fallback)) throw e;
    return await chromium.launch({ executablePath: fallback });
  }
}

const browser = await launch();

// ── Бюджет: натуральные ширины, без сжатия и без переноса ──────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 400 } });
  const p = await ctx.newPage();
  await p.setContent(html(PILLS[2], true), { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  const n = await p.evaluate(() => {
    const w = (s) => +document.querySelector(s).getBoundingClientRect().width.toFixed(2);
    return { brand: w('#brand'), pill: w('#pill'), sos: w('#sos'), icn: w('#theme') };
  });
  const gaps = 60; // 12px × 5 зазоров между шестью детьми
  const need = n.brand + n.pill + n.sos + n.icn * 2 + gaps;
  console.log('=== БЮДЖЕТ ШИРИНЫ ШАПКИ (худшее состояние пилюли) ===');
  console.log(`бренд «Ведар»    ${n.brand.toFixed(2)}  уступает первым (ничего не сообщает, никуда не ведёт)`);
  console.log(`пилюля статуса   ${n.pill.toFixed(2)}  НЕ сокращать: обрезка скрывала активную опасность (833120d)`);
  console.log(`SOS              ${n.sos.toFixed(2)}  НЕ сокращать: безопасность, min-width 44`);
  console.log(`иконки × 2       ${(n.icn * 2).toFixed(2)}  НЕ сокращать: §3 дизайн-языка`);
  console.log(`зазоры           ${gaps.toFixed(2)}`);
  console.log(`ИТОГО нужно      ${need.toFixed(2)}`);
  for (const vw of [360, 390, 412]) {
    const avail = vw - 40;
    const d = need - avail;
    console.log(`  ${vw}px: доступно ${avail} → ${d > 0 ? `дефицит ${d.toFixed(2)}px` : 'сходится'}`);
  }
  await ctx.close();
}

// ── Инварианты по всем сочетаниям ─────────────────────────────────────────
console.log('\n=== ПРОВЕРКА (ширины × состояния пилюли) ===');
console.log('| vw | пилюля | бренд | иконка | SOS | высота шапки | переполнение | пилюля обрезана |');
console.log('|---:|---|---|---:|---:|---:|---|---|');
let failures = 0;
for (const width of WIDTHS) {
  for (const pill of PILLS) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 } });
    const p = await ctx.newPage();
    await p.setContent(html(pill), { waitUntil: 'load' });
    await p.evaluate(() => document.fonts.ready);
    const m = await p.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const doc = document.documentElement;
      const pillEl = document.querySelector('#pill');
      return {
        brandShown: getComputedStyle(document.querySelector('#brand')).display !== 'none',
        icn: Math.min(r('#theme').width, r('#theme').height, r('#profile').width, r('#profile').height),
        sos: Math.min(r('#sos').width, r('#sos').height),
        barH: r('.topbar .in').height,
        over: doc.scrollWidth > doc.clientWidth,
        clipped: pillEl.scrollWidth > pillEl.clientWidth + 1,
      };
    });
    const bad = m.icn < MIN_TOUCH || m.sos < MIN_TOUCH || m.over || m.clipped;
    if (bad) failures++;
    console.log(`| ${width} | ${pill.text} | ${m.brandShown ? 'виден' : 'скрыт'} | ${m.icn.toFixed(0)}${m.icn < MIN_TOUCH ? ' ✗' : ''} | ${m.sos.toFixed(0)}${m.sos < MIN_TOUCH ? ' ✗' : ''} | ${m.barH.toFixed(0)} | ${m.over ? 'ДА ✗' : 'нет'} | ${m.clipped ? 'ДА ✗' : 'нет'} |`);
    await ctx.close();
  }
}
await browser.close();

console.log(failures === 0
  ? '\nВсе инварианты соблюдены: зоны >= 44px, переполнения нет, статус читается целиком.'
  : `\nНАРУШЕНИЙ: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

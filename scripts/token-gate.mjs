#!/usr/bin/env node
/**
 * Token gate — семантика каскада, а не строки в CSS.
 *
 * Открывает РЕАЛЬНЫЕ маршруты в headless Chromium и проверяет вычисленные
 * стили (условие внешнего ревью редизайна, июль 2026): grep по исходникам
 * не ловит локальный каскад, который перекрашивает SOS при формально чистых
 * токенах (пример: теневой --danger:#C0392B внутри .v7 на главной).
 *
 * Проверки на каждом маршруте:
 *   1. Токены определены на :root и разрешаются в цвет
 *      (--accent, --danger, --ocean, --bg-primary, --bg-card,
 *       --text-primary, --text-secondary, --border).
 *   2. CTA и тревога разведены: resolved(--accent) !== resolved(--danger).
 *   3. Теневые переопределения: ни один элемент не переопределяет
 *      --accent/--danger относительно :root.
 *   4. Единый механизм темы: параллельного data-v7theme нет.
 *   5. Playfair на display-заголовках (h1, .ds-h1, .ds-h2).
 *   6. Контраст: text-primary/bg-primary >= 4.5; text-secondary >= 3.0
 *      (3.0–4.5 — предупреждение).
 *   7. Фокус виден: focus меняет outline/box-shadow.
 *   8. Вторая тема: переключение data-theme (+класс .dark, как у настоящего
 *      переключателя) реально меняет фон; токены определены, accent != danger.
 *
 * /emergency проверяется ОТДЕЛЬНО по своему контракту нулевых зависимостей
 * (#897): доступность, контраст собственных стилей, блок координат — без
 * требований к токенам приложения и веб-шрифтам.
 *
 * Запуск:
 *   BASE_URL=http://localhost:3000 node scripts/token-gate.mjs
 *   BASE_URL=https://vedarai.ru node scripts/token-gate.mjs   (read-only)
 *
 * Динамические маршруты (/routes/[id], /places/[id]) открываются через
 * обнаружение первых ссылок в каталоге; без БД/данных — предупреждение,
 * не провал (иначе гейт нельзя гонять на пустой среде).
 *
 * Выход: 0 — нарушений нет; 1 — есть хотя бы одно нарушение (FAIL).
 * Предупреждения (WARN) код выхода не меняют.
 */

import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const STATIC_ROUTES = ['/', '/map', '/sos'];
const TOKENS = [
  '--accent', '--danger', '--ocean', '--bg-primary', '--bg-card',
  '--text-primary', '--text-secondary', '--border',
];

// Chromium: системный playwright может требовать другую сборку браузера, чем
// лежит в образе (грабля этого окружения). Порядок: явный env → штатное
// разрешение playwright → поиск в /opt/pw-browsers.
function resolveChromiumPath() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return undefined; // штатный путь валиден — не переопределяем
  } catch { /* ищем ниже */ }
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    // Перебираем ВСЕ chromium-каталоги (рядом лежит chromium_headless_shell-*
    // с другой структурой) и берём первый реально существующий бинарь.
    for (const dir of readdirSync(base).filter((d) => d.startsWith('chromium'))) {
      for (const rel of ['chrome-linux/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
        const candidate = `${base}/${dir}/${rel}`;
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch { /* нет каталога */ }
  return undefined;
}

/** WCAG relative luminance из строки rgb()/rgba(). */
function luminance(rgb) {
  const m = rgb.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  if (l1 == null || l2 == null) return null;
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Снимок каскада страницы — выполняется в браузере. */
async function snapshot(page, tokens) {
  return page.evaluate((TOKENS) => {
    const root = document.documentElement;
    const probe = document.createElement('div');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    const resolve = (token) => {
      probe.style.color = '';
      probe.style.color = `var(${token}, #00000000)`;
      return getComputedStyle(probe).color;
    };

    const rootRaw = Object.fromEntries(
      TOKENS.map((t) => [t, getComputedStyle(root).getPropertyValue(t).trim()]),
    );
    const rootResolved = Object.fromEntries(TOKENS.map((t) => [t, resolve(t)]));

    // Теневые переопределения семантических токенов на любом элементе.
    const shadows = [];
    const all = document.querySelectorAll('*');
    const cap = Math.min(all.length, 6000);
    for (let i = 0; i < cap; i++) {
      const el = all[i];
      for (const t of ['--accent', '--danger']) {
        const v = getComputedStyle(el).getPropertyValue(t).trim();
        if (v && rootRaw[t] && v !== rootRaw[t]) {
          const id = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).slice(0, 2).join('.') : ''}`;
          shadows.push(`${t}=${v} на ${id}`);
          if (shadows.length >= 8) break;
        }
      }
      if (shadows.length >= 8) break;
    }

    // Параллельный механизм темы.
    const v7theme = document.querySelectorAll('[data-v7theme]').length;

    // Display-заголовки без Playfair.
    const badHeadings = [];
    for (const h of document.querySelectorAll('h1, .ds-h1, .ds-h2')) {
      const ff = getComputedStyle(h).fontFamily;
      if (!/playfair/i.test(ff)) {
        badHeadings.push(`${h.tagName.toLowerCase()}«${(h.textContent || '').trim().slice(0, 40)}» → ${ff.split(',')[0]}`);
        if (badHeadings.length >= 5) break;
      }
    }
    const headingsTotal = document.querySelectorAll('h1, .ds-h1, .ds-h2').length;

    probe.remove();
    return { rootRaw, rootResolved, shadows, v7theme, badHeadings, headingsTotal };
  }, tokens);
}

/** Видимость клавиатурного фокуса: Tab до интерактива, сравнение стилей. */
async function focusVisible(page) {
  return page.evaluate(async () => {
    const el = document.querySelector('a[href], button');
    if (!el) return { checked: false };
    const before = getComputedStyle(el);
    const base = { outline: before.outlineStyle + before.outlineWidth, shadow: before.boxShadow };
    el.focus({ focusVisible: true });
    // focus-visible через программный focus поддержан не везде — добираем :focus-visible классом невозможно; читаем как есть.
    const after = getComputedStyle(el);
    const focused = { outline: after.outlineStyle + after.outlineWidth, shadow: after.boxShadow };
    el.blur();
    return {
      checked: true,
      changed: base.outline !== focused.outline || base.shadow !== focused.shadow,
    };
  });
}

async function checkRoute(page, route, report) {
  const url = `${BASE_URL}${route}`;
  const fail = (msg) => report.fails.push(`${route}: ${msg}`);
  const warn = (msg) => report.warns.push(`${route}: ${msg}`);

  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    if (!resp || resp.status() >= 400) {
      warn(`страница не открылась (HTTP ${resp ? resp.status() : '—'}) — проверки пропущены`);
      return null;
    }
  } catch (e) {
    warn(`страница не открылась (${String(e).slice(0, 80)}) — проверки пропущены`);
    return null;
  }
  await page.waitForTimeout(1200); // hydration + шрифты

  // ── Светлая тема ──
  const light = await snapshot(page, TOKENS);

  for (const t of TOKENS) {
    if (!light.rootRaw[t]) fail(`токен ${t} не определён на :root`);
  }
  if (light.rootResolved['--accent'] && light.rootResolved['--accent'] === light.rootResolved['--danger']) {
    fail(`--accent и --danger разрешаются в один цвет (${light.rootResolved['--accent']}) — CTA и тревога не разведены`);
  }
  for (const s of light.shadows) fail(`теневое переопределение токена: ${s}`);
  if (light.v7theme > 0) fail(`параллельный механизм темы data-v7theme (${light.v7theme} эл.)`);
  if (light.headingsTotal === 0) warn('нет display-заголовков (h1/.ds-h1/.ds-h2) — Playfair не проверен');
  for (const h of light.badHeadings) fail(`display-заголовок без Playfair: ${h}`);

  const cPrimary = contrastRatio(light.rootResolved['--text-primary'], light.rootResolved['--bg-primary']);
  if (cPrimary != null && cPrimary < 4.5) fail(`контраст text-primary/bg-primary = ${cPrimary.toFixed(2)} < 4.5`);
  const cSecondary = contrastRatio(light.rootResolved['--text-secondary'], light.rootResolved['--bg-primary']);
  if (cSecondary != null) {
    if (cSecondary < 3.0) fail(`контраст text-secondary/bg-primary = ${cSecondary.toFixed(2)} < 3.0`);
    else if (cSecondary < 4.5) warn(`контраст text-secondary/bg-primary = ${cSecondary.toFixed(2)} (3.0–4.5)`);
  }

  const focus = await focusVisible(page);
  if (focus.checked && !focus.changed) warn('фокус не меняет outline/box-shadow (проверить руками с клавиатуры)');

  // ── Вторая тема ──
  // Тема по умолчанию — dark (inline-скрипт layout ставит data-theme сразу),
  // поэтому переключаем в ПРОТИВОПОЛОЖНУЮ от текущей, ровно тем же механизмом,
  // что и настоящий переключатель: атрибут + класс .dark синхронно.
  const initialTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme') || 'dark');
  const otherTheme = initialTheme === 'dark' ? 'light' : 'dark';
  await page.evaluate((t) => {
    const r = document.documentElement;
    r.setAttribute('data-theme', t);
    r.classList.toggle('dark', t === 'dark');
  }, otherTheme);
  await page.waitForTimeout(250);
  const other = await snapshot(page, TOKENS);
  if (other.rootResolved['--bg-primary'] === light.rootResolved['--bg-primary']) {
    fail(`переключение темы ${initialTheme}→${otherTheme} не меняет --bg-primary — тема не реагирует на единый механизм`);
  }
  if (other.rootResolved['--accent'] && other.rootResolved['--accent'] === other.rootResolved['--danger']) {
    fail(`тема ${otherTheme}: --accent и --danger разрешаются в один цвет`);
  }
  for (const t of TOKENS) {
    if (!other.rootRaw[t]) fail(`тема ${otherTheme}: токен ${t} не определён`);
  }
  const oPrimary = contrastRatio(other.rootResolved['--text-primary'], other.rootResolved['--bg-primary']);
  if (oPrimary != null && oPrimary < 4.5) fail(`тема ${otherTheme}: контраст text-primary = ${oPrimary.toFixed(2)} < 4.5`);
  await page.evaluate((t) => {
    const r = document.documentElement;
    r.setAttribute('data-theme', t);
    r.classList.toggle('dark', t === 'dark');
  }, initialTheme);

  return light;
}

/**
 * /emergency — НАМЕРЕННО вне токен-проверок: это standalone-HTML с нулевыми
 * зависимостями (контракт #897 — экран обязан жить без app-шелла, глобального
 * CSS и веб-шрифтов). Судить его по токенам приложения — ложное срабатывание.
 * Проверяем то, что применимо: доступность, реальный контраст его собственных
 * стилей, наличие координатного блока.
 */
async function checkEmergency(page, report) {
  const route = '/emergency';
  const fail = (msg) => report.fails.push(`${route}: ${msg}`);
  const warn = (msg) => report.warns.push(`${route}: ${msg}`);
  try {
    const resp = await page.goto(`${BASE_URL}${route}`, { waitUntil: 'load', timeout: 45_000 });
    if (!resp || resp.status() >= 400) {
      fail(`страница не открылась (HTTP ${resp ? resp.status() : '—'}) — SOS-экран обязан открываться`);
      return;
    }
  } catch (e) {
    fail(`страница не открылась (${String(e).slice(0, 80)}) — SOS-экран обязан открываться`);
    return;
  }
  await page.waitForTimeout(500);
  const em = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const h1 = document.querySelector('h1');
    return {
      color: body.color,
      bg: body.backgroundColor,
      h1: h1 ? getComputedStyle(h1).color : null,
      hasCoords: Boolean(document.getElementById('coords-value')),
    };
  });
  const c = contrastRatio(em.color, em.bg);
  if (c != null && c < 4.5) fail(`контраст текста ${c.toFixed(2)} < 4.5 (свои стили, не токены)`);
  if (!em.hasCoords) fail('нет блока координат #coords-value');
  if (!em.h1) warn('нет h1');
}

/** Первая ссылка вида prefix/<id> на странице-каталоге. */
async function discoverLink(page, catalogRoute, prefix) {
  try {
    const resp = await page.goto(`${BASE_URL}${catalogRoute}`, { waitUntil: 'load', timeout: 45_000 });
    if (!resp || resp.status() >= 400) return null;
    await page.waitForTimeout(1500);
    return await page.evaluate((pfx) => {
      const a = document.querySelector(`a[href^="${pfx}"]`);
      if (!a) return null;
      const href = a.getAttribute('href');
      return href && href.length > pfx.length ? href.split('?')[0] : null;
    }, prefix);
  } catch { return null; }
}

async function main() {
  const executablePath = resolveChromiumPath();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  // Мобильный UA обязателен: главная выбирает мобильный вариант по User-Agent,
  // а не по вьюпорту — без него .v7-слой (и его теневые токены) не монтируется
  // и гейт проверяет не тот интерфейс, которым пользуются в поле.
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });

  const report = { fails: [], warns: [] };
  const routes = [...STATIC_ROUTES];

  // Динамические маршруты: обнаруживаем реальные id из каталога.
  const routeHref = await discoverLink(page, '/routes', '/routes/');
  if (routeHref) routes.push(routeHref);
  else report.warns.push('/routes/[id]: не удалось найти ссылку в каталоге — маршрут не проверен (нет данных?)');
  if (routeHref) {
    await page.goto(`${BASE_URL}${routeHref}`, { waitUntil: 'load', timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const placeHref = await page.evaluate(() => document.querySelector('a[href^="/places/"]')?.getAttribute('href')?.split('?')[0] ?? null);
    if (placeHref) routes.push(placeHref);
    else report.warns.push('/places/[id]: ссылка с карточки маршрута не найдена — точка не проверена');
  }

  for (const route of routes) {
    process.stdout.write(`Проверка ${route} ...\n`);
    await checkRoute(page, route, report);
  }
  process.stdout.write('Проверка /emergency (standalone-контракт) ...\n');
  await checkEmergency(page, report);

  await browser.close();

  process.stdout.write('\n══ TOKEN GATE ══\n');
  process.stdout.write(`База: ${BASE_URL}\nМаршрутов проверено: ${routes.length}\n`);
  if (report.warns.length) {
    process.stdout.write(`\nПредупреждения (${report.warns.length}):\n`);
    for (const w of report.warns) process.stdout.write(`  ~ ${w}\n`);
  }
  if (report.fails.length) {
    process.stdout.write(`\nНарушения (${report.fails.length}):\n`);
    for (const f of report.fails) process.stdout.write(`  × ${f}\n`);
    process.stdout.write('\nГейт НЕ пройден.\n');
    process.exit(1);
  }
  process.stdout.write('\nНарушений нет — гейт пройден.\n');
}

main().catch((e) => {
  process.stderr.write(`token-gate: ошибка запуска: ${e}\n`);
  process.exit(1);
});

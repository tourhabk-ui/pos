/**
 * Проверка глазами браузера: открывается ли /map с местами (01.10).
 *
 * Скрин владельца 01.10 19:00: карта открылась рельефом, а мест на ней нет
 * вовсе, счётчик стоит на «Загрузка…». Данные при этом целы (проба 634):
 * список страницы отдаёт 382 места, слой мест в хранилище — 382 точки, у 129
 * признак «с маршрутом». Значит, ломается что-то между данными и экраном, и
 * увидеть это можно только в настоящем браузере. Из контейнера разработки ни
 * прод, ни хранилище не открываются — поэтому прогон идёт с раннера.
 *
 * Что делает: открывает /map в Chromium размером с телефон, пишет ошибки
 * консоли, отказы сети и ответы на файлы слоя мест, через 15 и 45 секунд
 * читает счётчик и чипы фильтра и печатает кадр экрана base64-строками
 * (артефакты из контейнера разработки не скачиваются, лог читается).
 *
 * Только чтение: на проде ничего не пишется.
 *
 * Исходы (§4.0): 0 — страница прочитана (вывод — улики, приговор выносит
 * человек); 2 — страница не открылась.
 *
 *   npx tsx scripts/map-tiles/map-page-check.ts [--path /map] [--shot .cache/map-page.jpg]
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const SITE = process.env.SITE_URL ?? 'https://vedarai.ru';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<number> {
  const path = arg('--path', '/map');
  const shot = arg('--shot', '.cache/map-page.jpg');
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 860 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    locale: 'ru-RU',
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}с`;

  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${at()}] консоль ${m.type()}: ${m.text().slice(0, 400)}`);
  });
  page.on('pageerror', (e) => console.log(`[${at()}] ошибка страницы: ${e.message.slice(0, 400)}`));
  page.on('requestfailed', (r) => console.log(`[${at()}] запрос не дошёл: ${r.url().slice(0, 200)} — ${r.failure()?.errorText ?? '?'}`));
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() >= 400) console.log(`[${at()}] ответ ${r.status()}: ${u.slice(0, 200)}`);
    else if (u.includes('.places.geojson') || u.includes('/api/routes?')) {
      console.log(`[${at()}] ответ ${r.status()}: ${u.slice(0, 200)}`);
    }
  });

  try {
    await page.goto(`${SITE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (err) {
    console.log(`страница не открылась: ${err instanceof Error ? err.message : String(err)}`);
    await browser.close();
    return 2;
  }

  for (const wait of [15_000, 30_000]) {
    await page.waitForTimeout(wait);
    const state = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll('button'))
        .map(b => (b.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(t => /^(Все|С маршрутом|Вулканы|Озёра|Источники)/.test(t));
      const counter = Array.from(document.querySelectorAll('p'))
        .map(p => (p.textContent ?? '').trim())
        .find(t => t.startsWith('Точек') || t.startsWith('Загрузка')) ?? null;
      const canvases = document.querySelectorAll('canvas').length;
      return { chips, counter, canvases };
    });
    console.log(`[${at()}] счётчик: ${state.counter ?? 'нет'} · чипы: ${state.chips.join(' | ') || 'нет'} · canvas: ${state.canvases}`);
  }

  await page.screenshot({ path: shot, type: 'jpeg', quality: 55 });
  const b64 = readFileSync(shot).toString('base64');
  console.log(`КАДР ${shot} base64, ${b64.length} знаков:`);
  for (let i = 0; i < b64.length; i += 4000) console.log(`B64:${b64.slice(i, i + 4000)}`);
  console.log('КАДР КОНЕЦ');
  await browser.close();
  return 0;
}

main().then((code) => process.exit(code), (err) => {
  console.log(`проверка упала: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});

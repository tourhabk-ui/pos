/**
 * Офлайн-страницы не ходят клиентской навигацией.
 *
 * Найдено полевым тестом в авиарежиме (владелец, 30.07): экран `/offline`
 * открылся, 112 и номера МЧС на месте — но ВСЕ ТРИ ссылки в блоке «Доступно
 * без сети» показали бесконечный скелетон, включая `/safety/offline`, который
 * лежит в критичном precache.
 *
 * Причина не в кэше, а в типе запроса. `next/link` делает клиентский переход:
 * вместо документа он тянет RSC-пейлоад (`?_rsc=…`). У такого запроса
 * `mode !== 'navigate'`, поэтому ветка service worker'а для навигации его не
 * ловит — он уходит в общую ветку, и офлайн там отдавалась РАЗМЕТКА страницы
 * `/offline`. Роутер Next ждёт пейлоад, получает HTML и виснет навсегда.
 * Закэшированный HTML не спасает, когда запрос идёт не за HTML — поэтому
 * `CRITICAL_URLS` против `OPTIONAL_URLS` здесь ни при чём.
 *
 * Лечение двухслойное, сторож следит за обоими:
 *   1. разметка — офлайн-пути ходят жёсткой `<a>` (переход документом);
 *   2. service worker — RSC-запрос офлайн падает быстро, а не получает HTML.
 *
 * Список страниц НЕ задан здесь руками: он извлекается из `CRITICAL_URLS`
 * самого `sw.js`. Добавят в критичный precache новый экран — он попадёт под
 * сторожа сам.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SW = readFileSync(join(ROOT, 'public/sw.js'), 'utf-8');

/** Список строковых литералов из массива-константы в sw.js. */
function urlList(name: string): string[] {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(SW);
  if (!m) return [];
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

/**
 * Страницы, до которых турист доходит без сети: критичный precache плюс сам
 * `/offline` — service worker отдаёт его по имени как запасной экран.
 */
function offlinePageFiles(): { route: string; file: string }[] {
  const routes = [...new Set([...urlList('CRITICAL_URLS'), '/offline'])];
  return routes
    // Ассеты (.js/.css/.jpg) и роуты без React-страницы (/emergency отдаёт
    // статический HTML через route.ts) отсеиваются существованием файла.
    .filter((r) => r.startsWith('/') && !/\.[a-z0-9]+$/i.test(r))
    .map((route) => ({ route, file: join(ROOT, 'app', route.replace(/^\//, ''), 'page.tsx') }))
    .filter(({ file }) => existsSync(file));
}

const PAGES = offlinePageFiles();

describe('офлайн-страницы найдены', () => {
  it('сторож не сторожит пустоту', () => {
    expect(PAGES.length, 'ни одной офлайн-страницы не разобрано из sw.js')
      .toBeGreaterThanOrEqual(2);
  });
});

describe('офлайн-страницы не используют клиентскую навигацию', () => {
  it.each(PAGES.map((p) => [p.route, p.file] as const))(
    '%s не импортирует next/link',
    (route, file) => {
      const src = readFileSync(file, 'utf-8');
      // Комментарии объясняют ЗАПРЕТ и цитируют next/link — их не считаем кодом.
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(code, `${route}: next/link офлайн тянет RSC-пейлоад и виснет — нужна жёсткая <a>`)
        .not.toMatch(/from\s+['"]next\/link['"]/);
      expect(code, `${route}: <Link> офлайн виснет — нужна жёсткая <a>`)
        .not.toMatch(/<Link[\s/>]/);
    },
  );
});

describe('service worker не подсовывает HTML вместо RSC-пейлоада', () => {
  const code = SW.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('RSC-запрос распознаётся', () => {
    expect(code, 'нет распознавания RSC-запроса — офлайн он получит разметку')
      .toMatch(/_rsc|['"]RSC['"]/);
  });

  it('RSC-ветка отвечает сама и не доходит до общего фолбэка на /offline', () => {
    // Ветка обязана быть ДО общей: иначе упавший RSC снова получит caches.match('/offline').
    const rscAt = code.search(/_rsc|['"]RSC['"]/);
    const genericFallbackAt = code.lastIndexOf("caches.match('/offline')");
    expect(rscAt, 'RSC не распознаётся').toBeGreaterThan(-1);
    expect(genericFallbackAt, 'общий фолбэк на /offline исчез — проверить фикс целиком')
      .toBeGreaterThan(-1);
    expect(rscAt, 'RSC-ветка объявлена после общего фолбэка и не сработает')
      .toBeLessThan(genericFallbackAt);
  });

  it('версия кэша поднята — иначе установленные PWA останутся со старым SW', () => {
    // Правка живёт в самом service worker'е: без бампа CACHE_NAME телефон,
    // на котором приложение уже установлено, продолжит виснуть.
    const m = /const CACHE_NAME = 'kamchatour-v(\d+)'/.exec(SW);
    expect(m, 'не разобрать CACHE_NAME').toBeTruthy();
    expect(Number(m![1]), 'CACHE_NAME не поднимался с версии, где офлайн-навигация была сломана')
      .toBeGreaterThanOrEqual(19);
  });
});

/**
 * Своя карта молчала чёрным полем: воркер MapLibre и чужие хосты в SW.
 *
 * Полевой прогон 01.09, вечер. Сторож молчания в VedarMap назвал «стиль не
 * загрузился · рельеф не пришёл · горизонтали не пришли», событие `error`
 * не стреляло, проба с раннера видела 206 с Range и принятый preflight.
 * То есть файлы отдаются, CORS в порядке — а карта на телефоне пуста.
 *
 * Причина в двух местах, и обе — не в карте:
 *
 * 1. MapLibre GL поднимает воркеры из blob:-URL собственного бандла. На
 *    `/planning` заголовок CSP ставит next.config.js, и в нём не было
 *    `worker-src` — браузер берёт `default-src 'self'` и запрещает blob:.
 *    Воркера нет → тайлы не парсятся → `load` не наступает, а `error`
 *    MapLibre при этом не стреляет. В middleware.ts `worker-src 'self'
 *    blob:` БЫЛ — но его matcher покрывает только /api, /hub, /profile,
 *    /widget и /routes. Правило, живущее не на той странице, — не правило.
 *
 * 2. Service worker перехватывал все GET, включая чужие хосты, и на отказ
 *    сети отдавал РАЗМЕТКУ /offline. Читатель PMTiles (Range-GET) получал
 *    бы HTML вместо 206, MapLibre для горизонталей — HTML вместо GeoJSON.
 *
 * Сторож держит оба, потому что каждый в одиночку воспроизводит чёрное поле.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NEXT_CONFIG = readFileSync(join(process.cwd(), 'next.config.js'), 'utf-8');
const SW = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf-8');
const MIDDLEWARE = readFileSync(join(process.cwd(), 'middleware.ts'), 'utf-8');

/** Все значения Content-Security-Policy из next.config.js. */
function cspValues(): string[] {
  return [...NEXT_CONFIG.matchAll(/key: 'Content-Security-Policy', value: `([^`]+)`/g)].map((m) => m[1]);
}

describe('воркер MapLibre разрешён CSP там, где живёт своя карта', () => {
  it('CSP общих страниц в next.config.js несёт worker-src с blob:', () => {
    const all = cspValues();
    expect(all.length, 'CSP в next.config.js не найдена').toBeGreaterThan(0);
    // Общая политика — та, что содержит хранилище пакетов: по ней и
    // отдаётся /planning. Домашняя (без s3) воркеров не требует.
    const general = all.filter((v) => v.includes('s3.twcstorage.ru'));
    expect(general.length, 'политика с s3.twcstorage.ru не найдена').toBeGreaterThan(0);
    for (const v of general) {
      expect(v).toMatch(/worker-src 'self' blob:/);
      // Safari до 15.5 читает воркеры из child-src.
      expect(v).toMatch(/child-src 'self' blob:/);
    }
  });

  it('middleware не покрывает /planning — полагаться на его worker-src нельзя', () => {
    // Если matcher когда-нибудь расширят на /planning, этот тест можно
    // снять вместе с дублирующим правилом. Пока — держим оба и знаем, почему.
    const m = MIDDLEWARE.match(/matcher:\s*\[([\s\S]*?)\]/);
    expect(m, 'matcher middleware не найден').toBeTruthy();
    expect(m![1]).not.toMatch(/planning/);
    expect(MIDDLEWARE).toMatch(/worker-src \$\{workerSrc\}/);
  });
});

describe('service worker не подменяет чужие хосты разметкой /offline', () => {
  it('чужой origin, кроме тайлов OSM, отдаётся браузеру напрямую', () => {
    const at = SW.indexOf("if (url.origin !== self.location.origin && url.hostname !== TILE_HOST) return;");
    expect(at, 'пропуск чужих хостов не найден').toBeGreaterThan(0);
    // Пропуск стоит ДО общей ветки navigateWithTimeout — иначе он ничего
    // не пропускает.
    const catchAll = SW.indexOf('navigateWithTimeout(request, url.pathname ===');
    expect(catchAll).toBeGreaterThan(at);
  });

  it('пропуск стоит внутри обработчика fetch, после проверки метода', () => {
    const fetchAt = SW.indexOf("self.addEventListener('fetch'");
    const methodAt = SW.indexOf("if (request.method !== 'GET') return;", fetchAt);
    const skipAt = SW.indexOf('url.hostname !== TILE_HOST) return;', fetchAt);
    expect(fetchAt).toBeGreaterThan(0);
    expect(methodAt).toBeGreaterThan(fetchAt);
    expect(skipAt).toBeGreaterThan(methodAt);
  });
});

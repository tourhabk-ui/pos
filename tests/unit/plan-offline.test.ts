/**
 * Офлайн-план («Мой план 2.0», C-6; владелец: «карт-бланш»).
 *
 * Offline-first — правило платформы (CLAUDE.md): за городом на Камчатке
 * связи нет, а план — это координаты дней. Три ноги офлайна:
 * 1) GPX дней плана — открывается в Organic Maps/Garmin без нас и без сети;
 * 2) deep-link geo: на точку дня — навигатор телефона, офлайн;
 * 3) service worker кэширует /trip/[token] и share-API — страница живёт
 *    без интернета, если её открыли онлайн хоть раз.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPlanGpx, planGpxContentDisposition, planGpxFilename, planGpxPoints } from '@/lib/trips/plan-gpx';

const ROOT = process.cwd();
const SW = readFileSync(join(ROOT, 'public/sw.js'), 'utf-8');
const GPX_API = readFileSync(join(ROOT, 'app/api/trips/share/[token]/gpx/route.ts'), 'utf-8');
const SHARE_UI = readFileSync(join(ROOT, 'app/trip/[token]/_TripShareClient.tsx'), 'utf-8');

const days = [
  { day: 1, title: 'Авачинский вулкан', coords: [53.255, 158.833] as [number, number], date: '2026-08-12' },
  { day: 2, title: 'Халактырский пляж <"чёрный песок">', coords: [53.03, 158.89] as [number, number] },
  { day: 3, title: 'День без координат' },
];

describe('C-6: GPX дней плана', () => {
  it('waypoint на каждый день с координатами; день без координат пропущен', () => {
    const gpx = buildPlanGpx('Мой план', days);
    expect(gpx.match(/<wpt /g)?.length).toBe(2);
    expect(gpx).toContain('<name>День 1: Авачинский вулкан</name>');
    expect(gpx).not.toContain('День без координат');
  });

  it('дни связаны нитью маршрута (rte) по порядку', () => {
    const gpx = buildPlanGpx('Мой план', days);
    expect(gpx).toContain('<rte>');
    expect(gpx.indexOf('lat="53.255"')).toBeLessThan(gpx.indexOf('lat="53.03"'));
  });

  it('XML экранирован — названия с кавычками и скобками не ломают файл', () => {
    const gpx = buildPlanGpx('Мой план', days);
    expect(gpx).toContain('&lt;&quot;чёрный песок&quot;&gt;');
    expect(gpx).not.toMatch(/<"чёрный/);
  });

  it('дата дня — в desc, имя файла — ASCII-слаг названия', () => {
    const gpx = buildPlanGpx('Мой план', days);
    expect(gpx).toContain('<desc>2026-08-12</desc>');
    // Раньше слаг оставлял кириллицу — Content-Disposition это ByteString,
    // символ с кодом >255 бросал исключение, и КАЖДОЕ скачивание GPX было 500
    // (дефолт «Маршрут ГГГГ-ММ-ДД» кириллический всегда). Сквозной прогон 14.08.
    expect(planGpxFilename('Мой план на Камчатку')).toBe('moy_plan_na_kamchatku.gpx');
    expect(planGpxFilename('Маршрут 2026-08-21')).toBe('marshrut_2026_08_21.gpx');
    expect(planGpxFilename('!!!')).toBe('plan.gpx');
  });

  it('Content-Disposition целиком ASCII, оригинал названия — в filename*', () => {
    const header = planGpxContentDisposition('Маршрут 2026-08-21');
    for (const ch of header) expect(ch.charCodeAt(0)).toBeLessThan(256);
    expect(header).toMatch(/^attachment; filename="marshrut_2026_08_21\.gpx"/);
    expect(header).toContain("filename*=UTF-8''");
    // Роут не собирает заголовок сам — одна мера в одном месте.
    expect(GPX_API).toMatch(/planGpxContentDisposition/);
    expect(GPX_API).not.toMatch(/attachment; filename=/);
  });

  it('без точек с координатами GPX не имеет смысла — planGpxPoints это видит', () => {
    expect(planGpxPoints([{ day: 1, title: 'x' }])).toHaveLength(0);
  });
});

describe('C-6: GPX-эндпоинт — та же видимость, что у страницы плана', () => {
  it('тот же токен и те же условия публичности, ничего сверх', () => {
    expect(GPX_API).toMatch(/\^\[0-9a-f-\]\{36\}\$/);
    expect(GPX_API).toMatch(/is_public = TRUE AND deleted_at IS NULL/);
    expect(GPX_API).toMatch(/share_token = \$1/);
  });

  it('нет точек с координатами → 404, а не пустой файл', () => {
    expect(GPX_API).toMatch(/planGpxPoints\(days\)\.length === 0/);
  });
});

describe('C-6: клиент — GPX и навигатор', () => {
  it('кнопка «Скачать GPX» ведёт на эндпоинт', () => {
    expect(SHARE_UI).toMatch(/\/api\/trips\/share\/\$\{token\}\/gpx/);
  });

  it('день с координатами имеет deep-link geo: в навигатор телефона', () => {
    expect(SHARE_UI).toMatch(/geo:\$\{day\.coords\[0\]\},\$\{day\.coords\[1\]\}/);
  });
});

describe('C-6: service worker кэширует план', () => {
  it('страница /trip/[token] — network-first с офлайн-фолбэком и LRU', () => {
    expect(SW).toMatch(/function isTripPage\(url\)/);
    expect(SW).toMatch(/\/trip\\\/\[a-f0-9-\]\{36\}/);
    expect(SW).toMatch(/evictOldTripPages/);
    expect(SW).toMatch(/MAX_TRIP_PAGES/);
  });

  it('share-API (+gpx) кэшируется отдельно, офлайн — из кэша', () => {
    expect(SW).toMatch(/function isTripApiRequest\(url\)/);
    expect(SW).toMatch(/api\\\/trips\\\/share\\\/\[a-f0-9-\]\{36\}\(\\\/gpx\)\?/);
    // Ветка планов стоит ДО общего пропуска остальных /api/
    expect(SW.indexOf('isTripApiRequest(url.href)')).toBeLessThan(SW.indexOf("url.pathname.startsWith('/api/')"));
  });

  it('CACHE_NAME бампнут минимум до v25 — старый SW про планы не знает', () => {
    const m = /const CACHE_NAME = 'kamchatour-v(\d+)'/.exec(SW);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(25);
  });
});

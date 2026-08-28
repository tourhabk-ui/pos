/**
 * Соответствие политике OSM tile usage + честность карты (владелец 28.08,
 * M0-безопасность по итогам внешнего аудита картографического стека).
 *
 * Публичная политика OpenStreetMap (operations.osmfoundation.org/policies/tiles)
 * прямо запрещает bulk download/prefetch/«скачать область офлайн» с
 * tile.openstreetmap.org и требует видимую атрибуцию на каждой карте,
 * использующей их тайлы. До этой правки нарушалось и то, и другое:
 *
 *   - public/sw.js кэшировал ~525 тайлов (зум 7-9) при УСТАНОВКЕ service
 *     worker и ещё ~1600 (зум 10) при первом заходе на /map — БЕЗ спроса,
 *     ДО того, как человек хоть раз посмотрел на карту;
 *   - жёстко записанные диапазоны x/y для этой закачки декодировались НЕ в
 *     Камчатку (51-61°N, 158-165°E), а в Ямал/Карское море (69.7-74.0°N,
 *     16.9-30.9°E) — заявленная «офлайн-карта Камчатки» тысячи километров
 *     мимо;
 *   - три экрана (`/map` online/offline, главная) отключали атрибуцию
 *     `attribution={false}`, а public/emergency.html — своим
 *     `attributionControl:false`;
 *   - emergency.html при этом ходил на ТРЕТИЙ хост (`.cz`-зеркало
 *     OpenTopoMap), не совпадающий ни с LeafletMap.tsx, ни с service worker.
 *
 * Сторож не переизобретает bbox-математику — держит текст источников:
 * запрещённых констант/вызовов больше нет, а честный отказ (TILES_UNAVAILABLE)
 * доходит до каждого из трёх мест, откуда раньше уходил CACHE_TILES.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const SW = read('public/sw.js');
const OFFLINE_REGION = read('lib/offline/useOfflineRegion.ts');
const MAP_PAGE = read('app/map/_MapPageClient.tsx');
const HOME_PREVIEW = read('components/homepage/HomeMapPreview.tsx');
const LEAFLET_MAP = read('components/shared/LeafletMap.tsx');
const EMERGENCY = read('public/emergency.html');
const PLANNING = read('app/planning/_PlanningClient.tsx');
const ROUTE_DETAIL = read('app/routes/[id]/_RouteDetailClient.tsx');

describe('public/sw.js — массовая закачка с tile.openstreetmap.org отключена', () => {
  it('BASE_TILE_URLS (install-time prefetch зум 7-9) больше не существует', () => {
    expect(SW).not.toContain('BASE_TILE_URLS');
  });

  it('CACHE_ZOOM10 (bulk-fetch зум 10 при первом /map) больше не обрабатывается', () => {
    // Имя может остаться в объясняющем комментарии — проверяем, что нет
    // РАБОЧЕГО кода: ни сравнения event.data.type, ни message-обработчика.
    expect(SW).not.toMatch(/event\.data\.type === 'CACHE_ZOOM10'/);
  });

  it('install больше не открывает отдельный кэш тайлов фоном', () => {
    const installAt = SW.indexOf("addEventListener('install'");
    const installEnd = SW.indexOf("addEventListener('activate'", installAt);
    const installBody = SW.slice(installAt, installEnd);
    expect(installBody).not.toContain('tileCache');
    expect(installBody).not.toContain('TILE_HOST');
  });

  it('CACHE_TILES честно отказывает — TILES_UNAVAILABLE, без единого fetch к тайл-хосту', () => {
    const at = SW.indexOf("event.data.type === 'CACHE_TILES'");
    expect(at).toBeGreaterThan(0);
    const handlerBody = SW.slice(at, SW.indexOf("if (event.data.type === 'CLEAR_TILES')", at));
    expect(handlerBody).toContain('TILES_UNAVAILABLE');
    expect(handlerBody).not.toContain('fetch(');
    expect(handlerBody).not.toMatch(/cacheTilesForRegion\(/);
  });

  it('cacheTilesForRegion (сам механизм bulk-закачки по списку) удалён', () => {
    expect(SW).not.toMatch(/async function cacheTilesForRegion/);
  });

  it('обычное кэширование тайлов ПРИ ПРОСМОТРЕ — осталось (это не bulk, это разрешено)', () => {
    expect(SW).toContain('async function handleTileRequest');
    expect(SW).toContain("url.hostname === TILE_HOST");
  });
});

describe('lib/offline/useOfflineRegion.ts — честный отказ + настоящий таймаут', () => {
  it('TILES_UNAVAILABLE отклоняет download() с причиной от SW, а не тихо теряется', () => {
    expect(OFFLINE_REGION).toContain("data.type === 'TILES_UNAVAILABLE'");
    const at = OFFLINE_REGION.indexOf("data.type === 'TILES_UNAVAILABLE'");
    const body = OFFLINE_REGION.slice(at, at + 300);
    expect(body).toContain('reject(');
  });

  it('таймаут очищается ТОЛЬКО настоящим завершением, не сразу после postMessage', () => {
    // Регрессия 28.08 (объяснена в комментарии рядом с кодом, поэтому здесь
    // проверяем не отсутствие СЛОВ, а отсутствие РАБОЧЕГО вызова): раньше
    // `void Promise.resolve().then(() => clearTimeout(timeout));` стоял
    // сразу после postMessage и гасил таймер почти мгновенно.
    expect(OFFLINE_REGION).not.toMatch(/void Promise\.resolve\(\)\.then/);
    const timeoutAt = OFFLINE_REGION.indexOf('const timeout = setTimeout');
    const postAt = OFFLINE_REGION.indexOf('postMessage({');
    expect(timeoutAt).toBeGreaterThan(0);
    expect(postAt).toBeGreaterThan(timeoutAt);
    // clearTimeout живёт внутри самого handler'а (TILES_DONE/TILES_UNAVAILABLE), не сразу после отправки.
    const clearCount = (OFFLINE_REGION.match(/clearTimeout\(timeout\)/g) ?? []).length;
    expect(clearCount).toBeGreaterThanOrEqual(2); // TILES_DONE + TILES_UNAVAILABLE
  });
});

describe('атрибуция OSM видна на всех продуктовых картах', () => {
  it('LeafletMap.tsx по умолчанию включает атрибуцию (был false)', () => {
    expect(LEAFLET_MAP).toMatch(/attribution\s*=\s*true/);
  });

  it('/map (online и offline режимы) не отключает атрибуцию явно', () => {
    expect(MAP_PAGE).not.toContain('attribution={false}');
  });

  it('главная (HomeMapPreview) не отключает атрибуцию явно', () => {
    expect(HOME_PREVIEW).not.toContain('attribution={false}');
  });

  it('emergency.html включает attributionControl и указывает источник', () => {
    expect(EMERGENCY).not.toContain('attributionControl:false');
    // Считаем РАБОЧИЕ вхождения (в вызове L.map(...)), не упоминания в
    // комментариях рядом — иначе тест хрупко зависит от формулировок прозы.
    const controlCount = (EMERGENCY.match(/L\.map\([^)]*attributionControl:true/g) ?? []).length;
    expect(controlCount).toBe(2); // полноэкранная + мини-карта
    expect(EMERGENCY).toContain('© OpenStreetMap contributors');
  });
});

describe('emergency.html использует тот же хост тайлов, что и остальная платформа', () => {
  it('старое .cz-зеркало OpenTopoMap убрано', () => {
    expect(EMERGENCY).not.toContain('opentopomap.cz');
  });

  it('оба Leaflet-инстанса эмерджанси ходят на tile.openstreetmap.org', () => {
    // Считаем РАБОЧИЕ URL тайлов (L.tileLayer(...)), не упоминания хоста в
    // комментариях рядом.
    const count = (EMERGENCY.match(/L\.tileLayer\('https:\/\/tile\.openstreetmap\.org/g) ?? []).length;
    expect(count).toBe(2);
  });
});

describe('/map — авто-подгрузка зум 10 без спроса убрана', () => {
  it('postMessage CACHE_ZOOM10 больше не отправляется', () => {
    expect(MAP_PAGE).not.toContain("type: 'CACHE_ZOOM10'");
    expect(MAP_PAGE).not.toContain('kh-zoom10-cached');
  });
});

describe('LeafletMap.tsx — стадия отказа диагностируема (M0-4)', () => {
  it('leaflet_import/cluster_import/map_init/tile_unavailable — все четыре кода различимы в коде', () => {
    for (const code of ['leaflet_import', 'cluster_import', 'map_init', 'tile_unavailable']) {
      expect(LEAFLET_MAP).toContain(`'${code}'`);
    }
  });

  it('импорт leaflet и импорт markercluster — раздельные try/catch, не общий Promise.all().catch()', () => {
    expect(LEAFLET_MAP).not.toMatch(/Promise\.all\(\[\s*import\('leaflet'\)/);
    const leafletAt = LEAFLET_MAP.indexOf("L = await import('leaflet')");
    const clusterAt = LEAFLET_MAP.indexOf("await import('leaflet.markercluster')");
    expect(leafletAt).toBeGreaterThan(0);
    expect(clusterAt).toBeGreaterThan(leafletAt);
  });

  it('лог ошибки инициализации не содержит сырых координат — только код стадии', () => {
    const at = LEAFLET_MAP.indexOf("console.error('[LeafletMap] init failed'");
    expect(at).toBeGreaterThan(0);
    // Каждое вхождение логирует { code: '...' } — не center/markers/lat/lng.
    const occurrences = [...LEAFLET_MAP.matchAll(/console\.error\('\[LeafletMap\] init failed', \{ code: '[a-z_]+' \}/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(3); // leaflet_import, cluster_import, map_init (tile_unavailable — своя форма лога)
    for (const m of occurrences) {
      expect(m[0]).not.toMatch(/center|markers|lat|lng/);
    }
  });
});

describe('CACHE_TILES-отправители честно обрабатывают TILES_UNAVAILABLE', () => {
  it('app/planning/_PlanningClient.tsx (сохранение полевого пакета)', () => {
    expect(PLANNING).toContain("m.type === 'TILES_UNAVAILABLE'");
    const at = PLANNING.indexOf("m.type === 'TILES_UNAVAILABLE'");
    const body = PLANNING.slice(at, at + 250);
    expect(body).toContain('setSaveMapError(');
  });

  it('app/routes/[id]/_RouteDetailClient.tsx (офлайн-бандл маршрута)', () => {
    expect(ROUTE_DETAIL).toContain("e.data.type === 'TILES_UNAVAILABLE'");
    const at = ROUTE_DETAIL.indexOf("e.data.type === 'TILES_UNAVAILABLE'");
    const body = ROUTE_DETAIL.slice(at, at + 200);
    expect(body).toContain("setDlState('error')");
  });
});

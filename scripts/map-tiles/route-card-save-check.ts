/**
 * Проверка делом: «Скачать для похода» на карточке маршрута кладёт карту в
 * телефон (25.09).
 *
 * До этого дня кнопка слала service worker'у растровую закачку OSM,
 * выключенную с 28.08, и не сохранила ни разу, а без service worker'а сразу
 * рисовала «Готово к офлайн». Теперь она зовёт то же правило, что полевой
 * экран (lib/offline/route-map-save). Связку «файлы пакета в хранилище →
 * карта без связи» уже проверил offline-pack-check; здесь — сама кнопка на
 * ПРОДЕ, в настоящем Chromium:
 *
 *   1. дождаться сборки не старше SINCE (version.json, built_at);
 *   2. найти маршрут с треком под собранными клетками (Авачинская группа);
 *   3. открыть карточку, нажать «Скачать для похода», дождаться итога словами;
 *   4. посчитать файлы в Cache Storage и запись о сохранённой карте;
 *   5. оборвать связь и попросить один сохранённый файл — его обязан отдать
 *      service worker.
 *
 * Исходы (§4.0): 0 — кнопка сохранила, файл отдаётся без связи; 1 — кнопка
 * не сохранила или файл без связи не отдан; 2 — проверка не состоялась
 * (сборка не дождалась, маршрута не нашлось, страница не открылась).
 *
 *   SINCE=2026-09-25T03:00:00Z npx tsx scripts/map-tiles/route-card-save-check.ts [--route <id>]
 */
import { chromium } from '@playwright/test';
import { PACK_CACHE_NAME } from '@/lib/offline/pack-files';
import { savedMapKey } from '@/lib/offline/saved-map';

const SITE = process.env.SITE_URL ?? 'https://vedarai.ru';
const SINCE = process.env.SINCE ?? '';
/** Клетки Авачинской группы собраны — берём маршрут оттуда. */
const AREA = { south: 52.5, north: 54.0, west: 157.5, east: 160.0 };

async function waitFreshBuild(): Promise<boolean> {
  if (!SINCE) return true;
  const deadline = Date.now() + 55 * 60_000;
  while (Date.now() < deadline) {
    try {
      const v = await (await fetch(`${SITE}/version.json`, { cache: 'no-store' })).json() as { built_at?: string };
      if (typeof v.built_at === 'string' && v.built_at >= SINCE) {
        console.log(`сборка ${v.built_at} — не старше ${SINCE}`);
        return true;
      }
      console.log(`сборка ${v.built_at ?? '?'} старше ${SINCE} — ждём`);
    } catch (err) {
      console.log(`version.json не ответил: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise(r => setTimeout(r, 60_000));
  }
  return false;
}

async function pickRoute(): Promise<string | null> {
  const i = process.argv.indexOf('--route');
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  const list = await (await fetch(`${SITE}/api/routes?limit=100`)).json() as { data?: Array<{ id?: unknown }> };
  for (const r of list.data ?? []) {
    if (typeof r.id !== 'string') continue;
    try {
      const b = await (await fetch(`${SITE}/api/routes/${r.id}/offline-bundle`)).json() as {
        tile_coverage?: string; route_bounds?: { south: number; north: number; west: number; east: number } | null;
      };
      const rb = b.route_bounds;
      if (b.tile_coverage !== 'corridor' || !rb) continue;
      const lat = (rb.south + rb.north) / 2;
      const lng = (rb.west + rb.east) / 2;
      if (lat > AREA.south && lat < AREA.north && lng > AREA.west && lng < AREA.east) return r.id;
    } catch { /* следующий маршрут */ }
  }
  return null;
}

async function main(): Promise<number> {
  if (!(await waitFreshBuild())) { console.log('ИТОГ: сборка не дождалась — проверка не состоялась'); return 2; }
  const routeId = await pickRoute();
  if (!routeId) { console.log('ИТОГ: маршрута с треком под собранными клетками не нашлось'); return 2; }
  console.log(`маршрут ${routeId}`);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    page.on('console', m => { if (m.type() === 'error') console.log(`  [console] ${m.text().slice(0, 300)}`); });
    // Не networkidle: прод никогда не затихает (аналитика, опросы), и
    // прогон 1 простоял 90 с до нажатия. Ждём загрузку и саму кнопку.
    await page.goto(`${SITE}/routes/${routeId}`, { waitUntil: 'load', timeout: 90_000 });
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));

    const button = page.locator('button:visible', { hasText: 'Скачать для похода' }).first();
    const shown = await button.waitFor({ timeout: 60_000 }).then(() => true).catch(() => false);
    if (!shown) { console.log('ИТОГ: кнопки «Скачать для похода» на карточке нет'); return 2; }
    // Как человек: сперва ответить на баннер согласия (он лежит поверх низа
    // экрана и перехватывает нажатие — прогон 2), потом довести кнопку до
    // середины экрана, где её не закрывают шапка и нижняя навигация.
    const consent = page.locator('button:visible', { hasText: 'Только необходимое' }).first();
    if (await consent.count() > 0) await consent.click().catch(() => undefined);
    await button.evaluate(el => el.scrollIntoView({ block: 'center' }));
    const started = Date.now();
    await button.click();

    // Итог словами: либо вес сохранённого, либо причина. Старая сборка
    // писала «Ошибка — повторить» без причины — её тоже ловим, чтобы не ждать
    // десять минут впустую.
    const outcome = await Promise.race([
      page.getByText(/Карта маршрута в телефоне: \d+ МБ/).first().waitFor({ timeout: 600_000 }).then(() => 'saved' as const),
      page.locator('button:visible', { hasText: 'Повторить' }).first().waitFor({ timeout: 600_000 }).then(() => 'refused' as const),
      page.locator('button:visible', { hasText: 'Ошибка — повторить' }).first().waitFor({ timeout: 600_000 }).then(() => 'old_build' as const),
    ]).catch(() => 'timeout' as const);
    const secs = Math.round((Date.now() - started) / 1000);
    const note = await page.locator('p', { hasText: /Карта маршрута в телефоне|Сохранено|не сохранилась|Не хватит|Нет связи|не отдал|нечего|не умеет|не даёт|не проснулось|Не удалось/ })
      .first().textContent().catch(() => null);
    console.log(`кнопка: ${outcome} за ${secs} с — «${note ?? 'строки итога нет'}»`);
    await page.screenshot({ path: '.cache/route-card-save.png', fullPage: false }).catch(() => undefined);
    if (outcome === 'old_build') { console.log('ИТОГ: на проде старая кнопка — проверка не состоялась'); return 2; }
    if (outcome !== 'saved') { console.log('ИТОГ: кнопка не сохранила карту'); return 1; }

    const stored = await page.evaluate(async ({ cacheName, key }) => {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      return { files: keys.map(r => r.url), record: localStorage.getItem(key) };
    }, { cacheName: PACK_CACHE_NAME, key: savedMapKey(routeId) });
    console.log(`в хранилище файлов: ${stored.files.length}; запись: ${stored.record ? stored.record.slice(0, 160) : 'нет'}`);
    if (stored.files.length === 0 || !stored.record) { console.log('ИТОГ: «сохранено» без файлов или без записи'); return 1; }

    // Связь оборвана: сохранённый файл обязан отдать service worker, в том
    // числе кусочком — так его читает карта (pmtiles, Range).
    const probeUrl = stored.files.find(u => u.endsWith('.pmtiles')) ?? stored.files[0];
    await context.setOffline(true);
    const offline = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { headers: { Range: 'bytes=0-15' } });
        return { status: r.status, bytes: (await r.arrayBuffer()).byteLength };
      } catch (err) { return { status: 0, bytes: 0, error: String(err) }; }
    }, probeUrl);
    console.log(`без связи ${probeUrl.split('/').slice(-2).join('/')}: HTTP ${offline.status}, ${offline.bytes} байт`);
    if (offline.status !== 206 && offline.status !== 200) { console.log('ИТОГ: без связи сохранённый файл не отдан'); return 1; }
    console.log(`ИТОГ: кнопка сохранила ${stored.files.length} файлов, без связи файл отдаётся`);
    return 0;
  } finally {
    await browser.close();
  }
}

main().then(c => process.exit(c)).catch((err) => {
  console.log(`ИТОГ: проверка упала — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});

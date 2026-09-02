/**
 * lib/map/maplibre-worker.ts — где живёт воркер MapLibre.
 *
 * ── Почему это вообще нужно ───────────────────────────────────────────────
 *
 * MapLibre 6 поднимает воркер так: `new URL('./maplibre-gl-worker.mjs',
 * import.meta.url)` → blob-модуль `import "<адрес>"` → `new Worker(blob,
 * {type: 'module'})`. Под webpack (Next) `import.meta.url` в чужом модуле —
 * это ПУТЬ НА МАШИНЕ СБОРКИ. В нашем собранном чанке стояло буквально:
 *
 *   let t="file:///home/user/pos/node_modules/maplibre-gl/dist/maplibre-gl.mjs";
 *   if(!/^https?:/.test(t))return"";
 *
 * MapLibre сам это замечает и отдаёт ПУСТОЙ адрес; воркер умирает до первой
 * строки, а наружу не приходит ничего — ни `error`, ни `load`. Геоджсон
 * режется в воркере, тайлы рельефа декодируются в нём: с мёртвым воркером
 * карта молчит целиком. Полевые прогоны 01-02.09 (Авачинский перевал) —
 * ровно это: файлы пакета приходят за 0.2 с, «тайлов запрошено 6, пришло
 * 0», «стиль: нет». На любом устройстве, с первой сборки.
 *
 * ── Лечение ───────────────────────────────────────────────────────────────
 *
 * `setWorkerUrl(<абсолютный https-адрес>)`. Именно абсолютный: MapLibre
 * складывает переданный адрес с тем же `import.meta.url`, и относительный
 * `/vendor/...` превратился бы в `file:///vendor/...`. Воркер импортирует
 * `./maplibre-gl-shared.mjs` относительно СЕБЯ, поэтому в public/ лежат оба
 * файла рядом, байт в байт, в каталоге с версией — перенос делает
 * scripts/vendor-maplibre-worker.mjs, совпадение с node_modules держит
 * tests/unit/vedar-map-worker-url.test.ts.
 *
 * CSP (next.config.js): сам воркер — blob: (`worker-src blob:`, правка
 * 01.09), его импорт — свой домен (`script-src 'self'`). Service worker
 * (public/sw.js): `.mjs` из /vendor/ — статика, cache-first, иначе офлайн-
 * карта поднималась бы без воркера.
 */

/**
 * Версия, чьи файлы лежат в public/vendor/maplibre-gl/<версия>/.
 * Сторож сверяет её с установленной: обновили пакет — обязаны перенести
 * воркер заново, иначе карта молчит с новой сборки.
 */
export const MAPLIBRE_VENDOR_VERSION = '6.6.0';

/** Файлы, которые обязаны лежать рядом: воркер и его общий модуль. */
export const MAPLIBRE_WORKER_FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'] as const;

/** Путь воркера относительно корня сайта. */
export function maplibreWorkerPath(version: string = MAPLIBRE_VENDOR_VERSION): string {
  return `/vendor/maplibre-gl/${version}/maplibre-gl-worker.mjs`;
}

/**
 * Абсолютный адрес воркера для `setWorkerUrl`.
 *
 * `origin` передаётся, а не читается из window: чистая функция проверяется
 * тестом, а не «посмотрели один раз в телефоне».
 */
export function maplibreWorkerUrl(origin: string, version: string = MAPLIBRE_VENDOR_VERSION): string {
  return new URL(maplibreWorkerPath(version), origin).href;
}

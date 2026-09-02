#!/usr/bin/env node
/**
 * scripts/vendor-maplibre-worker.mjs — перенести воркер MapLibre в public/.
 *
 * ── Зачем файл в public/, а не import из node_modules ─────────────────────
 *
 * MapLibre 6 поднимает воркер так: `new URL('./maplibre-gl-worker.mjs',
 * import.meta.url)`, заворачивает адрес в blob-модуль `import "<адрес>"` и
 * зовёт `new Worker(blob, {type: 'module'})`. Под webpack (Next) в чужом
 * модуле `import.meta.url` становится ПУТЁМ НА МАШИНЕ СБОРКИ — в нашем
 * чанке буквально стояло
 *
 *   let t="file:///home/user/pos/node_modules/maplibre-gl/dist/maplibre-gl.mjs";
 *   if(!/^https?:/.test(t))return"";
 *
 * MapLibre замечает это сам и отдаёт пустой адрес; воркер умирает до первой
 * строки, а наружу не приходит ничего: ни `error`, ни `load`. Два дня
 * полевых прогонов (01-02.09) карта молчала именно так — на любом
 * устройстве, с первой сборки.
 *
 * Лечение штатное: `setWorkerUrl(<абсолютный https-адрес>)`. Воркер
 * импортирует `./maplibre-gl-shared.mjs` относительно СЕБЯ, поэтому
 * переносятся оба файла рядом, байт в байт, в каталог с версией.
 *
 * Сторож: tests/unit/vedar-map-worker-url.test.ts — копия обязана совпадать
 * с node_modules по хешу; обновление maplibre-gl без повторного переноса
 * краснеет в CI, а не молчит на телефоне.
 *
 * Запуск: node scripts/vendor-maplibre-worker.mjs
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync(join('node_modules', 'maplibre-gl', 'package.json'), 'utf8'));
const src = join('node_modules', 'maplibre-gl', 'dist');
const dst = join('public', 'vendor', 'maplibre-gl', pkg.version);

export const MAPLIBRE_WORKER_FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

mkdirSync(dst, { recursive: true });
for (const f of MAPLIBRE_WORKER_FILES) {
  copyFileSync(join(src, f), join(dst, f));
  process.stdout.write(`[vendor-maplibre] ${f} -> ${dst}\n`);
}

/**
 * Воркер MapLibre — свой, с нашего домена. Иначе карта молчит везде.
 *
 * Разбор 02.09 (утро, Авачинский перевал): телефон достаёт оба файла пакета
 * за 0.2 с, воркер из blob: отвечает, WebGL2 есть, CSP чиста — а стиль,
 * рельеф и горизонтали молчат разом. Общее у трёх — воркер MapLibre. В
 * собранном чанке (.next/static/chunks) стояло буквально:
 *
 *   let t="file:///home/user/pos/node_modules/maplibre-gl/dist/maplibre-gl.mjs";
 *   if(!/^https?:/.test(t))return"";
 *
 * webpack подставил в `import.meta.url` путь на машине сборки; MapLibre
 * заметил это сам и отдал ПУСТОЙ адрес воркера. Воркер умирает до первой
 * строки, наружу — ничего. Карта не работала ни на одном устройстве с
 * первой сборки, и никакой CSP этого не лечил.
 *
 * Сторож держит четыре вещи, каждая из которых сама по себе возвращает
 * молчание:
 *   - VedarMap зовёт setWorkerUrl АБСОЛЮТНЫМ адресом (относительный MapLibre
 *     складывает с тем же file://);
 *   - файлы в public/vendor совпадают с node_modules байт в байт, и версия
 *     каталога — установленная (обновили пакет → перенесли воркер, иначе CI
 *     красный, а не телефон молчит);
 *   - воркер импортирует shared относительно себя — оба лежат рядом;
 *   - service worker считает .mjs статикой — иначе офлайн-карта без воркера.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAPLIBRE_VENDOR_VERSION, MAPLIBRE_WORKER_FILES, maplibreWorkerPath, maplibreWorkerUrl,
} from '@/lib/map/maplibre-worker';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'components/shared/VedarMap.tsx'), 'utf-8');
const SW = readFileSync(join(ROOT, 'public/sw.js'), 'utf-8');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('адрес воркера — абсолютный и с нашего домена', () => {
  it('складывается из origin и пути с версией', () => {
    expect(maplibreWorkerUrl('https://vedarai.ru'))
      .toBe(`https://vedarai.ru/vendor/maplibre-gl/${MAPLIBRE_VENDOR_VERSION}/maplibre-gl-worker.mjs`);
    expect(maplibreWorkerPath('9.9.9')).toBe('/vendor/maplibre-gl/9.9.9/maplibre-gl-worker.mjs');
  });

  it('VedarMap зовёт setWorkerUrl до создания карты, абсолютным адресом', () => {
    const at = SRC.indexOf('maplibre.setWorkerUrl(maplibreWorkerUrl(window.location.origin))');
    expect(at, 'setWorkerUrl с абсолютным адресом не найден').toBeGreaterThan(0);
    expect(at).toBeLessThan(SRC.indexOf('new maplibre.Map('));
  });

  it('самопроверка печатает адрес, который MapLibre считает своим', () => {
    // Пустой или file:// в этой строке — и есть дефект сборки, назван словами.
    expect(SRC).toMatch(/maplibre\.getWorkerUrl\(\) \|\| 'адрес пуст'/);
  });
});

describe('перенесённый воркер совпадает с установленным пакетом', () => {
  const installed = JSON.parse(readFileSync(join(ROOT, 'node_modules/maplibre-gl/package.json'), 'utf-8')) as { version: string };
  const vendorDir = join(ROOT, 'public/vendor/maplibre-gl', MAPLIBRE_VENDOR_VERSION);

  it('версия каталога — установленная версия maplibre-gl', () => {
    // Обновили пакет, не перенесли воркер — молчание с новой сборки.
    expect(MAPLIBRE_VENDOR_VERSION).toBe(installed.version);
  });

  it('оба файла лежат рядом и совпадают с node_modules байт в байт', () => {
    for (const f of MAPLIBRE_WORKER_FILES) {
      const vendored = join(vendorDir, f);
      expect(existsSync(vendored), `нет ${vendored} — запусти scripts/vendor-maplibre-worker.mjs`).toBe(true);
      expect(sha(vendored), `${f} расходится с node_modules`).toBe(sha(join(ROOT, 'node_modules/maplibre-gl/dist', f)));
    }
  });

  it('воркер импортирует shared относительно себя — потому оба и переносятся', () => {
    const worker = readFileSync(join(vendorDir, 'maplibre-gl-worker.mjs'), 'utf-8');
    expect(worker).toMatch(/from"\.\/maplibre-gl-shared\.mjs"/);
  });
});

describe('service worker знает про .mjs', () => {
  it('.mjs — статика, cache-first, иначе офлайн-карта без воркера', () => {
    expect(SW).toMatch(/pathname\.endsWith\('\.mjs'\)/);
  });

  it('версия кэша поднята вместе с этим', () => {
    // Старый кэш держал бы правило «не статика» до истечения сам собой.
    expect(SW).toMatch(/const CACHE_NAME = 'kamchatour-v(29|[3-9]\d)'/);
  });
});

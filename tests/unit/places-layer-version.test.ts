/**
 * Сторож версии слоя мест в адресе файла (17.09).
 *
 * ── Что случилось ─────────────────────────────────────────────────────────
 *
 * Владелец трижды за день видел на полевой карте «Озеро Овальное» — запись,
 * скрытую миграцией 947 неделю назад. К вечеру с раннера было доказано, что
 * на сервере её нет НИГДЕ: прод отвечает 404, экспорт по имени даёт 0
 * (проба 512), все 123 пакета после заливки прочитаны обратно байт в байт
 * (прогон 11). Снимок 18:59 — через четыре часа после заливки — показывал
 * копию, которой не существует.
 *
 * Ключ файла постоянный, файл под ним переписывается, и `no-cache` в
 * заголовке ОБЯЗЫВАЕТ браузер сверяться — но где именно застрял старый файл
 * (кэш браузера, память открытого PWA, прослойка перед хранилищем), с
 * раннера не видно. Версия в адресе снимает вопрос: новая заливка — новый
 * адрес, старому файлу неоткуда взяться.
 *
 * Исход (17.09, после выката f37a872 и заливки run 12): владелец открыл
 * приложение заново — Овального нет. Заголовки хранилища в логе заливки
 * прослойки не показали (age/x-cache/via пустые), значит копия жила на
 * телефоне. Какой именно слой её держал — HTTP-кэш браузера или память
 * открытого PWA — не установлено, и здесь это не выдаётся за известное.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Связку, а не половину (правило 10.09): версия в коде, run маркера заливки
 * и адрес, по которому читает обратно скрипт, — одно число. Разойдутся —
 * телефоны попросят старый адрес, и вся защита превратится в объявление.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLACES_LAYER_VERSION, resolvePackSource, BUILT_PACK_REGIONS, withCacheEpoch } from '@/lib/map/pack-source';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('версия слоя — одно число в трёх местах', () => {
  const marker = JSON.parse(read('.github/triggers/map-places-build.json')) as { run?: number; upload?: boolean };

  it('PLACES_LAYER_VERSION равна run маркера последней заливки', () => {
    // Маркер с upload:true — это заливка; её run и есть версия адреса.
    // Поднял run — подними версию тем же коммитом, иначе тест красный до
    // того, как прогон успеет залить под старым адресом.
    expect(typeof marker.run).toBe('number');
    expect(PLACES_LAYER_VERSION, 'run маркера и версия слоя в коде разошлись').toBe(marker.run);
  });

  it('скрипт заливки отказывается лить при расхождении, а не полагается на CI', () => {
    const src = read('scripts/map-tiles/build-places.ts');
    expect(src).toMatch(/process\.env\.MAP_PLACES_RUN/);
    expect(src).toMatch(/Number\(markerRun\) !== PLACES_LAYER_VERSION/);
    expect(src).toMatch(/ОТКАЗ: run маркера[\s\S]*?return 2;/);
  });

  it('workflow передаёт run маркера в скрипт', () => {
    const wf = read('.github/workflows/map-places-build.yml');
    expect(wf).toMatch(/MAP_PLACES_RUN: \$\{\{ steps\.cfg\.outputs\.run \}\}/);
    expect(wf).toMatch(/echo "run=\$RUN" >> "\$GITHUB_OUTPUT"/);
  });
});

describe('адрес слоя несёт версию', () => {
  it('клиент просит файл с ?v=<версия>', () => {
    const r = resolvePackSource('cell-53n158e', BUILT_PACK_REGIONS, 'https://packs.example');
    expect(r.state).toBe('ready');
    if (r.state !== 'ready') return;
    // Версия слоя остаётся первой; эпоха кэша пакетов (24.09) идёт вторым
    // параметром — у них разные причины, и одна не заменяет другую.
    expect(r.placesUrl).toBe(
      withCacheEpoch(`https://packs.example/map-packs/cell-53n158e.places.geojson?v=${PLACES_LAYER_VERSION}`),
    );
  });

  it('чтение обратно ходит по тому же адресу с ?v=', () => {
    // Иначе проверяется не то, что видит телефон.
    const src = read('scripts/map-tiles/build-places.ts');
    expect(src).toMatch(/fetch\(`\$\{url\}\?v=\$\{PLACES_LAYER_VERSION\}`, \{ cache: 'no-store' \}\)/);
  });

  it('ключ объекта в хранилище версией НЕ помечен', () => {
    // Версия — в запросе, не в имени файла: один объект, много адресов.
    // Иначе каждая заливка плодила бы файлы, а старые никто бы не убирал.
    const src = read('lib/map/pack-source.ts');
    expect(src).toMatch(/return `map-packs\/\$\{region\}\.places\.geojson`;/);
  });
});

describe('заголовки ответа хранилища видны в логе заливки', () => {
  it('чтение обратно печатает cache-control и etag, но не адрес', () => {
    const src = read('scripts/map-tiles/build-places.ts');
    expect(src).toMatch(/'cache-control', 'etag'/);
    expect(src).toMatch(/заголовки ответа хранилища/);
    // Печатается один раз, а не 123 раза.
    expect(src).toMatch(/if \(!headersShown\)/);
  });
});

/**
 * Честность офлайн-фундамента (этап 0 плана Field Confidence Navigator).
 *
 * Три инварианта, без которых любой «полевой пакет» — декларация:
 *
 * 1. Отказ регистрации Service Worker не глотается: судьба регистрации
 *    записывается в читаемое состояние, и экран может сказать «офлайн
 *    недоступен» до выхода, а не оставить выяснять в поле.
 * 2. Частично скачанный регион — отдельное состояние `partial`, а не
 *    `cached` (ложь о готовности) и не `error` (неотличимо от «ничего нет»).
 *    Запись «скачано» в IndexedDB проверяется делом — пробой тайлов в
 *    Cache Storage: система чистит кэш, не трогая метаданные.
 * 3. Публичный safety-status отличает «мы знаем, что тихо» от «мы не знаем»:
 *    при недоступном источнике ответ несёт флаг unavailable, и потребители
 *    не рисуют спокойное состояние из отсутствия данных.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('судьба регистрации SW — состояние, а не проглоченная ошибка', () => {
  const registrar = read('components/PWA/ServiceWorkerRegistrar.tsx');
  const status = read('lib/offline/sw-status.ts');

  it('глухого catch больше нет', () => {
    // Комментарии вырезаются: старый образец цитируется в пояснении рядом.
    const code = registrar.replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
    // Ошибка регистрации ловится не заглушкой, а докладом о судьбе.
    expect(code).toMatch(/\.catch\(\(err[\s\S]{0,200}reportSwRegistration\('failed'/);
  });

  it('исходы регистрации записываются: ready, failed, unsupported', () => {
    expect(registrar).toMatch(/reportSwRegistration\('ready'\)/);
    expect(registrar).toMatch(/reportSwRegistration\('failed'/);
    expect(registrar).toMatch(/reportSwRegistration\('unsupported'\)/);
  });

  it('модуль состояния знает все пять исходов', () => {
    for (const s of ['unknown', 'unsupported', 'registering', 'ready', 'failed']) {
      expect(status).toContain(`'${s}'`);
    }
  });
});

describe('частичный офлайн-регион не выдаётся за готовый', () => {
  const hook = read('lib/offline/useOfflineRegion.ts');

  it('partial есть в модели статусов', () => {
    expect(hook).toMatch(/'cached'\s*\|\s*'partial'\s*\|\s*'error'/);
  });

  it('метаданные при монтировании проверяются пробой Cache Storage', () => {
    // Запись «скачано» без тайлов — partial, а не cached: верить памяти
    // о закачке, не глядя в кэш, значит показать карту, которой нет.
    expect(hook).toMatch(/caches\.match/);
    expect(hook).toMatch(/sampleTilesPresent/);
  });

  it('закачка с потерями кончается partial, а не cached', () => {
    expect(hook).toMatch(/failedTiles > 0 \? 'partial' : 'cached'/);
  });

  it('число нескачанных тайлов доезжает до записи региона', () => {
    expect(read('lib/offline/db.ts')).toMatch(/tilesFailed\?: number/);
    expect(hook).toMatch(/tilesFailed: failedTiles/);
  });

  it('интерфейсы различают partial и cached словами', () => {
    expect(read('components/Offline/RegionCard.tsx')).toContain('Скачан не полностью');
    expect(read('components/geo/OnSiteBanner.tsx')).toMatch(/'partial'/);
    // Чек-лист планировщика: галочка готовности только при cached.
    expect(read('app/planning/_PlanningClient.tsx')).toMatch(/done: mapsStatus === 'cached'/);
  });
});

describe('safety-status: «нет данных» не выглядит как «спокойно»', () => {
  it('эндпоинт помечает недоступность источника', () => {
    expect(read('app/api/public/safety-status/route.ts')).toMatch(/unavailable: true/);
  });

  it.each([
    'app/marketplace/tours/[id]/_TourDetailClient.tsx',
    'app/trip/[token]/_TripShareClient.tsx',
    'components/homepage/KuzmichBriefing.tsx',
  ])('потребитель %s не рисует спокойствие из недоступности', (p) => {
    expect(read(p)).toMatch(/unavailable/);
  });

  it('«Условия благоприятные» — только при живых данных', () => {
    const briefing = read('components/homepage/KuzmichBriefing.tsx');
    // Ветка «благоприятные» стоит за проверкой наличия safety-данных,
    // а не в else от «есть тревога».
    expect(briefing).toMatch(/else if \(safety\)/);
  });
});

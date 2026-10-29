/**
 * Готовность карты маршрута к выходу (#2558, #2789) — вызовом.
 *
 * Запись о закачке — заявление; проба Cache Storage — проверка. «Готово»
 * только когда не легло ничего лишнего и проба нашла карту; «проверить
 * нечем» — не «готово».
 */
import { describe, it, expect } from 'vitest';
import { routeMapReadiness } from '@/lib/offline/route-map-readiness';
import { coverageFromCounts } from '@/lib/offline/coverage';
import { parseSavedMap, savedMapSummary, type SavedMapRecord } from '@/lib/offline/saved-map';

const T0 = Date.UTC(2026, 9, 29, 3, 0, 0);
const REC: SavedMapRecord = {
  at: T0, tiles: 12, mb: 47, zooms: [10, 12], droppedZooms: [], coverage: 'packs', bufferKm: null,
  persisted: true, sampleUrls: ['https://s3.example/a.pmtiles'], failedFiles: 0,
};

describe('routeMapReadiness', () => {
  it('не легло файлов — «повторить», проба не спрашивается', () => {
    const r = routeMapReadiness({ ...REC, failedFiles: 3 }, coverageFromCounts(12, 12, 12), T0);
    expect(r.state).toBe('redo');
    expect(r.note).toContain('не легло файлов — 3');
  });
  it('проба нашла всё — готово, с «проверено»', () => {
    const r = routeMapReadiness(REC, coverageFromCounts(12, 12, 12), T0);
    expect(r).toEqual({ state: 'ready', note: 'Карта маршрута в телефоне: 47 МБ · проверено: карта маршрута на месте' });
  });
  it('карта вычищена — «нет в телефоне», скачать заново', () => {
    const r = routeMapReadiness(REC, coverageFromCounts(12, 12, 0), T0);
    expect(r.state).toBe('redo');
    expect(r.note).toMatch(/сейчас её в телефоне нет/);
  });
  it('в телефоне меньше 90% — докачать', () => {
    const r = routeMapReadiness(REC, coverageFromCounts(12, 12, 8), T0);
    expect(r.state).toBe('redo');
    expect(r.note).toMatch(/^Проверено: в телефоне 66% карты маршрута — докачайте/);
  });
  it('проверить нечем — не «готово» и не «повторить», и слова «проверено» нет', () => {
    for (const cov of [null, coverageFromCounts(12, 0, 0), coverageFromCounts(0, 0, 0)]) {
      const r = routeMapReadiness(REC, cov, T0);
      expect(r.state).toBe('unchecked');
      expect(r.note).toMatch(/проверить не удалось/);
      expect(r.note).not.toMatch(/проверено/);
    }
  });
});

describe('запись о закачке помнит недокачанное', () => {
  it('failedFiles читается, у старых записей — 0; сводка называет число', () => {
    expect(parseSavedMap(JSON.stringify({ at: T0, tiles: 12, failedFiles: 2 }))?.failedFiles).toBe(2);
    expect(parseSavedMap(JSON.stringify({ at: T0, tiles: 12 }))?.failedFiles).toBe(0);
    expect(parseSavedMap(JSON.stringify({ at: T0, tiles: 12, failedFiles: -1 }))?.failedFiles).toBe(0);
    expect(savedMapSummary({ ...REC, failedFiles: 2 }, T0)).toContain('не легло файлов: 2');
    expect(savedMapSummary(REC, T0)).not.toContain('не легло');
  });
});

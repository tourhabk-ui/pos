/**
 * Пожарный слой safety-ingest (NASA FIRMS).
 *
 * Инварианты: CSV парсится по именам колонок (не индексам), низкая уверенность
 * и точки вне Камчатки отброшены, кластеризация схлопывает один пожар в один
 * алерт, severity растёт только с масштабом, external_id стабилен на
 * день+ячейку (дедуп в external_alerts), без FIRMS_MAP_KEY — ни одного fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/services/safety/seismic-parser', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/services/safety/seismic-parser')>();
  return { ...orig, saveEvent: vi.fn(async () => 'inserted' as const) };
});

import {
  parseFirmsCsv,
  clusterHotspots,
  wildfireEvents,
  ingestFirmsWildfires,
  KAMCHATKA_BBOX,
} from '@/lib/services/safety/wildfire-firms';

const CSV_HEADER =
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';

function row(lat: number, lng: number, conf: string, frp: number, date = '2026-07-27'): string {
  return `${lat},${lng},330,0.5,0.5,${date},0130,N,VIIRS,${conf},2.0NRT,290,${frp},D`;
}

describe('parseFirmsCsv', () => {
  it('берёт валидные точки, режет low-confidence и вне бокса', () => {
    const csv = [
      CSV_HEADER,
      row(56.1, 159.2, 'n', 12),
      row(56.2, 159.3, 'h', 40),
      row(56.3, 159.4, 'l', 99),      // low → отброшена
      row(45.0, 159.0, 'h', 50),      // южнее бокса → отброшена
      row(56.0, 120.0, 'h', 50),      // западнее бокса → отброшена
      'мусор,не,число',
    ].join('\n');
    const pts = parseFirmsCsv(csv);
    expect(pts).toHaveLength(2);
    expect(pts[0].confidence).toBe('n');
    expect(pts[1].frp).toBe(40);
  });

  it('числовую уверенность MODIS нормализует: <30 режет, >=80 → h', () => {
    const csv = [CSV_HEADER, row(56, 159, '85', 10), row(56.5, 160, '10', 10)].join('\n');
    const pts = parseFirmsCsv(csv);
    expect(pts).toHaveLength(1);
    expect(pts[0].confidence).toBe('h');
  });

  it('колонки ищутся по имени: переставленный порядок не ломает разбор', () => {
    const csv = ['frp,acq_date,latitude,longitude,confidence', '25,2026-07-27,56.1,159.2,n'].join('\n');
    const pts = parseFirmsCsv(csv);
    expect(pts).toHaveLength(1);
    expect(pts[0].lat).toBe(56.1);
    expect(pts[0].frp).toBe(25);
  });
});

describe('clusterHotspots', () => {
  it('точки одного пожара (< радиуса) схлопываются, дальние — отдельные кластеры', () => {
    const near = (dLat: number) => ({ lat: 56 + dLat, lng: 159, frp: 10, confidence: 'n' as const, acqDate: '2026-07-27' });
    const clusters = clusterHotspots([near(0), near(0.01), near(0.02), { lat: 58, lng: 162, frp: 5, confidence: 'n', acqDate: '2026-07-27' }]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].count).toBe(3);
    expect(clusters[0].frpSum).toBe(30);
  });
});

describe('wildfireEvents', () => {
  const cluster = (count: number, frpSum: number, lat = 56, lng = 159) =>
    ({ lat, lng, count, frpSum, acqDate: '2026-07-27' });

  it('severity консервативна: одиночная точка 0, очаг 1, крупный 2 (порог push)', () => {
    expect(wildfireEvents([cluster(1, 5)])[0].severity).toBe(0);
    expect(wildfireEvents([cluster(4, 40)])[0].severity).toBe(1);
    expect(wildfireEvents([cluster(12, 90)])[0].severity).toBe(2);
    expect(wildfireEvents([cluster(2, 200)])[0].severity).toBe(2);
  });

  it('тип fire_danger, зоны по координатам, id стабилен на день+ячейку', () => {
    const [ev] = wildfireEvents([cluster(3, 33, 57.0, 160.0)]);
    expect(ev.alert_type).toBe('fire_danger');
    expect(ev.affected_zones).toEqual(['northern']);
    expect(ev.source_id).toBe('firms/2026-07-27/57.0,160.0');
    expect(ev.expires_hours).toBe(48);
    const [ev2] = wildfireEvents([cluster(9, 99, 57.04, 160.01)]);
    expect(ev2.source_id).toBe(ev.source_id); // та же ~10км-ячейка → дедуп в БД
  });
});

describe('ingestFirmsWildfires', () => {
  beforeEach(() => { vi.unstubAllEnvs(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('без FIRMS_MAP_KEY — тихий выход, fetch не вызывается', async () => {
    vi.stubEnv('FIRMS_MAP_KEY', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await ingestFirmsWildfires();
    expect(res.inserted).toBe(0);
    expect(res.errors).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('с ключом: CSV → кластеры → saveEvent, rawItems = число термоточек', async () => {
    vi.stubEnv('FIRMS_MAP_KEY', 'test-key');
    const csv = [CSV_HEADER, row(56.1, 159.2, 'n', 12), row(56.11, 159.21, 'h', 20)].join('\n');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(String(url)).toContain('VIIRS_SNPP_NRT');
      expect(String(url)).toContain(`${KAMCHATKA_BBOX.west},${KAMCHATKA_BBOX.south}`);
      return { ok: true, text: async () => csv };
    }));
    const res = await ingestFirmsWildfires();
    expect(res.rawItems).toBe(2);
    expect(res.events).toHaveLength(1); // один кластер
    expect(res.inserted).toBe(1);
  });

  it('http-ошибка FIRMS попадает в errors, не бросается', async () => {
    vi.stubEnv('FIRMS_MAP_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })));
    const res = await ingestFirmsWildfires();
    expect(res.errors[0]).toContain('503');
  });
});

describe('интеграция с кроном safety-ingest', () => {
  it('роут зовёт ingestFirmsWildfires в GET (heartbeat), health-запись есть, push знает пожар', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/api/cron/safety-ingest/route.ts', 'utf8');
    // #883: FIRMS делегирован heartbeat-GET (каждые 5 минут) — POST его
    // больше не дублирует (см. safety-ingest-delegation.test.ts). Один вызов
    // в GET — новый контракт, ноль вызовов был бы регрессией слоя пожаров.
    expect((src.match(/ingestFirmsWildfires\(\)/g) ?? []).length).toBe(1);
    expect(src).toContain("entryFor('firms'");
    expect(src).toContain("requiresEnv: 'FIRMS_MAP_KEY'");
    // Пуш при severity>=2 не должен называть пожар «Землетрясение M?».
    expect(src).toContain("alert.alert_type === 'fire_danger'");
    expect(src).toContain('Природный пожар — Камчатка');
  });

  it('FIRMS осознанно вне dead-source реестра (сезонная пустота — норма)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('lib/services/safety/source-health.ts', 'utf8');
    expect(src).not.toMatch(/key:\s*'firms'/);
    expect(src).toContain('firms');  // но причина отсутствия задокументирована
  });
});

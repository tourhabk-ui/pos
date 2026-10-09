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
// Каталог мест, который приём читает для проверки «рядом вулкан/источник».
vi.mock('@/lib/database', () => ({ query: vi.fn(async () => ({ rows: [] })) }));

import { saveEvent } from '@/lib/services/safety/seismic-parser';
import { query } from '@/lib/database';
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
  const NOW = new Date('2026-07-27T12:00:00Z');
  beforeEach(() => { vi.unstubAllEnvs(); vi.mocked(saveEvent).mockClear(); vi.mocked(query).mockReset(); vi.mocked(query).mockResolvedValue({ rows: [] } as never); });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('без FIRMS_MAP_KEY — тихий выход, fetch не вызывается', async () => {
    vi.stubEnv('FIRMS_MAP_KEY', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await ingestFirmsWildfires(NOW);
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
      expect(String(url)).toMatch(/\/5$/); // 5 суток: по одним суткам стоящую точку не узнать
      return { ok: true, text: async () => csv };
    }));
    const res = await ingestFirmsWildfires(NOW);
    expect(res.rawItems).toBe(2);
    expect(res.events).toHaveLength(1); // один кластер
    expect(res.inserted).toBe(1);
  });

  it('http-ошибка FIRMS попадает в errors, не бросается', async () => {
    vi.stubEnv('FIRMS_MAP_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })));
    const res = await ingestFirmsWildfires(NOW);
    expect(res.errors[0]).toContain('503');
  });

  it('вчерашние точки окна тревогой не становятся: кандидаты — только сегодняшние сутки', async () => {
    vi.stubEnv('FIRMS_MAP_KEY', 'test-key');
    const csv = [CSV_HEADER, row(56.1, 159.2, 'n', 12, '2026-07-26'), row(58.0, 161.0, 'h', 20, '2026-07-27')].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => csv })));
    const res = await ingestFirmsWildfires(NOW);
    expect(res.rawItems).toBe(1);
    expect(res.events).toHaveLength(1);
    expect(res.events[0].lat).toBeCloseTo(58.0, 3);
  });
});

// ── Постоянный источник тепла не объявляется пожаром (скрин владельца 09.10) ──

describe('ingestFirmsWildfires: стоящая на месте точка у вулкана', () => {
  const NOW = new Date('2026-10-07T10:00:00Z');
  const VENT = { name: 'Вулкан Крашенинникова', location_type: 'volcano', lat: 54.5955, lng: 160.2949 }; // ~2 км южнее точки
  /** По обнаружению (или нескольким) на каждые из суток, у точки 54.6126N 160.2949E. */
  function csvFor(perDay: Record<string, number>, frp = 10, lat = 54.6126, lng = 160.2949): string {
    const rows = Object.entries(perDay).flatMap(([date, n]) =>
      Array.from({ length: n }, (_, i) => row(lat + i * 0.0002, lng, 'n', frp, date)));
    return [CSV_HEADER, ...rows].join('\n');
  }
  const STEADY = { '2026-10-04': 4, '2026-10-05': 3, '2026-10-06': 4, '2026-10-07': 4 };

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('FIRMS_MAP_KEY', 'test-key');
    vi.mocked(saveEvent).mockClear();
    vi.mocked(query).mockReset();
    // places отдают вулкан, UPDATE ... RETURNING снимает одну лежавшую тревогу
    vi.mocked(query).mockImplementation((async (sql: string) =>
      /FROM places/.test(sql) ? { rows: [VENT] } : { rows: [{ id: 'old-alert' }] }) as never);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  const callsTo = (re: RegExp) => vi.mocked(query).mock.calls.filter(([sql]) => re.test(String(sql)));
  const serve = (csv: string) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => csv })));

  it('4 суток на месте, вулкан в 2 км, не крупнее обычного — тревоги нет, подавление названо в ответе', async () => {
    serve(csvFor(STEADY));
    const res = await ingestFirmsWildfires(NOW);
    expect(res.rawItems).toBe(4);            // сколько было сегодня ДО отсева
    expect(res.events).toEqual([]);
    expect(saveEvent).not.toHaveBeenCalled();
    expect(res.suppressed).toHaveLength(1);
    expect(res.suppressed[0]).toMatchObject({ days: 4, detections_today: 4, nearest: 'Вулкан Крашенинникова' });
    expect(res.suppressed[0].nearest_km).toBeGreaterThan(1.5);
    expect(res.suppressed[0].nearest_km).toBeLessThan(2.5);
  });

  it('те же точки, но стоят меньше трёх суток — пожар, пока не доказано иное', async () => {
    serve(csvFor({ '2026-10-06': 4, '2026-10-07': 4 }));
    const res = await ingestFirmsWildfires(NOW);
    expect(res.events).toHaveLength(1);
    expect(res.suppressed).toEqual([]);
  });

  it('рядом нет вулкана/источника — чем это тепло, не знаем: тревога остаётся', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ ...VENT, lat: 55.5 }] } as never); // ~100 км
    serve(csvFor(STEADY));
    const res = await ingestFirmsWildfires(NOW);
    expect(res.events).toHaveLength(1);
    expect(res.suppressed).toEqual([]);
    expect(callsTo(/UPDATE external_alerts/)).toHaveLength(0); // ничего не гасили — ничего не снимаем
  });

  it('вулкан в 10 км — это уже другая долина: тепло не его, тревога остаётся', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ ...VENT, lat: 54.6126 - 10 / 111.2 }] } as never);
    serve(csvFor(STEADY));
    const res = await ingestFirmsWildfires(NOW);
    expect(res.events).toHaveLength(1);
    expect(res.suppressed).toEqual([]);
  });

  it('каталог мест не прочитан — не гасим и говорим причиной в лог (SQLSTATE), а не молчим', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(query).mockRejectedValue(Object.assign(new Error('connection terminated'), { code: '08006' }));
    serve(csvFor(STEADY));
    const res = await ingestFirmsWildfires(NOW);
    expect(res.events).toHaveLength(1);
    expect(res.suppressed).toEqual([]);
    expect(res.errors).toEqual([]); // приём не падает из-за каталога
    expect(err).toHaveBeenCalledWith(expect.stringContaining('places'), '08006', 'connection terminated');
  });

  it('стоит давно, но сегодня вспыхнуло вдвое-втрое крупнее — это не «как всегда»: тревога остаётся', async () => {
    serve(csvFor({ '2026-10-04': 3, '2026-10-05': 3, '2026-10-06': 3, '2026-10-07': 14 }));
    const res = await ingestFirmsWildfires(NOW);
    expect(res.events).toHaveLength(1);
    expect(res.suppressed).toEqual([]);
  });

  it('рядом со стоячим источником загорелось в другом месте — тревога только по новому, источник гасится', async () => {
    const base = csvFor(STEADY).split('\n');
    base.push(row(54.9, 160.9, 'h', 40, '2026-10-07')); // ~50 км от вулкана, одни сутки
    serve(base.join('\n'));
    const res = await ingestFirmsWildfires(NOW);
    expect(res.suppressed).toHaveLength(1);
    expect(res.events).toHaveLength(1);
    expect(res.events[0].lat).toBeCloseTo(54.9, 2);
  });

  it('каталог читается один раз за прогон, а не по разу на кластер', async () => {
    const lines = csvFor(STEADY).split('\n');
    for (const d of Object.keys(STEADY)) lines.push(row(55.2, 160.1, 'n', 8, d)); // второй стоячий кластер
    serve(lines.join('\n'));
    await ingestFirmsWildfires(NOW);
    expect(callsTo(/FROM places/)).toHaveLength(1);
  });

  it('уже лежащая тревога по погашенному месту снимается сразу (срок сокращается), а не доживает двое суток', async () => {
    serve(csvFor(STEADY));
    const res = await ingestFirmsWildfires(NOW);
    expect(res.suppressed[0].retracted).toBe(1);
    const [sql, params] = callsTo(/UPDATE external_alerts/)[0] as [string, number[]];
    expect(sql).toMatch(/SET expires_at = NOW\(\)/);          // срок сокращается, строка остаётся
    expect(sql).toMatch(/alert_type = 'fire_danger'/);           // чужие типы не трогаем
    expect(sql).toMatch(/external_id LIKE 'firms\/%'/);          // и чужие источники
    expect(sql).not.toMatch(/DELETE/);
    expect(params[0]).toBeCloseTo(54.6126, 2);
    expect(params[1]).toBeCloseTo(160.2949, 2);
    expect(params[2]).toBe(3);                                   // радиус кластера, не «весь вулкан»
  });

  it('снять не удалось — тревога не возвращается (не гасили зря), отказ назван в errors и в логе с SQLSTATE', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(query).mockImplementation((async (sql: string) => {
      if (/FROM places/.test(sql)) return { rows: [VENT] };
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    }) as never);
    serve(csvFor(STEADY));
    const res = await ingestFirmsWildfires(NOW);
    expect(res.events).toEqual([]);
    expect(res.suppressed[0].retracted).toBe(0);
    expect(res.errors[0]).toContain('40P01');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('снять тревоги'), '40P01', 'deadlock detected');
  });

  it('точек нет — каталог не читается вовсе', async () => {
    serve(CSV_HEADER);
    await ingestFirmsWildfires(NOW);
    expect(vi.mocked(query)).not.toHaveBeenCalled();
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
    // Проверяется поведение, а не строка в кроне: прежняя привязка к
    // `alert.alert_type === 'fire_danger'` не пустила вынос текстов в
    // отдельный модуль, хотя правка чинила чужую инструкцию у всех
    // остальных типов.
    const { pushCopy } = await import('@/lib/services/safety/push-copy');
    const copy = pushCopy({ alertType: 'fire_danger', title: 'Крупный очаг у Ключей' });
    expect(copy.title).toContain('Природный пожар');
    expect(copy.title).not.toMatch(/Землетрясение/);
  });

  it('FIRMS осознанно вне dead-source реестра (сезонная пустота — норма)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('lib/services/safety/source-health.ts', 'utf8');
    expect(src).not.toMatch(/key:\s*'firms'/);
    expect(src).toContain('firms');  // но причина отсутствия задокументирована
  });
});

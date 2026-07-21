/**
 * Ремонт данных: dry-run не мутирует, хелперы детерминированы.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
// Транзакционные шаги (дедуп маршрутов) идут через pool.connect() -> client.query;
// направляем client.query в тот же queryMock, чтобы BEGIN/COMMIT/UPDATE ловились.
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...args: unknown[]) => queryMock(...args),
    connect: () =>
      Promise.resolve({
        query: (...args: unknown[]) => queryMock(...args),
        release: () => {},
      }),
  },
}));
vi.mock('@/lib/services/routes/geocode', () => ({
  geocodeAddress: vi.fn().mockResolvedValue(null),
  withinKamchatka: (lat: number, lng: number) => lat >= 50 && lat <= 64 && lng >= 155 && lng <= 167,
}));

import { runDataRepair, nameWordSet, trackDestination } from '@/lib/services/data-repair';

describe('хелперы', () => {
  it('nameWordSet: «Озеро Курильское» == «Курильское озеро», ё=е', () => {
    expect(nameWordSet('Озеро Курильское')).toBe(nameWordSet('Курильское озеро'));
    expect(nameWordSet('Голубые озёра')).toBe(nameWordSet('Голубые озера'));
    expect(nameWordSet('Кутхины баты')).toBe(nameWordSet('Кутхины Баты'));
    expect(nameWordSet('Озеро Курильское')).not.toBe(nameWordSet('Озеро Толмачево'));
  });

  it('trackDestination: последняя валидная точка [lng,lat]', () => {
    expect(trackDestination([[158.1, 52.5], [158.2, 52.6]])).toEqual({ lat: 52.6, lng: 158.2 });
    expect(trackDestination([])).toBeNull();
  });
});

describe('runDataRepair (dry-run)', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('dry-run не шлёт ни одного UPDATE', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('HAVING COUNT(*) >= 3') && sql.includes('SELECT lat')) {
        return Promise.resolve({ rows: [{ lat: 55, lng: 160, n: 3 }] });
      }
      if (sql.includes('JOIN (')) {
        return Promise.resolve({
          rows: [{ id: 'p1', ark_id: 'a1', name: 'Бухта Русская', lat: 55, lng: 160 }],
        });
      }
      if (sql.includes('COUNT(*)::int AS n FROM kamchatka_routes')) {
        return Promise.resolve({ rows: [{ n: 85 }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(true);
    expect(result.dry_run).toBe(true);
    expect(result.bogus_clusters).toBe(1);
    expect(result.normalized_sources).toBe(85);
    // Без трека и с недоступным геокодером место уходит в «скрыть»
    expect(result.hidden_unfixable).toBe(1);
    for (const call of queryMock.mock.calls) {
      expect(String(call[0]).trim().toUpperCase().startsWith('UPDATE')).toBe(false);
    }
  });

  it('apply: фейковая координата чинится из финиша strong-трека и трек привязывается', async () => {
    const updates: string[] = [];
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.trim().toUpperCase().startsWith('UPDATE')) {
        updates.push(`${s.replace(/\s+/g, ' ').trim()} :: ${JSON.stringify(params)}`);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (s.includes('HAVING COUNT(*) >= 3') && s.includes('GROUP BY lat, lng') && !s.includes('JOIN (')) {
        return Promise.resolve({ rows: [{ lat: 55, lng: 160, n: 3 }] });
      }
      if (s.includes('JOIN (')) {
        return Promise.resolve({
          rows: [{ id: 'p1', ark_id: 'a1', name: 'Бухта Русская', lat: 55, lng: 160 }],
        });
      }
      if (s.includes(`metadata->>'place_ark_id') IS NULL`)) {
        return Promise.resolve({
          rows: [{
            id: 't1',
            title: 'Бухта Русская',
            geometry: { coordinates: [[158.0, 52.0], [158.42, 52.35]] },
          }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(false);
    expect(result.coords_from_track).toBe(1);
    expect(updates.some(u => u.includes('UPDATE places SET lat') && u.includes('52.35'))).toBe(true);
    expect(updates.some(u => u.includes(`place_ark_id`) && u.includes('"a1"'))).toBe(true);
  });

  it('apply: дубли-маршруты сливаются, туры перевешены на keeper с треком; разный activity не сливается', async () => {
    const updates: string[] = [];
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.trim().toUpperCase().startsWith('UPDATE')) {
        updates.push(`${s.replace(/\s+/g, ' ').trim()} :: ${JSON.stringify(params)}`);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (s.includes('FROM kamchatka_routes') && s.includes('has_geometry')) {
        return Promise.resolve({
          rows: [
            // Дубль-пара: одинаковый title+activity+координаты; keeper — с треком
            { id: 'r1', title: 'Вилючинский водопад', activity_type: 'trekking', lat: 52.7, lng: 158.3, desc_len: 500, has_geometry: true, is_visible: true },
            { id: 'r2', title: 'Водопад Вилючинский', activity_type: 'trekking', lat: 52.7, lng: 158.3, desc_len: 100, has_geometry: false, is_visible: true },
            // Тот же word-set, но другой activity_type — НЕ дубль
            { id: 'r3', title: 'Вачкажец горный массив', activity_type: 'ski', lat: 53.0, lng: 158.0, desc_len: 200, has_geometry: false, is_visible: true },
            { id: 'r4', title: 'Горный массив Вачкажец', activity_type: 'snowmobile', lat: 53.0, lng: 158.0, desc_len: 200, has_geometry: false, is_visible: true },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(false);
    // Слит ровно один дубль (r2 -> r1); r3/r4 разошлись по activity_type
    expect(result.merged_routes).toBe(1);
    // Туры дубля перевешены на keeper r1, дубль r2 скрыт
    expect(updates.some(u => u.includes('UPDATE operator_tours SET route_id') && u.includes('["r1","r2"]'))).toBe(true);
    expect(updates.some(u => u.includes('UPDATE kamchatka_routes SET is_visible = false') && u.includes('"r2"'))).toBe(true);
    // r1 (keeper) НЕ скрывается: первый параметр hide-запроса — скрываемый id
    // (второй — keeper в метке merged_into, поэтому проверяем позицию)
    expect(updates.some(u => u.includes('is_visible = false') && u.includes('["r1"'))).toBe(false);
  });

  it('Шаг 6 v2: тёзки с NULL activity и разъехавшимися координатами сливаются, паспортные данные переливаются', async () => {
    const updates: string[] = [];
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.trim().toUpperCase().startsWith('UPDATE')) {
        updates.push(`${s.replace(/\s+/g, ' ').trim()} :: ${JSON.stringify(params)}`);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (s.includes('FROM kamchatka_routes') && s.includes('has_geometry')) {
        return Promise.resolve({
          rows: [
            // Инвентаризация: «Горный массив Вачкажец» из разных источников —
            // у visitkamchatka пин на объекте, у idilesom старт в городе (~55 км)
            { id: 'v1', title: 'Горный массив Вачкажец', activity_type: null, lat: 53.06, lng: 157.93, desc_len: 800, has_geometry: false, is_visible: true },
            { id: 'v2', title: 'Вачкажец горный массив', activity_type: 'hiking', lat: 52.9, lng: 158.6, desc_len: 200, has_geometry: true, is_visible: true },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(false);
    // keeper = v2 (с треком); v1 слит несмотря на NULL activity и дистанцию
    expect(result.merged_routes).toBe(1);
    // Паспортные/safety-поля дубля перелиты в keeper (COALESCE + OR по МЧС)
    expect(updates.some(u =>
      u.includes('FROM kamchatka_routes d')
      && u.includes('mchs_registration_required')
      && u.includes('["v2","v1"]'),
    )).toBe(true);
    // Дубль скрыт со следом merged_into -> keeper
    expect(updates.some(u => u.includes('merged_into') && u.includes('["v1","v2"]'))).toBe(true);
    // Дистанция попала в аудит-строку отчёта
    const twin = result.items.find(i => i.step === 'route_dupes');
    expect(twin?.detail).toContain('км между записями');
  });

  it('Шаг 2: точная тёзка места (регистр) сливается без дистанционного вето, однословная — нет', async () => {
    const updates: string[] = [];
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.trim().toUpperCase().startsWith('UPDATE')) {
        updates.push(`${s.replace(/\s+/g, ' ').trim()} :: ${JSON.stringify(params)}`);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (s.trim().toUpperCase().startsWith('DELETE')) return Promise.resolve({ rows: [], rowCount: 0 });
      if (s.includes('FROM places p')) {
        return Promise.resolve({ rows: [
          // Инвентаризация: «Кутхины баты»/«Кутхины Баты» ~6 км врозь — одна
          // координата неверна, но объект точно один
          { id: 'k1', ark_id: null, name: 'Кутхины баты', location_type: 'rock', lat: 51.45, lng: 157.10, desc_len: 400, has_photo: true, is_visible: true },
          { id: 'k2', ark_id: null, name: 'Кутхины Баты', location_type: 'rock', lat: 51.49, lng: 157.18, desc_len: 100, has_photo: false, is_visible: true },
          // Перестановка слов (не точная тёзка) дальше 1 км — по-прежнему не дубль
          { id: 't1', ark_id: null, name: 'Озеро Толмачево', location_type: 'lake', lat: 52.60, lng: 157.50, desc_len: 200, has_photo: false, is_visible: true },
          { id: 't2', ark_id: null, name: 'Толмачево озеро', location_type: 'lake', lat: 52.70, lng: 157.60, desc_len: 100, has_photo: false, is_visible: true },
          // Однословная точная тёзка дальше 1 км — слишком слабый сигнал, не дубль
          { id: 's1', ark_id: null, name: 'Шишель', location_type: 'mountain', lat: 57.00, lng: 160.00, desc_len: 200, has_photo: false, is_visible: true },
          { id: 's2', ark_id: null, name: 'Шишель', location_type: 'mountain', lat: 57.10, lng: 160.20, desc_len: 100, has_photo: false, is_visible: true },
        ] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(false);
    expect(result.merged_dupes).toBe(1);
    // keeper = k1 (с фото); k2 скрыт, в отчёте — пометка про тёзку и дистанцию
    expect(updates.some(u => u.includes('UPDATE places SET is_visible = false') && u.includes('"k2"'))).toBe(true);
    const twin = result.items.find(i => i.step === 'dupes');
    expect(twin?.place).toBe('Кутхины Баты');
    expect(twin?.detail).toContain('точная тёзка');
  });

  it('dry-run по маршрутам: считает merged_routes, но не шлёт UPDATE', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('FROM kamchatka_routes') && s.includes('has_geometry')) {
        return Promise.resolve({
          rows: [
            { id: 'r1', title: 'Вулкан Горелый', activity_type: 'trekking', lat: 52.5, lng: 158.0, desc_len: 300, has_geometry: true, is_visible: true },
            { id: 'r2', title: 'Горелый вулкан', activity_type: 'trekking', lat: 52.5, lng: 158.0, desc_len: 100, has_geometry: false, is_visible: true },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(true);
    expect(result.merged_routes).toBe(1);
    for (const call of queryMock.mock.calls) {
      expect(String(call[0]).trim().toUpperCase().startsWith('UPDATE')).toBe(false);
    }
  });

  it('Шаг 8: координатный дубль по подмножеству имени сливается (тот же тип)', async () => {
    const updates: string[] = [];
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.trim().toUpperCase().startsWith('UPDATE')) {
        updates.push(`${s.replace(/\s+/g, ' ').trim()} :: ${JSON.stringify(params)}`);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (s.includes('FROM places p')) {
        return Promise.resolve({ rows: [
          { id: 'a1', ark_id: 'ka1', name: 'Опала',        location_type: 'volcano', lat: 52.5, lng: 157.3, desc_len: 100, has_photo: false, is_visible: true },
          { id: 'a2', ark_id: 'ka2', name: 'Вулкан Опала', location_type: 'volcano', lat: 52.5, lng: 157.3, desc_len: 300, has_photo: false, is_visible: true },
        ] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const result = await runDataRepair(false);
    expect(result.merged_coord_subset).toBe(1);
    // keeper = «Вулкан Опала» (длиннее описание/полнее имя); скрыт «Опала» (a1)
    expect(updates.some(u => u.includes('UPDATE places SET is_visible = false') && u.includes('"a1"'))).toBe(true);
    expect(updates.some(u => u.includes('is_visible = false') && u.includes('"a2"'))).toBe(false);
    expect(updates.some(u => u.includes('route_waypoints SET place_id') && u.includes('["a2","a1"]'))).toBe(true);
  });

  it('Шаг 8: разный location_type НЕ сливается (не убираем опасную зону)', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.trim().toUpperCase().startsWith('UPDATE')) return Promise.resolve({ rows: [], rowCount: 1 });
      if (s.includes('FROM places p')) {
        return Promise.resolve({ rows: [
          { id: 'b1', ark_id: null, name: 'Асача',        location_type: 'volcano', lat: 52.5, lng: 157.3, desc_len: 100, has_photo: false, is_visible: true },
          { id: 'b2', ark_id: null, name: 'Вулкан Асача', location_type: 'viewpoint', lat: 52.5, lng: 157.3, desc_len: 100, has_photo: false, is_visible: true },
        ] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const result = await runDataRepair(false);
    expect(result.merged_coord_subset).toBe(0);
  });

  it('Шаг 8: не подмножество имени (разные слова) НЕ сливается', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.trim().toUpperCase().startsWith('UPDATE')) return Promise.resolve({ rows: [], rowCount: 1 });
      if (s.includes('FROM places p')) {
        return Promise.resolve({ rows: [
          { id: 'c1', ark_id: null, name: 'Первая лужа', location_type: 'lake', lat: 52.5, lng: 157.3, desc_len: 100, has_photo: false, is_visible: true },
          { id: 'c2', ark_id: null, name: 'Вторая лужа', location_type: 'lake', lat: 52.5, lng: 157.3, desc_len: 100, has_photo: false, is_visible: true },
        ] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const result = await runDataRepair(false);
    expect(result.merged_coord_subset).toBe(0);
  });

  it('Шаг 7: thermal -> hot_spring (dry-run считает, не мутирует)', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes("location_type = 'thermal'") && s.includes('COUNT(*)')) {
        return Promise.resolve({ rows: [{ n: 1 }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const result = await runDataRepair(true);
    expect(result.normalized_types).toBe(1);
    for (const call of queryMock.mock.calls) {
      expect(String(call[0]).trim().toUpperCase().startsWith('UPDATE')).toBe(false);
    }
  });

  it('Шаг 1b: псевдокластер из 3+ мест — координата чинится из финиша трека тёзки, без тёзки — нет', async () => {
    const updates: string[] = [];
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.trim().toUpperCase().startsWith('UPDATE')) {
        updates.push(`${s.replace(/\s+/g, ' ').trim()} :: ${JSON.stringify(params)}`);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (s.trim().toUpperCase().startsWith('DELETE')) return Promise.resolve({ rows: [], rowCount: 0 });
      if (s.includes('FROM places p')) {
        // Кластер Эссо: три разноимённых места в ~15 м друг от друга
        return Promise.resolve({ rows: [
          { id: 'e1', ark_id: null, name: 'Каньон Сноубордистов', location_type: 'other', lat: 55.9000, lng: 158.7000, desc_len: 100, has_photo: false, is_visible: true },
          { id: 'e2', ark_id: null, name: 'Озеро Галямаки', location_type: 'lake', lat: 55.9001, lng: 158.7001, desc_len: 100, has_photo: false, is_visible: true },
          { id: 'e3', ark_id: null, name: 'Скала Черный замок', location_type: 'rock', lat: 55.9002, lng: 158.7000, desc_len: 100, has_photo: false, is_visible: true },
          // Одиночное место с той же дрожью в другом углу — не кластер, не трогаем
          { id: 's1', ark_id: null, name: 'Гора Одинокая', location_type: 'mountain', lat: 52.0, lng: 157.0, desc_len: 100, has_photo: false, is_visible: true },
        ] });
      }
      if (s.includes('WHERE geometry IS NOT NULL AND title IS NOT NULL')) {
        return Promise.resolve({ rows: [
          // Трек маршрута-тёзки: финиш — сам каньон
          { title: 'Каньон Сноубордистов', geometry: { coordinates: [[158.71, 55.92], [158.73, 55.94], [158.75, 55.96]] } },
          // Генерик-слово «озеро» совпадает, но набор слов другой — НЕ донор
          // (регрессия run 15: «ПП Быстринский» получал трек «ПП Налычево»)
          { title: 'Озеро Дальнее', geometry: { coordinates: [[161.0, 56.5], [161.2, 56.6], [161.4, 56.7]] } },
        ] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(false);
    expect(result.coords_from_twin_track).toBe(1);
    // e1 -> финиш трека (lat=55.96, lng=158.75)
    expect(updates.some(u => u.includes('UPDATE places SET lat') && u.includes('"e1"') && u.includes('55.96'))).toBe(true);
    // Места без тёзки-трека и одиночка не тронуты
    expect(updates.some(u => u.includes('UPDATE places SET lat') && (u.includes('"e2"') || u.includes('"e3"') || u.includes('"s1"')))).toBe(false);
  });

  it('Шаг 9b: координата маршрута дальше 30 км от собственного трека чинится на старт трека, близкая — нет', async () => {
    const updates: string[] = [];
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.trim().toUpperCase().startsWith('UPDATE')) {
        updates.push(`${s.replace(/\s+/g, ' ').trim()} :: ${JSON.stringify(params)}`);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (s.includes('WHERE is_visible = TRUE AND geometry IS NOT NULL')) {
        return Promise.resolve({ rows: [
          // Кейс Бакенинга: координата маршрута в ~100 км от трека — чинится
          { id: 'g1', title: 'Вулкан Бакенинг', lat: '53.0', lng: '156.7',
            geometry: { coordinates: [[158.05, 53.89], [158.07, 53.90], [158.09, 53.91]] } },
          // Координата на треке — не трогаем
          { id: 'g2', title: 'Вулкан Горелый', lat: '52.56', lng: '158.03',
            geometry: { coordinates: [[158.03, 52.56], [158.05, 52.57]] } },
          // Координаты нет, трек есть — заполняется стартом
          { id: 'g3', title: 'Тропа без координаты', lat: null, lng: null,
            geometry: { coordinates: [[158.20, 53.10], [158.25, 53.12]] } },
        ] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(false);
    expect(result.fixed_route_coords).toBe(2);
    // g1 -> старт трека (lat=53.89, lng=158.05)
    expect(updates.some(u => u.includes('UPDATE kamchatka_routes SET lat') && u.includes('"g1"') && u.includes('53.89'))).toBe(true);
    // g3 -> заполнение стартом
    expect(updates.some(u => u.includes('UPDATE kamchatka_routes SET lat') && u.includes('"g3"'))).toBe(true);
    // g2 не трогаем
    expect(updates.some(u => u.includes('"g2"'))).toBe(false);
  });

  it('Шаг 9b: dry-run считает, но не мутирует', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('WHERE is_visible = TRUE AND geometry IS NOT NULL')) {
        return Promise.resolve({ rows: [
          { id: 'g1', title: 'Вулкан Бакенинг', lat: '53.0', lng: '156.7',
            geometry: { coordinates: [[158.05, 53.89], [158.09, 53.91]] } },
        ] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const result = await runDataRepair(true);
    expect(result.fixed_route_coords).toBe(1);
    for (const call of queryMock.mock.calls) {
      expect(String(call[0]).trim().toUpperCase().startsWith('UPDATE')).toBe(false);
    }
  });

  it('Шаг 10: waypoints дальше 30 км попадают в отчёт, ближние — нет, БД не мутируется', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('FROM route_waypoints rw') && s.includes('JOIN kamchatka_routes kr')) {
        return Promise.resolve({ rows: [
          // Кейс владельца: Налычево-трек с чужой точкой (~40 км)
          { route_id: 'r1', route_title: 'Пиначево — Центральный', route_lat: '53.42', route_lng: '158.55',
            place_id: 'p1', place_name: 'Козельский', place_lat: '53.06', place_lng: '158.88' },
          // Легитимная точка в 2 км от маршрута
          { route_id: 'r1', route_title: 'Пиначево — Центральный', route_lat: '53.42', route_lng: '158.55',
            place_id: 'p2', place_name: 'Кордон Пиначево', place_lat: '53.43', place_lng: '158.57' },
        ] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(false); // даже в apply — только отчёт
    expect(result.waypoint_outliers).toBe(1);
    const outlierItems = result.items.filter(i => i.step === 'wp_outlier');
    expect(outlierItems).toHaveLength(1);
    expect(outlierItems[0].place).toBe('Козельский');
    expect(outlierItems[0].detail).toContain('Пиначево — Центральный');
    // Шаг 10 — только отчёт: связки waypoints никто не переписывает и не удаляет
    // (другие шаги в apply-режиме легитимно мутируют СВОИ таблицы)
    for (const call of queryMock.mock.calls) {
      const s = String(call[0]).trim().toUpperCase();
      if (s.startsWith('UPDATE') || s.startsWith('DELETE')) {
        expect(s).not.toContain('ROUTE_WAYPOINTS');
      }
    }
  });

  it('Шаг 10: маршрут БЕЗ координаты — опорная точка медиана waypoints, беглец виден', async () => {
    // Скрин владельца 2026-07-19: «Однодневный поход к Авачинскому» без
    // lat/lng, 6 точек у вулкана + Каменный лес княженики в сотнях км —
    // раньше весь маршрут выпадал из диагностики.
    const near = (i: number) => ({
      route_id: 'r2', route_title: 'Однодневный поход к Авачинскому', route_lat: null, route_lng: null,
      place_id: `n${i}`, place_name: `Точка ${i}`, place_lat: String(53.25 + i * 0.001), place_lng: '158.83',
    });
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('FROM route_waypoints rw') && s.includes('JOIN kamchatka_routes kr')) {
        return Promise.resolve({ rows: [
          near(1), near(2), near(3), near(4), near(5), near(6),
          { route_id: 'r2', route_title: 'Однодневный поход к Авачинскому', route_lat: null, route_lng: null,
            place_id: 'far', place_name: 'Каменный лес княженики', place_lat: '55.7', place_lng: '160.0' },
          // Маршрут без координаты и всего с 2 точками — мерить не от чего, не флажим
          { route_id: 'r3', route_title: 'Пара точек', route_lat: null, route_lng: null,
            place_id: 'a', place_name: 'А', place_lat: '53.0', place_lng: '158.0' },
          { route_id: 'r3', route_title: 'Пара точек', route_lat: null, route_lng: null,
            place_id: 'b', place_name: 'Б', place_lat: '57.0', place_lng: '160.0' },
        ] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(true);
    expect(result.waypoint_outliers).toBe(1);
    const outlier = result.items.filter(i => i.step === 'wp_outlier');
    expect(outlier).toHaveLength(1);
    expect(outlier[0].place).toBe('Каменный лес княженики');
    expect(outlier[0].detail).toContain('Однодневный поход к Авачинскому');
  });

});

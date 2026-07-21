/**
 * Ремонт данных — Шаг 9 (морфологические координатные дубли) и чистка имён.
 * Ловит то, что пропускают Шаги 2/8: «Авачинская сопка» ↔ «Авачинский вулкан».
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
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

import { runDataRepair, shouldMergeMorphological, classifyPlaceName } from '@/lib/services/data-repair';

// Авача: ~53.256N 158.83E. +0.0005° широты ≈ 55 м; +0.002° ≈ 222 м.
const AVA = { lat: 53.256, lng: 158.83 };
const near = { lat: 53.2565, lng: 158.83 };  // ~55 м
const far  = { lat: 53.258, lng: 158.83 };   // ~222 м

describe('shouldMergeMorphological', () => {
  it('Авача сопка ↔ вулкан (один тип, 55 м, сильное имя) → сливаем', () => {
    expect(shouldMergeMorphological(
      { name: 'Авачинская сопка', location_type: 'volcano', ...AVA },
      { name: 'Авачинский вулкан', location_type: 'volcano', ...near },
    )).toBe(true);
  });

  it('разный тип (бухта vs вулкан) → НЕ сливаем, даже если имя «Авачинск*»', () => {
    expect(shouldMergeMorphological(
      { name: 'Авачинская бухта', location_type: 'bay', ...AVA },
      { name: 'Авачинский вулкан', location_type: 'volcano', ...near },
    )).toBe(false);
  });

  it('разные объекты в одной точке (bogus-координаты) → НЕ сливаем (имя не strong)', () => {
    // Экструзия Верблюд и Жупановский стоят у координат Авачи из-за заглушки геокодера
    expect(shouldMergeMorphological(
      { name: 'Авачинский вулкан', location_type: 'volcano', ...AVA },
      { name: 'Экструзия Верблюд', location_type: 'volcano', ...near },
    )).toBe(false);
    expect(shouldMergeMorphological(
      { name: 'Авачинский вулкан', location_type: 'volcano', ...AVA },
      { name: 'Вулкан Жупановский', location_type: 'volcano', ...near },
    )).toBe(false);
  });

  it('те же имена, но > 150 м → НЕ сливаем (разные объекты)', () => {
    expect(shouldMergeMorphological(
      { name: 'Авачинская сопка', location_type: 'volcano', ...AVA },
      { name: 'Авачинский вулкан', location_type: 'volcano', ...far },
    )).toBe(false);
  });

  it('нет координат → НЕ сливаем', () => {
    expect(shouldMergeMorphological(
      { name: 'Авачинская сопка', location_type: 'volcano', lat: null, lng: null },
      { name: 'Авачинский вулкан', location_type: 'volcano', ...near },
    )).toBe(false);
  });
});

describe('classifyPlaceName', () => {
  it('тур-подборки и мусорные имена → hide', () => {
    expect(classifyPlaceName('Камчатка. Такие места').action).toBe('hide');
    expect(classifyPlaceName('Долина гейзеров. Курильское озеро. Вулканы Горелый и Авача').action).toBe('hide');
    expect(classifyPlaceName('На Авачинский перевал и Экструзию Верблюд').action).toBe('hide');
  });

  it('реальное место со статейным именем → rename на чистое', () => {
    const r = classifyPlaceName('Авачинский перевал. Экструзия Верблюд. Евражки. Безопасность.');
    expect(r.action).toBe('rename');
    expect(r.to).toBe('Авачинский перевал');
  });

  it('нормальное имя → keep', () => {
    expect(classifyPlaceName('Авачинский вулкан').action).toBe('keep');
    expect(classifyPlaceName('Курильское озеро').action).toBe('keep');
  });
});

describe('runDataRepair — Шаг 9 интеграционно', () => {
  beforeEach(() => queryMock.mockReset());

  function mockPlaces(rows: unknown[]) {
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.trim().toUpperCase().startsWith('UPDATE') || s.trim().toUpperCase().startsWith('DELETE')) {
        return Promise.resolve({ rows: [], rowCount: 1, _params: params });
      }
      if (s.includes('FROM places p')) return Promise.resolve({ rows });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
  }

  const avaRows = [
    { id: 'p_sopka', ark_id: 'ka_s', name: 'Авачинская сопка', location_type: 'volcano', lat: 53.256, lng: 158.83, desc_len: 100, has_photo: false, is_visible: true },
    { id: 'p_vulkan', ark_id: 'ka_v', name: 'Авачинский вулкан', location_type: 'volcano', lat: 53.2565, lng: 158.83, desc_len: 300, has_photo: false, is_visible: true },
  ];

  it('apply: Авача-варианты сливаются в один (keeper — с длиннее описанием)', async () => {
    const updates: string[] = [];
    queryMock.mockImplementation((sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.trim().toUpperCase().startsWith('UPDATE') || s.trim().toUpperCase().startsWith('DELETE')) {
        updates.push(`${s.replace(/\s+/g, ' ').trim()} :: ${JSON.stringify(params)}`);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (s.includes('FROM places p')) return Promise.resolve({ rows: avaRows });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await runDataRepair(false);
    expect(result.merged_morph).toBe(1);
    // keeper = «Авачинский вулкан» (desc_len 300) → скрыт дубль «Авачинская сопка» (p_sopka)
    expect(updates.some(u => u.includes('UPDATE places SET is_visible = false') && u.includes('"p_sopka"'))).toBe(true);
    expect(updates.some(u => u.includes('is_visible = false') && u.includes('"p_vulkan"'))).toBe(false);
    // Ссылки перевешены на keeper p_vulkan
    expect(updates.some(u => u.includes('route_waypoints SET place_id') && u.includes('["p_vulkan","p_sopka"]'))).toBe(true);
  });

  it('dry-run: считает merged_morph, но не мутирует', async () => {
    mockPlaces(avaRows);
    const result = await runDataRepair(true);
    expect(result.merged_morph).toBe(1);
    for (const call of queryMock.mock.calls) {
      const s = String(call[0]).trim().toUpperCase();
      expect(s.startsWith('UPDATE') || s.startsWith('DELETE')).toBe(false);
    }
  });

  it('разный тип не сливается Шагом 9', async () => {
    mockPlaces([
      { id: 'x1', ark_id: null, name: 'Авачинская бухта', location_type: 'bay', lat: 53.256, lng: 158.83, desc_len: 100, has_photo: false, is_visible: true },
      { id: 'x2', ark_id: null, name: 'Авачинский вулкан', location_type: 'volcano', lat: 53.2565, lng: 158.83, desc_len: 100, has_photo: false, is_visible: true },
    ]);
    const result = await runDataRepair(false);
    expect(result.merged_morph).toBe(0);
  });
});

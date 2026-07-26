/**
 * Добивка описаний — регрессия ночного инцидента июля 2026:
 * pg отдаёт NUMERIC (lat/lng) строкой, .toFixed() на строке ронял КАЖДЫЙ
 * объект партии, крон месяц отчитывался success при errors=20/20.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: vi.fn(async () => ({ userId: 'admin' })),
}));

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

const qualityMock = vi.fn();
vi.mock('@/lib/ai/providers', () => ({
  callAIFast: vi.fn(async () => '{}'),
  callAIQualityOrNull: (...args: unknown[]) => qualityMock(...args),
}));

import { enrichDescriptions } from '@/app/api/admin/enrich-routes/route';

// Строки в lat/lng — как реально отдаёт pg для NUMERIC без каста
const ROW = {
  id: 'r1',
  title: 'Бухта Калыгирь',
  description: null,
  category: null,
  location_type: 'bay',
  activity_type: null,
  lat: '52.938' as unknown as number,
  lng: '159.881' as unknown as number,
  payload: {},
};

beforeEach(() => {
  queryMock.mockReset();
  qualityMock.mockReset();
  // 1-й вызов — выборка партии, 2-й — UPDATE, последний — remaining
  queryMock.mockImplementation(async (sql: string) => {
    if (/SELECT id, title/.test(sql)) return { rows: [ROW] };
    if (/COUNT\(\*\) as cnt/.test(sql)) return { rows: [{ cnt: '5' }] };
    return { rows: [] };
  });
});

describe('enrichDescriptions', () => {
  it('строковые lat/lng из pg не роняют генерацию (регрессия toFixed)', async () => {
    qualityMock.mockResolvedValue('Т'.repeat(350));

    const res = await enrichDescriptions(20, false, false);
    const json = await res.json();

    expect(json.improved).toBe(1);
    expect(json.errors).toBe(0);
    // Координаты дошли до промпта числами, а не упали
    const prompt = (qualityMock.mock.calls[0][0] as Array<{ content: string }>)[0].content;
    expect(prompt).toContain('52.938');
    // UPDATE случился
    expect(queryMock.mock.calls.some(c => /UPDATE agent_route_knowledge/.test(c[0] as string))).toBe(true);
  });

  it('отказ всех провайдеров (null) — ошибка без записи в БД', async () => {
    qualityMock.mockResolvedValue(null);

    const res = await enrichDescriptions(20, false, false);
    const json = await res.json();

    expect(json.improved).toBe(0);
    expect(json.errors).toBe(1);
    expect(queryMock.mock.calls.some(c => /UPDATE agent_route_knowledge/.test(c[0] as string))).toBe(false);
  });

  it('короткий огрызок (<100 символов) не пишется как описание', async () => {
    qualityMock.mockResolvedValue('Красивое место.');

    const res = await enrichDescriptions(20, false, false);
    const json = await res.json();

    expect(json.improved).toBe(0);
    expect(queryMock.mock.calls.some(c => /UPDATE agent_route_knowledge/.test(c[0] as string))).toBe(false);
  });
});

describe('структурно: цены не выдумываются', () => {
  it('в источнике нет генерации price_from и ценовых подсказок модели', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/api/admin/enrich-routes/route.ts', 'utf8');
    expect(src).not.toMatch(/Price guidelines/);
    expect(src).not.toMatch(/"price_from": number/);
    expect(src).not.toMatch(/merged\.price_from/);
    // Выборка и генерация описаний идут по качественному пути, не по гонке
    expect(src).toMatch(/callAIQualityOrNull/);
    // Каст NUMERIC → float8 на месте (страховка от возврата toFixed-бага)
    expect(src).toMatch(/lat::float8/);
  });
});

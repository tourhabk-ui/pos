/**
 * Добивка описаний — регрессия ночного инцидента июля 2026:
 * pg отдаёт NUMERIC (lat/lng) строкой, .toFixed() на строке ронял КАЖДЫЙ
 * объект партии, крон месяц отчитывался success при errors=20/20.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// С 22.10 модель тексты мест не пишет — слово владельца
// (model-place-text-paused.test.ts держит выключенное). Здесь судится путь
// записи на день, когда его включат снова: проверки после модели должны
// стоять на месте.
vi.mock('@/lib/places/model-place-text', () => ({ MODEL_WRITES_PLACE_TEXT: true, MODEL_PLACE_TEXT_PAUSED_MESSAGE: '' }));
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

describe('проверка после модели (владелец 14.10: «3 да»)', () => {
  const TUPIKIN = 'Тупикин ключ — короткий пеший маршрут к одному из живописных водопадов Камчатки, '
    + 'расположенному в долине реки Паратунка. Тропа начинается от старой дороги к Паратунским горячим '
    + 'источникам и проходит через смешанный лес. Длина пути в одну сторону составляет около 2,5 километров, '
    + 'перепад высот небольшой — до 100 метров.';

  it('описание, достроенное по названию (чужое место, числа), не пишется — и причина названа', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id, title/.test(sql)) return { rows: [{ ...ROW, title: 'Тупикин ключ', location_type: null, category: 'trekking' }] };
      if (/COUNT\(\*\) as cnt/.test(sql)) return { rows: [{ cnt: '1' }] };
      return { rows: [] };
    });
    qualityMock.mockResolvedValue(TUPIKIN);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const json = await (await enrichDescriptions(20, false, false)).json();
    expect(json).toMatchObject({ improved: 0, rejected: 1, errors: 0 });
    expect(queryMock.mock.calls.some(c => /UPDATE agent_route_knowledge/.test(c[0] as string))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('сказано сверх данных'),
      expect.objectContaining({ names: expect.arrayContaining(['Паратунка']), numbers: expect.arrayContaining(['2,5', '100']) }));
    warn.mockRestore();
  });

  it('пересказ названия и типа без новых имён и чисел — пишется', async () => {
    qualityMock.mockResolvedValue('Бухта Калыгирь — бухта на побережье Камчатки. Подъезд к берегу зависит от погоды и '
      + 'состояния грунтовых дорог, поэтому поездку стоит планировать заранее и уточнять обстановку перед выездом.');
    const json = await (await enrichDescriptions(20, false, false)).json();
    expect(json).toMatchObject({ improved: 1, rejected: 0 });
  });

  it('прежнее описание — путевая заметка: модель не зовётся, дополнять нечего', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id, title/.test(sql)) return { rows: [{ ...ROW, description: 'Вчера я поднялся к бухте, мы шли берегом.' }] };
      if (/COUNT\(\*\) as cnt/.test(sql)) return { rows: [{ cnt: '1' }] };
      return { rows: [] };
    });
    const json = await (await enrichDescriptions(20, false, false)).json();
    expect(qualityMock).not.toHaveBeenCalled();
    expect(json).toMatchObject({ improved: 0, skipped: 1 });
  });

  it('очередь не стоит на месте: отказы не занимают партию навсегда', async () => {
    await enrichDescriptions(20, false, false);
    const pick = String(queryMock.mock.calls.find(c => /SELECT id, title/.test(c[0] as string))![0]);
    expect(pick).not.toMatch(/ELSE 1 END, title/);
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

/**
 * «Анализатор безопасности» (/tools/safety): маршрут находится по обоим его
 * номерам, и непроверенный телефон в модель не уходит (14.11).
 *
 * У маршрута два id (lib/routes/collect-signals): поиск отдаёт id карточки —
 * COALESCE(ark_id, id), а строка и путевые точки живут на kamchatka_routes.id.
 * Инструмент искал только по id строки: у маршрута с заполненным ark_id ответ
 * был «Маршрут не найден» (перепись 12.11: таких 77 из 368).
 *
 * Там же: в промпт модели уходил `kamchatka_routes.mchs_phone` — региональный
 * номер, который владелец не проверял, — и модель могла перенести его в блок
 * «ЧС». Региональный номер показывается только из lib/safety/emergency-numbers.
 *
 * Судится вызовом роута: что спросили у базы и что ушло модели.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const ROW_ID = '11111111-1111-4111-8111-111111111111';
const CARD_ID = '22222222-2222-4222-8222-222222222222';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const DB_PHONE = '+7 (4152) 23-53-62';

interface Call { sql: string; params: unknown[] }
const calls: Call[] = [];
const aiCalls: Array<Array<{ role: string; content: string }>> = [];

const ROUTE_ROW = {
  id: ROW_ID,
  ark_id: CARD_ID,
  title: 'Вулкан Горелый',
  distance_km: 9,
  elevation_gain_m: 900,
  duration_hours: 6,
  difficulty: 'medium',
  hazards: ['volcanic_gas'],
  mchs_registration_required: true,
  // Колонка в базе есть. Запрос её больше не читает, но подставная база отдаёт
  // её всегда: вернётся строка в промпт — сторож увидит номер.
  mchs_phone: DB_PHONE,
};

vi.mock('@/lib/database', () => ({
  query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const id = String(params[0]);
    if (sql.includes('ark_id::text = $1')) {
      const hit = id === ROW_ID || id === CARD_ID;
      return { rows: hit ? [{ id: ROW_ID, zone: null, season: null, lat: null, lng: null }] : [] };
    }
    if (sql.includes('FROM route_waypoints')) {
      // Точки привязаны к id строки: по id карточки база не находит ничего.
      return {
        rows: id === ROW_ID
          ? [{
            name: 'Кратер', hazard_types: ['volcanic_gas'], difficulty_level: 3, altitude_m: 1829, profile_source: 'manual',
            nearest_medical_km: 75, sat_communicator_required: true, registration_required: true,
            alert_severity: null, alert_message: null, active_alerts: null,
          }]
          : [],
      };
    }
    if (sql.includes('FROM kamchatka_routes')) {
      return { rows: id === ROW_ID ? [ROUTE_ROW] : [] };
    }
    return { rows: [] };
  },
}));

vi.mock('@/lib/ai/providers', () => ({
  callAIFast: async (messages: Array<{ role: string; content: string }>) => {
    aiCalls.push(messages);
    return JSON.stringify({ assessment: 'Оценка.', recommendations: ['Совет.'], emergencyTip: 'Звоните.' });
  },
}));

import { POST } from '@/app/api/tools/safety/route';
import { ROUTE_ROW_BY_ANY_ID_SQL } from '@/lib/routes/collect-signals';

let ipSeq = 0;
function ask(body: unknown): Promise<Response> {
  ipSeq += 1;
  return POST(new NextRequest('http://localhost/api/tools/safety', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.0.${ipSeq}` },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  calls.length = 0;
  aiCalls.length = 0;
});

describe('маршрут находится по обоим номерам', () => {
  it('по номеру карточки (его отдаёт поиск) — маршрут найден, точки прочитаны по номеру строки', async () => {
    const res = await ask({ routeId: CARD_ID });
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; data: { placeName: string; altitudeM: number | null; hazards: string[] } };
    expect(json.success).toBe(true);
    expect(json.data.placeName).toBe('Вулкан Горелый');
    // Высота берётся из путевой точки: дошла — значит точки спрошены по id строки.
    expect(json.data.altitudeM).toBe(1829);

    const waypoints = calls.find(c => c.sql.includes('FROM route_waypoints'));
    expect(waypoints?.params).toEqual([ROW_ID]);
    const routeData = calls.find(c => c.sql.includes('FROM kamchatka_routes') && !c.sql.includes('ark_id::text'));
    expect(routeData?.params).toEqual([ROW_ID]);
  });

  it('по номеру строки — тот же маршрут', async () => {
    const res = await ask({ routeId: ROW_ID });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { placeName: string } };
    expect(json.data.placeName).toBe('Вулкан Горелый');
  });

  it('какая строка — решает общее с карточкой правило, первым запросом', async () => {
    await ask({ routeId: CARD_ID });
    expect(calls[0]?.sql).toBe(ROUTE_ROW_BY_ANY_ID_SQL);
    expect(calls[0]?.params).toEqual([CARD_ID]);
  });

  it('маршрута нет — 404 словами, модель не зовётся', async () => {
    const res = await ask({ routeId: UNKNOWN_ID });
    expect(res.status).toBe(404);
    const json = await res.json() as { success: boolean; error: string };
    expect(json).toEqual({ success: false, error: 'Маршрут не найден' });
    expect(aiCalls).toHaveLength(0);
    // Данные и точки без найденной строки не спрашиваются.
    expect(calls).toHaveLength(1);
  });
});

describe('непроверенный телефон из базы в модель не уходит', () => {
  it('в промпте нет номера из kamchatka_routes.mchs_phone', async () => {
    const res = await ask({ routeId: CARD_ID });
    expect(res.status).toBe(200);
    expect(aiCalls).toHaveLength(1);
    const prompt = aiCalls[0].map(m => m.content).join('\n');
    expect(prompt).toContain('МАРШРУТ: Вулкан Горелый');
    expect(prompt).not.toContain(DB_PHONE);
    expect(prompt).not.toMatch(/Телефон МЧС/i);
  });
});

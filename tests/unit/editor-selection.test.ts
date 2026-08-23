/**
 * tests/unit/editor-selection.test.ts
 *
 * Фидбэк владельца (07.2026): короткие описания (<300) переселялись КАЖДЫЙ
 * прогон Editor, бесконечно циклясь. Эти тесты фиксируют новый контракт
 * выборки: NULL-описания в приоритете, а уже обработанные короткие
 * «отдыхают» перед повторной попыткой (updated_at + REATTEMPT_REST_DAYS).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runEditor, type RouteRow } from '@/lib/agents/editor';

const callAIFastMock = vi.fn<(...args: unknown[]) => Promise<string | null>>();
vi.mock('@/lib/ai/providers', () => ({
  callAIFast: (...args: unknown[]) => callAIFastMock(...args),
  AI_FAST_UNAVAILABLE: 'Сервис временно недоступен.',
  // Editor опрашивает провайдеров через callAIFastOrNull: отказ ВСЕХ = null.
  callAIFastOrNull: async (...args: unknown[]) => {
    const text = await callAIFastMock(...args);
    return text === 'Сервис временно недоступен.' ? null : text;
  },
  // Editor переведён на КАЧЕСТВЕННЫЙ путь (callAIQualityOrNull): контент пишет
  // сильнейшая доступная модель по очереди, а не победитель гонки на скорость.
  // Мок сохраняет прежний контракт: отказ ВСЕХ провайдеров = null.
  callAIQuality: (...a: unknown[]) => callAIFastMock(...a),
  callAIQualityOrNull: async (...a: unknown[]) => {
    const text = await callAIFastMock(...a);
    return text === 'Сервис временно недоступен.' ? null : text;
  },
}));

const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));

const ROUTE: RouteRow = {
  id: '00000000-0000-0000-0000-000000000001',
  title: 'Вулкан Тестовый',
  description: null,
  category: 'vulkani',
  // Факты обязательны для нормального пути: с 23.08 запись, о которой в базе
  // нет ничего кроме названия, в модель НЕ идёт вовсе — это отдельный исход
  // «источника нет», а не ошибка генерации. Фикстура без фактов проверяла бы
  // именно его, а не то, ради чего написана.
  kind: 'place',
  lat: 53.2551, lng: 158.8307,
  location_type: 'volcano', activity_type: null, zone: 'avachinsky',
  source_name: 'visitkamchatka',
  altitude_m: 2741, terrain_type: 'вулканический шлак', hazard_types: ['камнепад'],
  difficulty_level: 'medium', nearest_medical_km: 30,
  distance_km: null, elevation_gain_m: null, duration_hours: null,
  season: null, route_type: null, hazards: null, equipment: null, park_name: null,
};
const LONG_TEXT = 'Содержательное описание вулкана. '.repeat(15);

function capture() {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  poolQueryMock.mockImplementation((sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes('LEFT JOIN location_safety_profile')) return Promise.resolve({ rows: [ROUTE] });
    if (sql.includes('UPDATE agent_route_knowledge')) return Promise.resolve({ rows: [] });
    if (sql.includes('FILTER')) return Promise.resolve({ rows: [{ queue: '3', total_short: '11' }] });
    return Promise.resolve({ rows: [] });
  });
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  callAIFastMock.mockResolvedValue(LONG_TEXT);
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

describe('findRoutesNeedingDescription: приоритет NULL + отдых коротких', () => {
  it('SELECT: NULL-первыми и короткие только «отдохнувшие» (>7 дней)', async () => {
    const calls = capture();
    await runEditor();

    const select = calls.find(c => c.sql.includes('LEFT JOIN location_safety_profile'));
    expect(select).toBeTruthy();
    // Короткие берутся только если updated_at старее интервала
    expect(select!.sql).toContain('make_interval');
    expect(select!.sql).toContain('LENGTH(ark.description) < $1');
    // NULL-описания в приоритете сортировки
    expect(select!.sql).toContain('(ark.description IS NULL) DESC');
    // Параметр «дней отдыха» передан (REATTEMPT_REST_DAYS = 7)
    expect(select!.params).toContain(7);
  });

  it('счётчик: отдельно очередь (actionable) и всего коротких', async () => {
    const calls = capture();
    await runEditor();

    const countSql = calls.find(c => c.sql.includes('FILTER'));
    expect(countSql).toBeTruthy();
    // Обе метрики считаются одним запросом
    expect(countSql!.sql).toContain('AS queue');
    expect(countSql!.sql).toContain('AS total_short');
  });
});

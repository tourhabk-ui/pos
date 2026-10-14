/**
 * Журнал вызовов хранит вывод инструмента места целиком (14.10).
 *
 * По журналу судят трое: судья эвала faithfulness, сторож километража и
 * сверка утверждений об опасностях в живом ответе. Журнал резал любой вывод
 * до двух тысяч знаков с припиской «две тысячи покрывают ответ
 * get_guardian_context целиком». Когда в ответ места пришли факты маршрутов
 * (#2491), он вырос до 3–7 тысяч, и блок маршрутов лёг за обрезку. Модель его
 * видела, журнал — нет. Прогон эвала 22 поставил единицы за телефон МЧС,
 * набор высоты и снаряжение, которые стояли в выводе дословно.
 *
 * Сторож — вызов настоящего aiChatAgentLoop (подменены провайдер и база): что
 * легло в журнал и что из этого делает живая сверка опасностей.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { waterfall, query } = vi.hoisted(() => ({ waterfall: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/ai/providers')>();
  return { ...orig, callToolsWaterfall: (...a: unknown[]) => waterfall(...a) };
});
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));

import { aiChatAgentLoop, journalToolOutput } from '@/lib/kuzmich/core';
import { guardSafetyClaims } from '@/lib/kuzmich/safety-claim-guard';
import type { ToolRun } from '@/lib/agents/eval/grounding';

const PHONE = '+7 (4152) 30-10-81';

const avacha = {
  id: '9b1f0c2e-0000-4000-8000-000000000002', is_visible: true, name: 'Вулкан Авачинский',
  location_type: 'volcano', lat: 53.25537, lng: 158.83621, recommender_status: 'green',
  description: 'Авачинский вулкан — один из самых доступных вулканов Камчатки. '.repeat(6),
  hazard_types: [], profile_source: 'type_template', altitude_m: null, nearest_medical_km: null,
};

/** Четыре маршрута с длинными описаниями: ответ инструмента выходит за 2000 знаков. */
const routes = [1, 2, 3, 4].map((i) => ({
  id: `r${i}`, title: `Маршрут к Авачинскому ${i}`, difficulty: 'medium', distance_km: '14.00',
  elevation_gain_m: 1859, duration_hours: '12.50', season: 'all',
  hazards: i === 4 ? ['лавины на склоне'] : ['крутизна склона 30°'],
  equipment: ['фальшфейеры'], mchs_registration_required: i === 4, mchs_phone: i === 4 ? PHONE : null,
  park_name: null,
  description: `Подъём на Авачинский вулкан по маршруту ${i}: тропа идёт через шлаковые поля и снежники, вершина открывается после седловины. `.repeat(2),
}));

function db() {
  query.mockImplementation((sql: string) => {
    if (sql.includes('FROM kamchatka_routes kr')) return Promise.resolve({ rows: routes });
    if (sql.includes('FROM route_waypoints')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM places')) return Promise.resolve({ rows: [avacha] });
    return Promise.resolve({ rows: [] });
  });
}

/** Модель зовёт инструмент места, затем отвечает. */
function modelCallsGuardian() {
  waterfall.mockReset();
  waterfall
    .mockResolvedValueOnce({
      content: null, provider: 'test',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_guardian_context', arguments: JSON.stringify({ place: 'Авачинский вулкан' }) } }],
    })
    .mockResolvedValueOnce({ content: 'Ответ.', provider: 'test' });
}

async function journalOfOneTurn(): Promise<ToolRun[]> {
  const runs: ToolRun[] = [];
  await aiChatAgentLoop('Опасно ли подниматься на Авачинский вулкан?', 'система', [], [], runs);
  return runs;
}

beforeEach(() => {
  query.mockReset();
  db();
  modelCallsGuardian();
});

describe('вывод инструмента места — в журнале целиком', () => {
  it('ответ места длиннее 2000 знаков доходит до журнала вместе с последним маршрутом', async () => {
    const runs = await journalOfOneTurn();
    const guardian = runs.find((r) => r.name === 'get_guardian_context');
    expect(guardian?.producedData).toBe(true);
    expect(guardian!.output!.length).toBeGreaterThan(2000);
    expect(guardian!.output).toContain(`Регистрация в МЧС: ОБЯЗАТЕЛЬНА, телефон ${PHONE}`);
    expect(guardian!.output).toContain('«Маршрут к Авачинскому 4»');
  });

  it('журнал совпадает с тем, что получила модель', async () => {
    const runs = await journalOfOneTurn();
    const toolMsg = (waterfall.mock.calls[1]![0] as Array<{ role: string; content: string }>).find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain(runs[0]!.output!);
  });

  it('живая сверка: опасность из маршрута за двухтысячной отметкой — опора есть, пометки «в сводках нет» нет', async () => {
    const runs = await journalOfOneTurn();
    const answer = 'На склоне Авачинского бывают лавины — без гида не ходи.';
    expect(guardSafetyClaims(answer, runs).verdict).toBe('backed');
    // Тот же ответ против обрезка в 2000 знаков — то, что было до 14.10.
    const cut = runs.map((r) => ({ ...r, output: r.output!.slice(0, 2000) }));
    expect(guardSafetyClaims(answer, cut).verdict).toBe('unbacked');
  });
});

describe('потолок по роду инструмента', () => {
  it('каталог туров по-прежнему режется до 2000, инструменты места и обстановки — нет', () => {
    const long = 'x'.repeat(30_000);
    expect(journalToolOutput('get_tours', long)).toHaveLength(2000);
    for (const name of ['get_guardian_context', 'get_place_info', 'safety_status', 'get_volcano_status', 'get_weather']) {
      expect(journalToolOutput(name, 'y'.repeat(9000)), name).toHaveLength(9000);
    }
  });

  it('у инструментов места тоже есть потолок: журнал не растёт без края', () => {
    expect(journalToolOutput('get_guardian_context', 'z'.repeat(50_000)).length).toBeLessThan(50_000);
  });
});

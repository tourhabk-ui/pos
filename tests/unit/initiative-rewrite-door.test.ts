/**
 * Исполнитель `ui_copy_change` (описание тура, переписанное моделью) пишет
 * только дверью правки — слово владельца 23.11: «Автоматы … пишут в туры
 * только через очередь проверки, своих обходных путей у них нет».
 *
 * До этого дня текст модели ложился в живую строку своим UPDATE и выходил
 * на сайт под именем оператора без проверки. Тест ИСПОЛНЯЕТ исполнителя на
 * записывающем пуле: ни одной записи тура мимо двери, исход каждого тура
 * назван своими словами. Саму дверь на схеме прода судит
 * tests/integration/tour-automaton.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sqls: [] as string[],
  tours: [] as Array<{ id: number; title: string; description: string | null; rating: string | null }>,
  model: vi.fn(async (): Promise<string | null> => null),
  door: vi.fn(async (_id: string, _text: string): Promise<string> => 'staged'),
  remember: vi.fn(async (_m: unknown) => undefined),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: async (sql: string) => {
      h.sqls.push(sql.replace(/\s+/g, ' ').trim());
      return { rows: h.tours, rowCount: h.tours.length };
    },
  },
}));
// Признаки заглушки — настоящие из providers: тест обязан сломаться, если их сменят.
vi.mock('@/lib/ai/providers', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/providers')>()),
  callAIWithModelDirect: h.model,
}));
vi.mock('@/lib/agents/memory/agent-memory', () => ({ agentMemory: { remember: h.remember } }));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => 'test-model' }));
vi.mock('@/lib/tours/describe-door', async (orig) => ({
  ...(await orig<typeof import('@/lib/tours/describe-door')>()),
  proposeRewrittenDescription: h.door,
}));

import { executeInitiativeEffect } from '@/lib/agents/execution/initiative-executor';
import { AI_FAST_UNAVAILABLE } from '@/lib/ai/providers';

const task = { approval_id: 'a', executor_agent_id: 'content', action_type: 'ui_copy_change', description: '', context: { limit: 3 }, due_date: '' };
const TEXT = 'Однодневный выезд к вулкану Горелый с подъёмом к кратеру.';

beforeEach(() => {
  h.sqls.length = 0;
  h.tours = [
    { id: 11, title: 'Вулкан Горелый', description: 'Коротко.', rating: null },
    { id: 12, title: 'Сплав по реке Быстрая', description: null, rating: '3.5' },
  ];
  h.model.mockReset();
  h.model.mockResolvedValue(`  ${TEXT}  `);
  h.door.mockReset();
  h.door.mockResolvedValue('staged');
  h.remember.mockReset();
});

describe('исполнитель описаний: текст модели — только дверью', () => {
  it('ни одной записи тура своим запросом; каждому туру — вызов двери с очищенным текстом', async () => {
    const r = await executeInitiativeEffect(task);
    expect(r.success).toBe(true);
    expect(r.errors).toEqual([]);
    // Журнал исполнения исполнитель пишет сам — это не тур. В таблицу туров — ни одной записи.
    expect(h.sqls.filter((s) => /\b(UPDATE|INSERT INTO|DELETE FROM)\s+operator_tours\b/i.test(s))).toEqual([]);
    expect(h.sqls.some((s) => /FROM operator_tours/.test(s))).toBe(true);
    expect(h.door.mock.calls).toEqual([['11', TEXT], ['12', TEXT]]);
    // «Ждёт проверки» — не «обновлено».
    const told = r.changes_made.join('\n');
    expect(told).toContain('"Вулкан Горелый" — описание ждёт проверки администратора');
    expect(told).toContain('"Сплав по реке Быстрая" — описание ждёт проверки администратора');
    expect(told).not.toMatch(/описание обновлено/);
  });

  it('исход двери назван своими словами: записано, пропущено, тура нет', async () => {
    h.door.mockResolvedValueOnce('written').mockResolvedValueOnce('skipped_owner_pending');
    const r = await executeInitiativeEffect(task);
    const told = r.changes_made.join('\n');
    expect(told).toContain('"Вулкан Горелый" — описание записано (тура нет на сайте)');
    expect(told).toContain('"Сплав по реке Быстрая" — пропущен: владелец сам отправил описание на проверку');
  });

  it('модель не ответила или ответила обрывком — дверь не зовётся; отказ двери назван ошибкой тура', async () => {
    h.model.mockResolvedValueOnce(null).mockResolvedValueOnce('коротко');
    const none = await executeInitiativeEffect(task);
    expect(h.door).not.toHaveBeenCalled();
    expect(none.changes_made.join('\n')).not.toMatch(/ждёт проверки/);

    h.model.mockResolvedValue(TEXT);
    h.door.mockRejectedValueOnce(new Error('нет связи с базой')).mockResolvedValueOnce('staged');
    const half = await executeInitiativeEffect(task);
    expect(half.errors.join('\n')).toContain('"Вулкан Горелый": нет связи с базой');
    expect(half.changes_made.join('\n')).toContain('"Сплав по реке Быстрая" — описание ждёт проверки администратора');
  });
});

describe('заглушка водопада — не текст модели (разбор находок #1428)', () => {
  // Отказ всех провайдеров приходит строкой. Она длиннее 20 знаков и раньше
  // уходила в очередь проверки как описание тура.
  const STUBS = [
    'Извините, сервис временно недоступен. Попробуйте позже.',
    'Сервис временно недоступен. Повторите запрос позже.',
    AI_FAST_UNAVAILABLE,
  ];

  it.each(STUBS)('описание тура: «%s» — дверь не зовётся, у каждого тура ошибка «модель недоступна»', async (stub) => {
    h.model.mockResolvedValue(stub);
    const r = await executeInitiativeEffect(task);
    expect(h.door).not.toHaveBeenCalled();
    expect(r.errors).toEqual(['"Вулкан Горелый": модель недоступна', '"Сплав по реке Быстрая": модель недоступна']);
    expect(r.success).toBe(false);
    expect(r.changes_made.join('\n')).not.toMatch(/ждёт проверки|записано/);
  });

  it('заглушка у одного тура не мешает другому', async () => {
    h.model.mockResolvedValueOnce(AI_FAST_UNAVAILABLE).mockResolvedValueOnce(TEXT);
    const r = await executeInitiativeEffect(task);
    expect(h.door.mock.calls).toEqual([['12', TEXT]]);
    expect(r.errors).toEqual(['"Вулкан Горелый": модель недоступна']);
  });

  it('оптимизация промптов: заглушка не ложится в память агента', async () => {
    h.model.mockResolvedValue(AI_FAST_UNAVAILABLE);
    const r = await executeInitiativeEffect({ ...task, action_type: 'prompt_optimize', executor_agent_id: 'evo' });
    expect(h.remember).not.toHaveBeenCalled();
    expect(r.errors).toEqual(['модель недоступна']);
    expect(r.success).toBe(false);
  });

  it('оптимизация промптов: настоящий ответ модели ложится в память', async () => {
    h.model.mockResolvedValue('[{"agent":"kuzmich","issue":"долго","fix":"кэш"}]');
    const r = await executeInitiativeEffect({ ...task, action_type: 'prompt_optimize', executor_agent_id: 'evo' });
    expect(h.remember).toHaveBeenCalledTimes(1);
    expect(r.errors).toEqual([]);
  });
});

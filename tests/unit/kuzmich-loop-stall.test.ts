/**
 * Застревания цикла Кузьмича (01.11): признаки считает сам цикл, замер ответа
 * их пишет, линза эволюции превращает частое застревание в находку.
 *
 * Повод — предложение «супервизора ролей»: модель читает сессии и сама
 * дописывает роли в промпт Кузьмича. Взята только детерминированная часть —
 * признаки застревания. Сторож держит связку целиком: настоящий цикл
 * (aiChatAgentLoop) с подложенной моделью → признаки → поля замера → находка.
 * И то, чего здесь быть не должно: в промпт линза не пишет ничего, текстов
 * реплик в замере нет.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { tools, fallback, fast, query } = vi.hoisted(() => ({
  tools: vi.fn(),
  fallback: vi.fn(),
  fast: vi.fn(),
  query: vi.fn(),
}));
vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...orig,
    callToolsWaterfall: (...a: unknown[]) => tools(...a),
    callAIWaterfallDetailed: (...a: unknown[]) => fallback(...a),
    callAIFast: (...a: unknown[]) => fast(...a),
  };
});
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
vi.mock('@/lib/services/safety/zone-weather', () => ({ getZoneWeatherForText: vi.fn().mockResolvedValue('') }));

import { aiChatAgentLoop } from '@/lib/kuzmich/core';
import { newLoopTiming } from '@/lib/kuzmich/answer-ceiling';
import { recordKuzmichAnswer } from '@/lib/kuzmich/answer-timing';
import { runTurnTools, type ToolRunOutcome } from '@/lib/kuzmich/tool-loop';
import { TOOL_EXECUTION_FAILED } from '@/lib/kuzmich/tool-failure';
import {
  newLoopStall, tallyTurnStall, answerStall, stallMetadata, STALL_TOOLS_MAX,
} from '@/lib/kuzmich/loop-stall';
import {
  pickStallFindings, STALL_MIN_SAMPLE, STALL_SIGNALS, type StallGroupRow,
} from '@/lib/agents/evo/kuzmich-stall-lens';

const avacha = {
  id: '9b1f0c2e-0000-4000-8000-000000000002', is_visible: true, name: 'Вулкан Авачинский',
  location_type: 'volcano', lat: 53.25537, lng: 158.83621, recommender_status: 'green',
  description: 'Авачинский вулкан.', hazard_types: ['камнепад'], profile_source: 'type_template',
  altitude_m: 2741, nearest_medical_km: null,
};

const call = (id: string, name: string, args: string) => ({
  content: null, provider: 'test',
  tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
});
const GUARDIAN_ARGS = JSON.stringify({ place: 'Авачинский вулкан' });
const ASK = 'Опасно ли подниматься на Авачинский вулкан?';

beforeEach(() => {
  tools.mockReset();
  fallback.mockReset();
  fast.mockReset();
  query.mockReset();
  query.mockImplementation((sql: string) => {
    if (typeof sql === 'string' && sql.includes('FROM places')) return Promise.resolve({ rows: [avacha] });
    return Promise.resolve({ rows: [] });
  });
  fast.mockResolvedValue('нет');
  fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback' });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('цикл считает признаки застревания', () => {
  it('модель четыре хода зовёт одно и то же — три повтора, ходы кончились, ответа нет', async () => {
    for (let i = 0; i < 4; i++) tools.mockResolvedValueOnce(call(`c${i}`, 'get_guardian_context', GUARDIAN_ARGS));
    const timing = newLoopTiming();
    const answer = await aiChatAgentLoop(ASK, 'система', [], [], [], undefined, timing);

    expect(tools).toHaveBeenCalledTimes(4);
    expect(answer).toBeNull();
    expect(timing.stall).toEqual({
      dupCalls: 3, invalidArgs: 0, toolFailures: 0, turnsExhausted: true, tools: ['get_guardian_context'],
    });
  });

  it('неверные аргументы, затем ответ — признак есть, ходы не кончились', async () => {
    tools
      .mockResolvedValueOnce(call('c1', 'compare_tours', '{}'))
      .mockResolvedValueOnce({ content: 'Сравнить не вышло, назовите туры.', provider: 'test' });
    const timing = newLoopTiming();
    const answer = await aiChatAgentLoop(ASK, 'система', [], [], [], undefined, timing);

    expect(answer).toBe('Сравнить не вышло, назовите туры.');
    expect(timing.stall).toEqual({
      dupCalls: 0, invalidArgs: 1, toolFailures: 0, turnsExhausted: false, tools: ['compare_tours'],
    });
  });

  it('обычный ответ после одного инструмента — признаков нет', async () => {
    tools
      .mockResolvedValueOnce(call('c1', 'get_guardian_context', GUARDIAN_ARGS))
      .mockResolvedValueOnce({ content: 'Авачинский спокоен.', provider: 'test' });
    const timing = newLoopTiming();
    await aiChatAgentLoop(ASK, 'система', [], [], [], undefined, timing);
    expect(timing.stall).toEqual(newLoopStall());
  });
});

describe('ход инструментов: кто не исполнен и почему', () => {
  it('повтор и отвергнутые аргументы помечены разными причинами', async () => {
    const seen = new Set<string>();
    const exec = vi.fn().mockResolvedValue('данные');
    const tc = (id: string, name: string, args: string) => ({ id, type: 'function' as const, function: { name, arguments: args } });
    const first = await runTurnTools([tc('a', 'get_weather', '{"zone":"x"}')], seen, exec);
    const second = await runTurnTools(
      [tc('b', 'get_weather', '{"zone":"x"}'), tc('c', 'bad', '{}')],
      seen, exec, (name) => (name === 'bad' ? { ok: false, error: 'плохо' } : { ok: true }),
    );
    expect(first[0]!.skipped).toBeUndefined();
    expect(second.map((o) => o.skipped)).toEqual(['duplicate', 'invalid_args']);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('упавший инструмент считается, имена без повторов и не больше предела', () => {
    const stall = newLoopStall();
    const o = (name: string, extra: Partial<ToolRunOutcome>): ToolRunOutcome =>
      ({ id: name, name, args: {}, content: 'данные', executed: true, ...extra });
    tallyTurnStall(stall, [
      o('t1', { content: TOOL_EXECUTION_FAILED }),
      o('t1', { executed: false, skipped: 'duplicate' }),
      o('t2', { content: 'Места нет в справочнике платформы.' }), // «нет данных» — не отказ
      ...['t3', 't4', 't5', 't6', 't7'].map((n) => o(n, { executed: false, skipped: 'invalid_args' })),
    ]);
    expect(stall).toMatchObject({ dupCalls: 1, invalidArgs: 5, toolFailures: 1, turnsExhausted: false });
    expect(stall.tools).toEqual(['t1', 't3', 't4', 't5', 't6']);
    expect(stall.tools).toHaveLength(STALL_TOOLS_MAX);
  });
});

describe('замер ответа', () => {
  it('цикл не ходил — признаков нет вовсе, а не нули', () => {
    expect(answerStall(newLoopTiming())).toBeNull();
    expect(stallMetadata(null)).toEqual({});
  });

  it('признаки уходят в metadata числами и именами инструментов, без текста реплик', async () => {
    const stall = { ...newLoopStall(), dupCalls: 2, turnsExhausted: true, tools: ['get_weather'] };
    await recordKuzmichAnswer({
      surface: 'max', elapsedMs: 1200, turns: 4, toolRounds: 4, path: 'waterfall',
      provider: 'test', ceilingHit: false, stall,
    });
    const meta = JSON.parse(String(query.mock.calls.at(-1)![1][2])) as Record<string, unknown>;
    expect(meta).toMatchObject({
      stall_dup_calls: 2, stall_invalid_args: 0, stall_tool_failures: 0,
      stall_turns_exhausted: true, stall_tools: ['get_weather'],
    });
  });

  it('без признаков замер прежний: ключей застревания нет', async () => {
    await recordKuzmichAnswer({
      surface: 'widget', elapsedMs: 900, turns: 0, toolRounds: 0, path: 'single', provider: null, ceilingHit: false,
    });
    const meta = JSON.parse(String(query.mock.calls.at(-1)![1][2])) as Record<string, unknown>;
    expect(Object.keys(meta).some((k) => k.startsWith('stall_'))).toBe(false);
  });
});

describe('линза эволюции: доля застреваний → находка', () => {
  const group = (over: Partial<StallGroupRow>): StallGroupRow => ({
    surface: 'max', provider: 'deepseek', measured: 100,
    turns_exhausted: 0, with_dup_calls: 0, with_invalid_args: 0, with_tool_failures: 0, ...over,
  });

  it('ниже порога и малая выборка — находок нет', () => {
    expect(pickStallFindings([group({ turns_exhausted: 4 })], [])).toEqual([]);
    expect(pickStallFindings([group({ measured: STALL_MIN_SAMPLE - 1, turns_exhausted: STALL_MIN_SAMPLE - 1 })], [])).toEqual([]);
  });

  it('одна находка на признак: худшая группа первой, числа, порог и инструменты названы', () => {
    const findings = pickStallFindings(
      [
        group({ surface: 'web', provider: 'xai', measured: 40, turns_exhausted: 4 }),
        group({ surface: 'max', provider: 'deepseek', measured: 50, turns_exhausted: 10 }),
      ],
      [{ tool: 'get_tour_availability', answers: 9 }],
    );
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f).toMatchObject({ category: 'bug', severity: 'high', model: 'deterministic', status: 'suggested' });
    expect(f.title).toBe(STALL_SIGNALS[0]!.title);
    expect(f.description.indexOf('max / deepseek: 10 из 50 (20%)'))
      .toBeLessThan(f.description.indexOf('web / xai: 4 из 40 (10%)'));
    expect(f.description).toContain('порога 5%');
    expect(f.description).toContain('get_tour_availability 9');
    expect(f.file_path).toBeUndefined();
  });

  it('каждый признак судится своим порогом и даёт свою находку', () => {
    const findings = pickStallFindings([group({
      turns_exhausted: 5, with_tool_failures: 5, with_dup_calls: 15, with_invalid_args: 10,
    })], []);
    expect(findings.map((f) => f.title)).toEqual(STALL_SIGNALS.map((s) => s.title));
    expect(findings.every((f) => f.description.includes('Имена инструментов в замерах не записаны'))).toBe(true);
  });
});

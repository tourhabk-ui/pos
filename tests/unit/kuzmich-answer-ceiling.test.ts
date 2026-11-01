/**
 * Потолок ожидания ответа Кузьмича и замер времени (аудит 15.10, A19, п. 1.13).
 *
 * У цикла инструментов не было общего дедлайна: ходов до четырёх, у каждой
 * ноги водопада свой таймаут, худший ответ оценивался в 100–150 с — оценкой,
 * потому что время ответа не записывалось нигде. Теперь:
 *  - после KUZMICH_ANSWER_CEILING_MS цикл не начинает новый ход модели или
 *    инструмента, а отдаёт собранное с честной строкой; запасной водопад
 *    вызывающего после потолка тоже не начинается;
 *  - блок 112 при признаках ЧП приходит и с ответом, собранным на потолке;
 *  - каждый ответ пишет elapsed_ms и turns в ai_actions_log (kuzmich_answer).
 *
 * Сторож — вызов настоящего aiChatAgentLoop и processMessage с подменёнными
 * часами (Date.now), моделью и базой. Роуты — kuzmich-answer-timing-routes и
 * kuzmich-answer-timing-bots.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { tools, fallback, fast, query, clock } = vi.hoisted(() => ({
  tools: vi.fn(),
  fallback: vi.fn(),
  fast: vi.fn(),
  query: vi.fn(),
  clock: { now: 1_800_000_000_000 },
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
vi.mock('@/lib/ai/route-knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/route-knowledge')>()),
  searchRoutes: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/services/ingest/legislation-importer', () => ({ searchLegislation: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/telegram/operator-availability', () => ({ searchOperatorAvailability: vi.fn().mockResolvedValue('') }));
// Контроль выхода — не предмет этого сторожа: сообщение до него не доходит.
vi.mock('@/lib/kuzmich/watch-flow', () => ({
  handleWatchMessage: vi.fn().mockResolvedValue(false),
  deleteWatchDraft: vi.fn().mockResolvedValue(undefined),
  telegramWatchRedirect: () => null,
}));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>();
  return { ...orig, gradeKuzmichResponse: vi.fn().mockResolvedValue(undefined) };
});

import { aiChatAgentLoop, processMessage } from '@/lib/kuzmich/core';
import {
  KUZMICH_ANSWER_CEILING_MS, CEILING_HONEST_LINE, CEILING_NOTHING_LINE, CEILING_WEB_LABEL,
  KUZMICH_ANSWER_ACTION, composeCeilingAnswer, newLoopTiming,
} from '@/lib/kuzmich/answer-ceiling';
import { RECORD_KUZMICH_ANSWER_SQL } from '@/lib/kuzmich/answer-timing';
import { buildSosBlock, detectEmergency } from '@/lib/safety/sos-detector';

const CEILING = KUZMICH_ANSWER_CEILING_MS;

const avacha = {
  id: '9b1f0c2e-0000-4000-8000-000000000002', is_visible: true, name: 'Вулкан Авачинский',
  location_type: 'volcano', lat: 53.25537, lng: 158.83621, recommender_status: 'green',
  description: 'Авачинский вулкан — один из самых доступных вулканов Камчатки.',
  hazard_types: ['камнепад'], profile_source: 'type_template', altitude_m: 2741, nearest_medical_km: null,
};

/** База: место для инструмента обстановки, остальное — пусто. */
function db() {
  query.mockImplementation((sql: string) => {
    if (typeof sql === 'string' && sql.includes('FROM places')) return Promise.resolve({ rows: [avacha] });
    return Promise.resolve({ rows: [] });
  });
}

const GUARDIAN_CALL = {
  content: null, provider: 'test',
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_guardian_context', arguments: JSON.stringify({ place: 'Авачинский вулкан' }) } }],
};

/** Ход модели, который «длится» ms по подменённым часам. */
function turn(ms: number, result: unknown) {
  return async () => { clock.now += ms; return result; };
}

const ASK = 'Опасно ли подниматься на Авачинский вулкан?';

beforeEach(() => {
  tools.mockReset();
  fallback.mockReset();
  fast.mockReset();
  query.mockReset();
  db();
  fast.mockResolvedValue('нет');
  fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback' });
  clock.now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('ответ из собранного (composeCeilingAnswer)', () => {
  it('ничего не собрано — честное «не успел» без «вот что известно»', () => {
    expect(composeCeilingAnswer([])).toBe(CEILING_NOTHING_LINE);
    expect(CEILING_NOTHING_LINE).toContain('112');
  });

  it('собрано — честная строка первой, затем выводы по порядку; повтор не дублируется', () => {
    const a = composeCeilingAnswer([
      { name: 'get_guardian_context', content: 'Вулкан Авачинский [ЗЕЛЁНЫЙ]. Камнепад.' },
      { name: 'get_weather', content: 'Ветер 12 м/с.' },
      { name: 'get_weather', content: 'Ветер 12 м/с.' },
    ]);
    expect(a.startsWith(CEILING_HONEST_LINE)).toBe(true);
    expect(a.indexOf('Вулкан Авачинский')).toBeLessThan(a.indexOf('Ветер 12'));
    expect(a.split('Ветер 12 м/с.').length - 1).toBe(1);
  });

  it('веб-поиск подписан как непроверенный, данные платформы — без подписи', () => {
    const a = composeCeilingAnswer([
      { name: 'search_kamchatka', content: 'Сниппет с сайта турагентства.' },
      { name: 'get_guardian_context', content: 'Сводка места.' },
    ]);
    expect(a).toContain(`${CEILING_WEB_LABEL}\nСниппет с сайта турагентства.`);
    expect(a).not.toContain(`${CEILING_WEB_LABEL}\nСводка места.`);
  });

  it('длинные выводы режутся: ответ не растёт без края (сообщение Telegram — 4096)', () => {
    const a = composeCeilingAnswer([
      { name: 'get_guardian_context', content: 'а'.repeat(9000) },
      { name: 'get_place_info', content: 'б'.repeat(9000) },
      { name: 'get_weather', content: 'в'.repeat(9000) },
    ]);
    expect(a.length).toBeLessThan(4096);
    expect(a).toContain('…');
  });
});

describe('цикл: после потолка новый ход не начинается', () => {
  it('первый ход модели длился дольше потолка — инструменты хода не исполняются, второго хода нет', async () => {
    tools.mockImplementationOnce(turn(CEILING + 1_000, GUARDIAN_CALL));
    const timing = newLoopTiming();
    const runs: Array<{ name: string }> = [];
    const answer = await aiChatAgentLoop(ASK, 'система', [], [], runs as never, undefined, timing);

    expect(tools).toHaveBeenCalledTimes(1);
    expect(runs).toEqual([]);
    expect(query.mock.calls.some((c) => String(c[0]).includes('FROM places'))).toBe(false);
    expect(answer).toBe(CEILING_NOTHING_LINE);
    expect(timing).toEqual({
      turns: 1, toolRounds: 0, elapsedMs: CEILING + 1_000, ceilingHit: true,
      // Подложенный ход usage не несёт — «не знаю», а не ноль (шаг 0 разбора 29.10).
      tokens: expect.objectContaining({ reportedCalls: 0, unreportedCalls: 1 }),
      // Потолок — не застревание: он считается своим полем, ceilingHit.
      stall: { dupCalls: 0, invalidArgs: 0, toolFailures: 0, turnsExhausted: false, tools: [] },
    });
  });

  it('инструменты отработали, к следующему ходу потолок прошёл — ответ из того, что они принесли', async () => {
    tools.mockImplementationOnce(turn(20_000, GUARDIAN_CALL));
    // Инструмент «идёт» 45 с: к следующему ходу модели уже 65 с.
    query.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM places')) { clock.now += 45_000; return Promise.resolve({ rows: [avacha] }); }
      return Promise.resolve({ rows: [] });
    });
    const timing = newLoopTiming();
    const answer = await aiChatAgentLoop(ASK, 'система', [], [], [], undefined, timing);

    expect(tools).toHaveBeenCalledTimes(1);
    expect(answer!.startsWith(CEILING_HONEST_LINE)).toBe(true);
    expect(answer).toContain('Авачинский');
    expect(timing.turns).toBe(1);
    expect(timing.toolRounds).toBe(1);
    expect(timing.ceilingHit).toBe(true);
  });

  it('до потолка — как было: второй ход модели идёт, ответ модели возвращается', async () => {
    tools
      .mockImplementationOnce(turn(10_000, GUARDIAN_CALL))
      .mockImplementationOnce(turn(15_000, { content: 'Авачинский спокоен.', provider: 'test' }));
    const timing = newLoopTiming();
    const answer = await aiChatAgentLoop(ASK, 'система', [], [], [], undefined, timing);

    expect(tools).toHaveBeenCalledTimes(2);
    expect(answer).toBe('Авачинский спокоен.');
    expect(timing).toEqual({
      turns: 2, toolRounds: 1, elapsedMs: 25_000, ceilingHit: false,
      tokens: expect.objectContaining({ reportedCalls: 0, unreportedCalls: 2 }),
      stall: { dupCalls: 0, invalidArgs: 0, toolFailures: 0, turnsExhausted: false, tools: [] },
    });
  });

  it('готовый ответ, пришедший после потолка, отдаётся как есть: ждать уже нечего', async () => {
    tools.mockImplementationOnce(turn(CEILING + 5_000, { content: 'Готовый ответ модели.', provider: 'test' }));
    const timing = newLoopTiming();
    expect(await aiChatAgentLoop(ASK, 'система', [], [], [], undefined, timing)).toBe('Готовый ответ модели.');
    expect(timing.ceilingHit).toBe(false);
  });

  it('все ноги отказали после потолка — собранное, а не null (по null вызывающий начал бы новый ход)', async () => {
    tools
      .mockImplementationOnce(turn(10_000, GUARDIAN_CALL))
      .mockImplementationOnce(turn(CEILING, null));
    const answer = await aiChatAgentLoop(ASK, 'система', [], []);
    expect(answer!.startsWith(CEILING_HONEST_LINE)).toBe(true);
    expect(answer).toContain('Авачинский');
  });

  it('отказ до потолка — по-прежнему null: запасной путь вызывающего уместен', async () => {
    tools.mockImplementationOnce(turn(5_000, null));
    expect(await aiChatAgentLoop(ASK, 'система', [], [])).toBeNull();
  });

  it('исключение провайдера после потолка — собранное; до потолка — исключение наружу, как было', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tools.mockImplementationOnce(async () => { clock.now += CEILING + 1; throw new Error('сеть'); });
    expect(await aiChatAgentLoop(ASK, 'система', [], [])).toBe(CEILING_NOTHING_LINE);

    tools.mockImplementationOnce(async () => { clock.now += 1_000; throw new Error('сеть'); });
    await expect(aiChatAgentLoop(ASK, 'система', [], [])).rejects.toThrow('сеть');
  });
});

/** Строка замера, записанная в ai_actions_log. */
function recorded(): { provider: unknown; meta: Record<string, unknown> } {
  const call = query.mock.calls.find((c) => c[0] === RECORD_KUZMICH_ANSWER_SQL);
  expect(call, 'замер ответа не записан').toBeDefined();
  const params = call![1] as unknown[];
  expect(params[0]).toBe(KUZMICH_ANSWER_ACTION);
  return { provider: params[1], meta: JSON.parse(String(params[2])) as Record<string, unknown> };
}

describe('Telegram и MAX (processMessage → aiChat): потолок и замер', () => {
  const reply = vi.fn().mockResolvedValue(undefined);
  const base = { userName: 'Иван', mode: 'kuzmich', createdVia: 'test', reply };

  beforeEach(() => { reply.mockClear(); });

  for (const [platform, surface] of [['tg', 'telegram'], ['max', 'max']] as const) {
    it(`${surface}: на потолке запасной водопад не зовётся, человек получает честную строку, замер записан`, async () => {
      tools.mockImplementationOnce(turn(CEILING + 2_000, GUARDIAN_CALL));
      await processMessage({ ...base, chatId: 501, text: ASK, pending: new Map(), platform, verifiedOrigin: true });

      expect(tools).toHaveBeenCalledTimes(1);
      expect(fallback).not.toHaveBeenCalled();
      const sent = String(reply.mock.calls.at(-1)?.[1] ?? '');
      expect(sent).toContain(CEILING_NOTHING_LINE);

      const { meta } = recorded();
      expect(meta).toMatchObject({
        surface, turns: 1, tool_rounds: 0, path: 'tools', ceiling_hit: true, ceiling_ms: CEILING,
      });
      expect(meta.elapsed_ms).toBe(CEILING + 2_000);
    });

    it(`${surface}: обычный ответ — elapsed_ms и turns записаны, потолка нет`, async () => {
      tools
        .mockImplementationOnce(turn(4_000, GUARDIAN_CALL))
        .mockImplementationOnce(turn(3_000, { content: 'Авачинский спокоен, но бывает камнепад.', provider: 'deepseek' }));
      await processMessage({ ...base, chatId: 502, text: ASK, pending: new Map(), platform, verifiedOrigin: true });

      const { provider, meta } = recorded();
      expect(provider).toBe('deepseek');
      expect(meta).toMatchObject({ surface, elapsed_ms: 7_000, turns: 2, tool_rounds: 1, path: 'tools', ceiling_hit: false });
    });
  }

  it('при признаке ЧП блок 112 приходит и с ответом, собранным на потолке', async () => {
    const SOS_Q = 'Заблудились на Авачинском вулкане, туман, помогите';
    expect(detectEmergency(SOS_Q).detected).toBe(true);
    tools.mockImplementationOnce(turn(CEILING + 1, GUARDIAN_CALL));
    await processMessage({ ...base, chatId: 503, text: SOS_Q, pending: new Map(), platform: 'max', verifiedOrigin: true });

    const sent = String(reply.mock.calls.at(-1)?.[1] ?? '');
    expect(sent).toContain(buildSosBlock(detectEmergency(SOS_Q).categories));
    expect(sent).toContain(CEILING_NOTHING_LINE);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('отказ записи замера не роняет ответ человеку и называется в логе с SQLSTATE', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    query.mockImplementation((sql: string) => {
      if (sql === RECORD_KUZMICH_ANSWER_SQL) return Promise.reject(Object.assign(new Error('нет таблицы'), { code: '42P01' }));
      if (typeof sql === 'string' && sql.includes('FROM places')) return Promise.resolve({ rows: [avacha] });
      return Promise.resolve({ rows: [] });
    });
    tools.mockImplementationOnce(turn(1_000, { content: 'Ответ.', provider: 'test' }));
    await processMessage({ ...base, chatId: 504, text: ASK, pending: new Map(), platform: 'tg' });

    expect(reply).toHaveBeenCalled();
    await vi.waitFor(() => {
      const line = err.mock.calls.find((c) => String(c[0]).includes('[kuzmich-answer-timing]'));
      expect(line).toBeDefined();
      expect(JSON.stringify(line)).toContain('42P01');
    });
  });
});

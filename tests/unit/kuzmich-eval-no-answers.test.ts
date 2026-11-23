/**
 * Проверка Кузьмича, не получившая ни одного ответа, не зеленеет (#3494, 23.11).
 *
 * Прогон 23.11 задал 98 вопросов и не получил ни одного ответа: закрыт был
 * суточный стоп расходов на ИИ. Workflow при этом был зелёным, в логе не
 * осталось ни строки о причине, а тревога назвала бы её «судья недоступен».
 * Три дефекта:
 *  - вход проверки глушил отказ цикла (`.catch(() => null)`);
 *  - у всех вопросов без ответа была одна причина «waterfall недоступен»;
 *  - роут отвечал 200 на прогон, который ничего не измерил.
 *
 * Держится вызовом: прогонщик с подставным Кузьмичом, роут с подставным
 * прогонщиком и стопом, скрипт повтора с подставным curl.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import type { EvalCase, EvalReport } from '@/lib/agents/eval/kuzmich-faithfulness';

const m = vi.hoisted(() => ({
  run: vi.fn(),
  log: vi.fn(),
  stopped: vi.fn(),
  lease: vi.fn(),
  tg: vi.fn(),
  real: { current: true },
}));

vi.mock('@/lib/agents/eval/kuzmich-faithfulness', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/agents/eval/kuzmich-faithfulness')>();
  return {
    ...orig,
    // Роуту — подставной прогон; самому прогонщику в тестах ниже — настоящий.
    runKuzmichFaithfulnessEval: (...a: Parameters<typeof orig.runKuzmichFaithfulnessEval>) =>
      (m.real.current ? orig.runKuzmichFaithfulnessEval(...a) : m.run(...a)),
  };
});
vi.mock('@/lib/ai/daily-spend-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/daily-spend-gate')>()),
  isDailyLlmBudgetStopped: () => m.stopped(),
}));
vi.mock('@/lib/agents/run-logger', () => ({ logAgentRun: (...a: unknown[]) => m.log(...a) }));
vi.mock('@/lib/ai/usage-context', () => ({
  runWithUsageTracking: async (_agent: string, fn: () => Promise<unknown>) => ({ result: await fn() }),
}));
vi.mock('@/lib/agents/cron-lease', () => ({ claimCronWindow: (...a: unknown[]) => m.lease(...a) }));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (...a: unknown[]) => m.tg(...a) }));

import {
  runKuzmichFaithfulnessEval, noAnswerOutcome, decideAlert, summarizeFaithfulness,
} from '@/lib/agents/eval/kuzmich-faithfulness';
import { DailyBudgetStopped } from '@/lib/ai/daily-spend-gate';
import { GET } from '@/app/api/cron/kuzmich-eval/route';
import { runGatewayRetry, shouldRetryGateway } from '../../scripts/cron-gateway-retry.mjs';
import { SKIP_REASON_LABELS } from '@/lib/agents/scout-skip-reasons';

const Q = [
  { id: 'q1', category: 'safety' as const, question: 'Можно ли сегодня на Авачинский?' },
  { id: 'q2', category: 'route' as const, question: 'Сколько идти до Медвежьей площадки?' },
  { id: 'q3', category: 'season' as const, question: 'Когда лучше на Мутновский?' },
];

const judge = vi.fn(async () => ({ score: 5, reason: 'по контексту' }));

beforeEach(() => {
  m.real.current = true;
  m.run.mockReset();
  m.log.mockReset();
  m.stopped.mockReset().mockResolvedValue(false);
  m.lease.mockReset().mockResolvedValue('claimed');
  m.tg.mockReset().mockResolvedValue({ ok: true });
  judge.mockClear();
  process.env.CRON_SECRET = 'test-secret';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('прогонщик называет, почему вопрос остался без ответа', () => {
  it('стоп расходов закрыт — у каждого вопроса причина «стоп», судья не зовётся', async () => {
    const report = await runKuzmichFaithfulnessEval({
      questions: Q,
      deps: { ask: async () => { throw new DailyBudgetStopped(); }, judge },
    });
    expect(report.cases.map((c) => c.no_answer)).toEqual(['daily_budget_stopped', 'daily_budget_stopped', 'daily_budget_stopped']);
    for (const c of report.cases) expect(c.reason).toMatch(/суточный стоп расходов/);
    expect(judge).not.toHaveBeenCalled();
    expect(noAnswerOutcome(report.cases)?.skip_reason).toBe('daily_budget_stopped');
  });

  it('ошибка цикла и пустой ответ — разные причины, и ошибка попадает в лог', async () => {
    const report = await runKuzmichFaithfulnessEval({
      questions: Q,
      deps: {
        ask: async (q) => {
          if (q.includes('Авачинский')) throw new Error('все ноги отказали');
          return null;
        },
        judge,
      },
    });
    expect(report.cases.map((c) => c.no_answer)).toEqual(['error', 'empty', 'empty']);
    expect(report.cases[0].reason).toMatch(/упал с ошибкой/);
    expect(report.cases[1].reason).toMatch(/пустой ответ/);
    expect(console.error).toHaveBeenCalledWith('[kuzmich-eval] вопрос не отработал',
      expect.objectContaining({ id: 'q1', cause: 'error', message: 'все ноги отказали' }));
    const silent = noAnswerOutcome(report.cases);
    expect(silent?.skip_reason).toBe('no_answers');
    expect(silent?.text).toMatch(/error — 1, empty — 2/);
  });

  it('текст ошибки уходит в лог без телефона и почты туриста', async () => {
    await runKuzmichFaithfulnessEval({
      questions: [Q[0]],
      deps: { ask: async () => { throw new Error('провайдер вернул вход: +7 914 000-00-00, test@example.com'); }, judge },
    });
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(logged).not.toMatch(/914 000-00-00/);
    expect(logged).not.toMatch(/test@example\.com/);
  });

  it('хоть один ответ — прогон что-то измерил', async () => {
    const report = await runKuzmichFaithfulnessEval({
      questions: Q,
      deps: {
        ask: async (q) => (q.includes('Мутновский') ? { answer: 'В июле-августе', context: 'сезон' } : null),
        judge,
      },
    });
    expect(noAnswerOutcome(report.cases)).toBeNull();
    expect(report.cases[2].no_answer).toBeUndefined();
  });

  it('стоп у части вопросов и ошибка у остальных — общий код, а не самый удобный', () => {
    const cases: EvalCase[] = [
      { id: 'a', category: 'safety', question: 'a', answer: null, context_len: 0, score: null, reason: 'x', no_answer: 'daily_budget_stopped' },
      { id: 'b', category: 'safety', question: 'b', answer: null, context_len: 0, score: null, reason: 'x', no_answer: 'error' },
    ];
    expect(noAnswerOutcome(cases)?.skip_reason).toBe('no_answers');
  });

  it('пустой прогон — не «ни одного ответа»: спрашивать было нечего', () => {
    expect(noAnswerOutcome([])).toBeNull();
  });
});

describe('тревога называет настоящую причину', () => {
  it('ни одного ответа — не «судья недоступен»', async () => {
    const report = await runKuzmichFaithfulnessEval({
      questions: Q,
      deps: { ask: async () => { throw new DailyBudgetStopped(); }, judge },
    });
    const alert = decideAlert(summarizeFaithfulness(report.cases));
    expect(alert).toMatch(/Кузьмич не ответил ни на один вопрос/);
    expect(alert).toMatch(/суточный стоп расходов/);
    expect(alert).not.toMatch(/судья недоступен/);
    expect(m.tg).toHaveBeenCalledWith('kuzmich-eval', alert);
  });
});

describe('вход проверки не глушит отказ цикла', () => {
  it('у вызова цикла в askKuzmichForEval нет .catch', () => {
    const core = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf8');
    const fn = core.slice(core.indexOf('export async function askKuzmichForEval'));
    const call = fn.slice(fn.indexOf('aiChatAgentLoop('), fn.indexOf('if (!raw?.trim())'));
    expect(call.length).toBeGreaterThan(0);
    expect(call).not.toMatch(/\.catch\(/);
  });
});

const REPORT_OK: EvalReport = {
  asked: 1, judged: 1, pass_rate: 1, wilson_low: 0.2, wilson_high: 1, judge_unavailable_ratio: 0,
  alerts_sent: false, commercial: null,
  cases: [{ id: 'q1', category: 'safety', question: 'q', answer: 'a', context_len: 10, score: 5, reason: 'ok' }],
};
const silentReport = (cause: EvalCase['no_answer']): EvalReport => ({
  asked: 2, judged: 0, pass_rate: 0, wilson_low: 0, wilson_high: 0, judge_unavailable_ratio: 1,
  alerts_sent: true, commercial: null,
  cases: ['q1', 'q2'].map((id) => ({ id, category: 'safety', question: id, answer: null, context_len: 0, score: null, reason: 'нет ответа', no_answer: cause })),
});

const call = (query = '') => GET(new NextRequest(`http://localhost/api/cron/kuzmich-eval${query}`, {
  headers: { authorization: 'Bearer test-secret' },
}));

describe('роут: прогон, который ничего не измерил, — не 200', () => {
  beforeEach(() => { m.real.current = false; });

  it('стоп закрыт до прогона — вопросов нет, окно расхода не занято, причина в журнале', async () => {
    m.stopped.mockResolvedValue(true);
    const res = await call();
    expect(res.status).toBe(424);
    expect(await res.json()).toMatchObject({ ok: false, skip_reason: 'daily_budget_stopped' });
    expect(m.run).not.toHaveBeenCalled();
    expect(m.lease).not.toHaveBeenCalled();
    expect(m.log).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: 'kuzmich-eval', status: 'partial', metadata: expect.objectContaining({ skip_reason: 'daily_budget_stopped' }),
    }));
  });

  it('force стоп не обходит', async () => {
    m.stopped.mockResolvedValue(true);
    const res = await call('?force=1');
    expect(res.status).toBe(424);
    expect(m.run).not.toHaveBeenCalled();
  });

  it('ни одного ответа из-за ошибок — 424 и failed', async () => {
    m.run.mockResolvedValue(silentReport('error'));
    const res = await call();
    expect(res.status).toBe(424);
    const body = await res.json() as { ok: boolean; skip_reason: string; note: string };
    expect(body).toMatchObject({ ok: false, skip_reason: 'no_answers' });
    expect(body.note).toMatch(/ни на один из 2 вопросов/);
    expect(m.log).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', metadata: expect.objectContaining({ skip_reason: 'no_answers' }),
    }));
  });

  it('стоп закрылся посреди прогона — 424 и partial', async () => {
    m.run.mockResolvedValue(silentReport('daily_budget_stopped'));
    const res = await call();
    expect(res.status).toBe(424);
    expect(m.log).toHaveBeenCalledWith(expect.objectContaining({
      status: 'partial', metadata: expect.objectContaining({ skip_reason: 'daily_budget_stopped' }),
    }));
  });

  it('набор о турах без ответов — тоже 424, своя сводка критериев не перекрывает', async () => {
    m.run.mockResolvedValue(silentReport('error'));
    const res = await call('?set=commercial');
    expect(res.status).toBe(424);
    expect(m.log).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: 'kuzmich-eval-commercial', status: 'failed',
    }));
  });

  it('причина в начале тела: скрипт повтора печатает первые 300 знаков', async () => {
    m.run.mockResolvedValue(silentReport('error'));
    const text = await (await call()).text();
    expect(text.slice(0, 300)).toMatch(/"skip_reason":"no_answers"/);
  });

  it('обычный прогон — 200, как раньше', async () => {
    m.run.mockResolvedValue(REPORT_OK);
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe('шаг workflow краснеет и не зовёт роут второй раз', () => {
  it('424 — не шлюз: повтора нет, исход 1', () => {
    expect(shouldRetryGateway({ status: 424, elapsedSec: 5, attempt: 1, attempts: 2, fastOnlySec: 300 })).toBe(false);
    const curl = vi.fn(() => ({ status: 424, body: '{"ok":false,"skip_reason":"daily_budget_stopped"}', elapsedSec: 1, curlError: '' }));
    const wait = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = runGatewayRetry({ url: 'https://example.test/api/cron/kuzmich-eval', out: '/dev/null', attempts: 2, pauses: [120], fastOnlySec: 300, maxTime: 540, method: 'GET', data: null }, curl, wait);
    expect(code).toBe(1);
    expect(curl).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toMatch(/daily_budget_stopped/);
  });
});

describe('коды причин названы словами', () => {
  it('оба новых кода есть в словаре тревог', () => {
    expect(SKIP_REASON_LABELS.daily_budget_stopped).toMatch(/стоп расходов/);
    expect(SKIP_REASON_LABELS.no_answers).toMatch(/ни на один вопрос/);
  });
});

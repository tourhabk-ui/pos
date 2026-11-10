/**
 * Живые вопросы туристов не попадают в открытый лог (находка разбора #3110, 10.11).
 *
 * Еженедельная проверка Кузьмича берёт сообщения из chat_sessions и гоняет их
 * через судью. Шаг workflow печатал ответ роута целиком — с вопросами,
 * ответами Кузьмича и разбором судьи. Репозиторий публичный: лог прогона
 * GitHub Actions открыт любому. Маска на сервере закрывает телефон, почту и
 * ник; имя и всё остальное, что человек написал о себе, она оставляет.
 *
 * Держит обе стороны: роут текстов живых вопросов не отдаёт, а шаг workflow
 * не печатает тело ответа целиком — возврат текстов в роут не вернёт их в лог.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { NextRequest } from 'next/server';
import type { EvalCase, EvalReport } from '@/lib/agents/eval/kuzmich-faithfulness';

const m = vi.hoisted(() => ({ run: vi.fn(), sample: vi.fn(), log: vi.fn() }));
vi.mock('@/lib/agents/eval/kuzmich-faithfulness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/eval/kuzmich-faithfulness')>()),
  runKuzmichFaithfulnessEval: (...a: unknown[]) => m.run(...a),
}));
vi.mock('@/lib/agents/eval/live-questions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/eval/live-questions')>()),
  sampleLiveQuestions: (...a: unknown[]) => m.sample(...a),
}));
vi.mock('@/lib/agents/run-logger', () => ({ logAgentRun: (...a: unknown[]) => m.log(...a) }));
vi.mock('@/lib/ai/usage-context', () => ({
  runWithUsageTracking: async (_agent: string, fn: () => Promise<unknown>) => ({ result: await fn() }),
}));
vi.mock('@/lib/agents/cron-lease', () => ({ claimCronWindow: async () => 'claimed' }));

import { GET } from '@/app/api/cron/kuzmich-eval/route';
import { liveCaseForResponse } from '@/lib/agents/eval/live-questions';

const QUESTION = 'Меня зовут Тест, мы остановились в гостинице у порта и завтра идём на Авачинский';
const ANSWER = 'Тест, на Авачинский завтра идти нельзя: маршрут закрыт';
const REASON = 'Ответ обращается к туристу по имени Тест и верно называет закрытие';

const CASES: EvalCase[] = [
  { id: 'live-1', category: 'live', question: QUESTION, answer: ANSWER, context_len: 30_583, score: 5, reason: REASON },
  { id: 'live-2', category: 'live', question: 'Второй вопрос туриста', answer: null, context_len: 0, score: null, reason: 'нет ответа' },
];
const REPORT: EvalReport = {
  asked: 2, judged: 1, pass_rate: 1, wilson_low: 0.2, wilson_high: 1, judge_unavailable_ratio: 0.5, alerts_sent: false, cases: CASES, commercial: null,
};

const call = (query: string) => GET(new NextRequest(`http://localhost/api/cron/kuzmich-eval${query}`, {
  headers: { authorization: 'Bearer test-secret' },
}));

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret';
  m.run.mockReset().mockResolvedValue(REPORT);
  m.sample.mockReset().mockResolvedValue([{ id: 'live-1', category: 'live', question: QUESTION }]);
  m.log.mockReset();
});

describe('ответ роута на живых вопросах', () => {
  it('числа есть, текстов вопроса, ответа и разбора судьи нет', async () => {
    const res = await call('?source=live');
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const leak of [QUESTION, ANSWER, REASON, 'Тест', 'гостиниц', 'Второй вопрос']) expect(text).not.toContain(leak);
    expect(JSON.parse(text)).toMatchObject({
      ok: true, source: 'live', asked: 2, judged: 1, pass_rate: 1,
      cases: [
        { id: 'live-1', category: 'live', score: 5, context_len: 30_583, answered: true },
        { id: 'live-2', category: 'live', score: null, context_len: 0, answered: false },
      ],
    });
    // Ни одного поля сверх чисел: новое поле проверки не уедет наружу само.
    expect(Object.keys(JSON.parse(text).cases[0]).sort()).toEqual(['answered', 'category', 'context_len', 'id', 'score']);
  });

  it('проваленный живой вопрос остаётся в журнале прогона — разбирать есть по чему', async () => {
    m.run.mockResolvedValue({ ...REPORT, pass_rate: 0, cases: [{ ...CASES[0], score: 2 }, CASES[1]] });
    await call('?source=live');
    const logged = m.log.mock.calls.at(-1)![0] as { agent_id: string; metadata: { failed_cases: Array<{ id: string }> } };
    expect(logged.agent_id).toBe('kuzmich-eval-live');
    expect(logged.metadata.failed_cases.map((c) => c.id)).toContain('live-1');
  });

  it('вопросы фикстуры написаны нами — уходят как были, с текстом и разбором', async () => {
    const res = await call('');
    const body = await res.json() as { cases: EvalCase[] };
    expect(body.cases[0]).toMatchObject({ question: QUESTION, answer: ANSWER, reason: REASON });
  });
});

describe('что из проверки отдаётся наружу', () => {
  it('только номер, род, оценка, длина контекста и «ответил ли»', () => {
    expect(liveCaseForResponse(CASES[0])).toEqual({ id: 'live-1', category: 'live', score: 5, context_len: 30_583, answered: true });
    expect(liveCaseForResponse(CASES[1])).toEqual({ id: 'live-2', category: 'live', score: null, context_len: 0, answered: false });
  });
});

describe('шаг workflow с живыми вопросами', () => {
  const workflow = load(readFileSync(join(process.cwd(), '.github/workflows/cron-kuzmich-eval.yml'), 'utf-8')) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const steps = Object.values(workflow.jobs).flatMap((j) => j.steps);
  const live = steps.filter((s) => (s.run ?? '').includes('source=live'));

  it('такой шаг один, и он зовёт роут', () => {
    expect(live).toHaveLength(1);
    expect(live[0].run).toContain('/api/cron/kuzmich-eval?source=live');
  });

  it('тело ответа целиком в лог не печатается; из проверок берутся только числа', () => {
    const run = live[0].run!;
    // Файл ответа читает только jq с явным перечнем полей.
    const readers = run.split('\n').filter((line) => line.includes('/tmp/live.json') && !line.includes('curl') && !line.includes('-o /tmp/live.json'));
    expect(readers.length).toBeGreaterThan(0);
    for (const line of readers) expect(line.trim(), line).toMatch(/^jq -c '/);
    expect(run).not.toMatch(/\b(cat|head|tail|less|more)\b[^\n]*live\.json/);
    // Целое слово: `answered` и `skip_reason` — числа и код, а не текст.
    for (const field of ['question', 'answer', 'reason']) expect(run, field).not.toMatch(new RegExp(`\\b${field}\\b`));
    expect(run).not.toMatch(/jq[^\n]*'\.'/);
  });

  it('отказ в логе виден: пропуск по окну и ошибка сервера печатаются, а не только код ответа', () => {
    // Роут отвечает тремя формами: отчёт, пропуск по окну расхода (429:
    // skipped и note) и падение (500: error). Перечень полей, знающий только
    // первую, показал бы на отказ строку из одних null.
    const summary = live[0].run!.split('\n').find((line) => line.includes("jq -c '{ok"));
    expect(summary).toBeDefined();
    const fields = summary!.match(/\{([^}]*)\}/)![1].split(',').map((f) => f.trim());
    for (const field of ['ok', 'asked', 'judged', 'pass_rate', 'judge_unavailable_ratio', 'skip_reason', 'skipped', 'note', 'error']) {
      expect(fields, field).toContain(field);
    }
  });
});

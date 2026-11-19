/**
 * GET /api/cron/kuzmich-quality-census — чем и каким путём отвечал Кузьмич
 * (владелец 13.10: «понять, почему Кузьмич периодически деградирует»).
 *
 * Происхождение ответа (provider, answer_path, prompt_fingerprint,
 * grounding) пишется с #1730 и до этой переписи не читалось никем. Сторож
 * держит: только чтение и только числа; окно — параметром; доля запасного
 * пути считается по записям, а «ноль записей» назван словами; отказ базы —
 * 502 с SQLSTATE, а не пустой свод; роут объявлен в реестрах.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { MANUAL_ENDPOINTS, DECLARED } from '@/lib/agents/cron-schedulers';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import { GET } from '@/app/api/cron/kuzmich-quality-census/route';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/kuzmich-quality-census/route.ts'), 'utf-8');
const CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const SECRET = 'test-cron-secret';
const req = (qs = '', auth = true) => new NextRequest(
  `https://vedarai.ru/api/cron/kuzmich-quality-census${qs}`,
  { headers: auth ? { authorization: `Bearer ${SECRET}` } : {} },
);

const TOTALS = [
  { answer_path: 'tools', provider: 'deepseek', outcomes: 6, refusals: 0, graded: 6, avg_score: 7.5, low_scores: 1, ungrounded: 0, prompts: 1 },
  { answer_path: 'waterfall', provider: 'groq', outcomes: 3, refusals: 0, graded: 3, avg_score: 3.7, low_scores: 3, ungrounded: 2, prompts: 1 },
  { answer_path: 'tools', provider: 'qwen', outcomes: 1, refusals: 1, graded: 0, avg_score: null, low_scores: 0, ungrounded: 0, prompts: 1 },
];

const ATTEMPTS = [
  { day: '2026-11-19', attempts: 12, saved: 2, good_not_saved: 7, judge_no_answer: 2, failed: 1, not_recorded: 0 },
  { day: '2026-11-12', attempts: 9, saved: 0, good_not_saved: 0, judge_no_answer: 0, failed: 0, not_recorded: 9 },
];

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  query.mockReset();
  query.mockImplementation((sql: string) => Promise.resolve({
    rows: /kuzmich_grade/.test(sql) ? ATTEMPTS
      : /AS day/.test(sql) ? [{ day: '2026-10-13', ...TOTALS[1] }] : TOTALS,
  }));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('kuzmich-quality-census', () => {
  it('без секрета — 401, в базу не ходит', async () => {
    const res = await GET(req('', false));
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('свод по путям и провайдерам, доля запасного пути, день по Камчатке', async () => {
    const res = await GET(req('?days=7'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.days).toBe(7);
    expect(json.outcomes_total).toBe(10);
    expect(json.waterfall_share).toBe(0.3);
    expect(json.empty_reason).toBeNull();
    expect(json.by_day[0]).toMatchObject({ day: '2026-10-13', answer_path: 'waterfall', provider: 'groq' });
    expect(json.caveats.join(' ')).toMatch(/стрим сайта и A2A/);
    // Окно — параметром с приведением, без склейки строк.
    for (const c of query.mock.calls) {
      expect(String(c[0])).toContain("created_at > NOW() - ($1::int * INTERVAL '1 day')");
      expect(c[1]).toEqual([7]);
    }
    expect(String(query.mock.calls[0]![0])).toContain("AT TIME ZONE 'Asia/Kamchatka'");
  });

  it('ноль записей и ноль попыток — «оценивать было нечего», доля не выдумывается', async () => {
    query.mockImplementation(() => Promise.resolve({ rows: [] }));
    const json = await (await GET(req())).json();
    expect(json.outcomes_total).toBe(0);
    expect(json.waterfall_share).toBeNull();
    expect(json.attempts_total).toBe(0);
    expect(json.empty_reason).toMatch(/ни одной записи оценки и ни одной попытки/);
  });

  it('попытки оценки по дням — из журнала места под оценку, с исходами (#3179)', async () => {
    const json = await (await GET(req('?days=14'))).json();
    expect(json.attempts_total).toBe(21);
    expect(json.attempts_by_day).toEqual(ATTEMPTS);
    expect(json.caveats.join(' ')).toMatch(/«не записан»/);
    const sql = String(query.mock.calls.find(([q]) => /kuzmich_grade/.test(String(q)))![0]);
    expect(sql).toMatch(/FROM ai_actions_log/);
    expect(sql).toMatch(/action_type = 'kuzmich_grade'/);
    expect(sql).toContain("AT TIME ZONE 'Asia/Kamchatka'");
  });

  it('записей нет, а попытки были — так и сказано, с числом попыток', async () => {
    query.mockImplementation((sql: string) => Promise.resolve({ rows: /kuzmich_grade/.test(sql) ? ATTEMPTS : [] }));
    const json = await (await GET(req())).json();
    expect(json.outcomes_total).toBe(0);
    expect(json.empty_reason).toBe('за окно ни одной записи оценки при 21 попытках: исходы попыток — в attempts_by_day');
  });

  it('отказ базы — 502 с SQLSTATE, не пустой свод', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(() => Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' })));
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, sqlstate: '42P01' });
    expect(err).toHaveBeenCalled();
  });

  it('только чтение и только числа: ни записи, ни текстов вопросов', () => {
    expect(CODE).not.toMatch(/INSERT|UPDATE|DELETE/);
    expect(CODE).not.toMatch(/compiled_truth|chat_id/);
    expect(CODE).toMatch(/type = 'outcome' AND agent_id = 'kuzmich'/);
  });

  it('исходы попыток в переписи — те же, что пишет оценщик', async () => {
    const { GRADE_RESULTS } = await import('@/lib/agents/managed/kuzmich-outcomes');
    const { ATTEMPTS_BY_DAY_SQL } = await import('@/app/api/cron/kuzmich-quality-census/route');
    // Каждый исход оценщика где-то считается; новый исход без столбца краснеет.
    for (const r of GRADE_RESULTS) expect(ATTEMPTS_BY_DAY_SQL, r).toContain(`'${r}'`);
  });

  it('объявлен ручной непишущей переписью', () => {
    const decl = MANUAL_ENDPOINTS['kuzmich-quality-census'];
    expect(decl, 'kuzmich-quality-census не объявлен в cron-schedulers').toBeTruthy();
    expect(decl!.kind).toBe('manual');
    expect(decl!.writes).toBe(false);
    expect(DECLARED['kuzmich-quality-census']).toBeTruthy();
  });
});

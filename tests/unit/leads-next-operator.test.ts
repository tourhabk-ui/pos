// @vitest-environment node
/**
 * Кому добивка отдаёт лид следующим — жребий дня компании (слово владельца
 * 12.11: «жребий дня»).
 *
 * До этого дня оба запроса крона `/api/cron/leads-followup` кончались
 * `LIMIT 1` без `ORDER BY`: следующим становился оператор, чью строку база
 * вернула первой. Клиент доставался не по правилу, а по устройству таблицы.
 *
 * Держит:
 *  - правило — тот же `companyLot`, что у витрин (правило 1в), своего жребия нет;
 *  - исход не зависит от порядка строк на входе — в этом отличие от первой
 *    строки базы;
 *  - в разные дни первым идёт разный оператор, и за длинный срок никто не
 *    обделён и никто не забирает всё;
 *  - крон (вызовом обработчика с подменённой базой) отдаёт лид победителю
 *    жребия, а не первой строке; ступень «по интересам» стоит раньше жребия;
 *  - в запросах кандидатов нет `LIMIT 1` — запрет, поэтому регуляркой.
 *
 * Запросы на настоящем PostgreSQL судит tests/integration/leads-followup.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
const alertMock = vi.fn();
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...a: unknown[]) => alertMock(...a) }));
vi.mock('@/lib/crm/events', () => ({ recordSourceEventQuietly: vi.fn(), statusChangeTitle: () => 'смена статуса' }));
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));

import { GET } from '@/app/api/cron/leads-followup/route';
import { pickNextOperator } from '@/lib/leads/next-operator';
import { companyLot, offerOrderDay } from '@/lib/tours/offer-order';
import { FOLLOWUP_LEADS_SQL } from '@/lib/leads/followup-scope';

const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
const ops = IDS.map((id, i) => ({ id, slug: `op-${i + 1}` }));

/** Победитель, посчитанный независимо: сортировка по билету жребия дня компании. */
const byLot = (day: string, list: ReadonlyArray<{ id: string }>) =>
  [...list].sort((a, b) => companyLot(day, a.id) - companyLot(day, b.id) || (a.id < b.id ? -1 : 1))[0]!;

/** Календарные дни подряд, 'YYYY-MM-DD'. */
function days(from: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < count; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

describe('pickNextOperator — жребий дня компании', () => {
  it('пустой список — null; один кандидат — он', () => {
    expect(pickNextOperator([], '2027-03-10')).toBeNull();
    expect(pickNextOperator([ops[2]!], '2027-03-10')).toBe(ops[2]);
  });

  it('победитель — наименьший билет companyLot, тот же жребий, что у витрин', () => {
    for (const day of days('2027-03-01', 30)) {
      expect(pickNextOperator(ops, day)?.id, day).toBe(byLot(day, ops).id);
    }
  });

  it('порядок строк на входе исхода не меняет — этим жребий и отличается от первой строки базы', () => {
    const day = '2027-03-10';
    const want = byLot(day, ops).id;
    const rotations = ops.map((_, i) => [...ops.slice(i), ...ops.slice(0, i)]);
    for (const list of [...rotations, [...ops].reverse()]) expect(pickNextOperator(list, day)?.id).toBe(want);
  });

  it('за 200 дней первым бывает каждый, и никто не забирает больше трети дней', () => {
    const wins = new Map<string, number>(ops.map((o) => [o.id, 0]));
    for (const day of days('2027-01-01', 200)) {
      const w = pickNextOperator(ops, day)!.id;
      wins.set(w, (wins.get(w) ?? 0) + 1);
    }
    // Честная доля у пятерых — 40 дней из 200. Границы широкие: это сторож
    // от «один и тот же изо дня в день», а не замер равномерности.
    for (const [id, n] of wins) {
      expect(n, id).toBeGreaterThanOrEqual(20);
      expect(n, id).toBeLessThanOrEqual(66);
    }
  });
});

// ── Крон: вызов обработчика ─────────────────────────────────────────────────

const LEAD = { id: 'l-plain', name: 'Анна Обычная', phone: '+79990000003', source_data: { interests: ['volcano'] }, pd_consent_version: '2026-09-01' };
const NO_INTERESTS = { ...LEAD, id: 'l-any', source_data: {} };
const reach = (o: { id: string; slug: string }, chat: string) => ({ ...o, name: o.slug, telegram_chat_id: null, user_telegram_id: null, max_chat_id: chat });
const A = reach(ops[0]!, '501');
const B = reach(ops[1]!, '502');
const C = reach(ops[2]!, '503');

const savedSecret = process.env.CRON_SECRET;
let partnerQueries: string[] = [];

/** База: лиды, счётчик диагностики, и кандидаты по ступеням — в заданном порядке строк. */
function db(leads: unknown[], byInterests: unknown[], anyOperator: unknown[]) {
  partnerQueries = [];
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (sql === FOLLOWUP_LEADS_SQL) return { rows: leads };
    // Крон перед передачей сверяет, что заявку не отменил клиент (1427): заявка жива.
    if (/SELECT TRUE AS ok FROM leads/.test(sql)) return { rows: [{ ok: true }] };
    if (/COUNT\(\*\) AS total/.test(sql)) return { rows: [{ total: '3', with_telegram: '0', with_max: '3' }] };
    if (/FROM partners p/.test(sql)) {
      partnerQueries.push(sql);
      return { rows: /ot\.activity_type = ANY/.test(sql) ? byInterests : anyOperator };
    }
    return { rows: [] };
  });
}

const call = () => GET(new NextRequest('https://vedarai.ru/api/cron/leads-followup', { headers: { authorization: 'Bearer test-secret' } }));
const sentTo = () => alertMock.mock.calls.map((c) => (c[0] as { to: { maxChatId: string } }).to.maxChatId);
/** Slug, который крон дописал в notified_operators лида. */
const notified = () => queryMock.mock.calls
  .filter(([sql]) => /UPDATE leads/.test(String(sql)))
  .map(([, params]) => (JSON.parse(String((params as unknown[])[0])) as { notified_operators: string[] }).notified_operators.at(-1));

/** Полдень по Камчатке в названный день: дата по Камчатке равна названной. */
const noonKamchatka = (day: string) => new Date(`${day}T00:00:00Z`);

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret';
  alertMock.mockReset();
  alertMock.mockResolvedValue({ delivered: true, channel: 'max' });
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
});

describe('крон добивки: следующий оператор — победитель жребия, а не первая строка базы', () => {
  /** День, в который победитель среди [A, B, C] — не первая строка. */
  const dayWhereFirstRowLoses = days('2027-03-01', 60).find((d) => byLot(d, [A, B, C]).id !== A.id)!;
  /** День, в который победитель — именно первая строка: жребий, а не «кто угодно, кроме первого». */
  const dayWhereFirstRowWins = days('2027-03-01', 60).find((d) => byLot(d, [A, B, C]).id === A.id)!;

  it('ступень «по интересам»: лид уходит победителю жребия дня', async () => {
    expect(dayWhereFirstRowLoses).toBeDefined();
    vi.setSystemTime(noonKamchatka(dayWhereFirstRowLoses));
    expect(offerOrderDay()).toBe(dayWhereFirstRowLoses);
    const winner = byLot(dayWhereFirstRowLoses, [A, B, C]);
    db([LEAD], [A, B, C], []);
    expect((await call()).status).toBe(200);
    expect(sentTo()).toEqual([(winner as typeof A).max_chat_id]);
    expect(notified()).toEqual([(winner as typeof A).slug]);
    expect(sentTo()).not.toEqual([A.max_chat_id]);
  });

  it('в другой день первым идёт другой оператор — тот, чей билет меньше в этот день', async () => {
    expect(dayWhereFirstRowWins).toBeDefined();
    vi.setSystemTime(noonKamchatka(dayWhereFirstRowWins));
    db([LEAD], [A, B, C], []);
    expect((await call()).status).toBe(200);
    expect(sentTo()).toEqual([A.max_chat_id]);
  });

  it('порядок строк базы исхода не меняет', async () => {
    vi.setSystemTime(noonKamchatka(dayWhereFirstRowLoses));
    const winner = byLot(dayWhereFirstRowLoses, [A, B, C]) as typeof A;
    for (const rows of [[A, B, C], [C, B, A], [B, C, A]]) {
      alertMock.mockClear();
      db([LEAD], rows, []);
      await call();
      expect(sentTo(), rows.map((r) => r.slug).join(',')).toEqual([winner.max_chat_id]);
    }
  });

  it('без интересов — жребий среди всех операторов; с интересами ступень «по интересам» стоит раньше жребия', async () => {
    vi.setSystemTime(noonKamchatka(dayWhereFirstRowLoses));
    const winner = byLot(dayWhereFirstRowLoses, [A, B, C]) as typeof A;
    db([NO_INTERESTS], [], [A, B, C]);
    await call();
    expect(sentTo()).toEqual([winner.max_chat_id]);

    // Совпадение с запросом — первый ключ: единственный подходящий по
    // интересам получает лид, даже если по жребию дня среди всех он не первый.
    const loser = [A, B, C].find((o) => o.id !== winner.id)!;
    alertMock.mockClear();
    db([LEAD], [loser], [A, B, C]);
    await call();
    expect(sentTo()).toEqual([loser.max_chat_id]);
  });

  it('запросы кандидатов отдают всех подходящих: LIMIT 1 в них нет, а id партнёра для жребия — есть', async () => {
    vi.setSystemTime(noonKamchatka(dayWhereFirstRowLoses));
    db([LEAD, NO_INTERESTS], [A, B, C], [A, B, C]);
    await call();
    expect(partnerQueries.length).toBeGreaterThanOrEqual(2);
    for (const sql of partnerQueries) {
      expect(sql).not.toMatch(/LIMIT\s+1\b/i);
      expect(sql).toMatch(/p\.id::text AS id/);
    }
  });
});

// @vitest-environment node
/**
 * «Беру» / «Не могу» на заявке проката: кнопка разбирается, дни считаются,
 * чужая заявка не пишется, повтор не отмечает дни второй раз, менеджеру
 * уходит факт без телефона заказчика.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  managerAnswerText, parseRequestAnswer, partnerAnswerText, rentalAnswerButtons, rentalSpanDays, requestAnswerEditText,
} from '@/lib/rental/request-answer';
import { handleRentalRequestAnswer } from '@/lib/rental/request-answer-flow';

const pool = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => pool(...a) } }));

const PARTNER = '22222222-2222-4222-8222-222222222222';
const OFFER = '11111111-1111-4111-8111-111111111111';
const LEAD = '33333333-3333-4333-8333-333333333333';
const PHONE = '+79001234567';

function leadRow(over: Record<string, unknown> = {}) {
  return {
    id: LEAD,
    operator_id: PARTNER,
    source_data: {
      kind: 'car_rental', company_id: PARTNER, offer_id: OFFER,
      offer_title: 'Suzuki Jimny', date_from: '2026-11-10', date_to: '2026-11-12',
      ...over,
    },
  };
}

beforeEach(() => {
  pool.mockReset();
  vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
});

describe('разбор кнопки и дни', () => {
  it('кнопки только на uuid, payload короче лимита MAX', () => {
    expect(rentalAnswerButtons('lead-7')).toBeUndefined();
    const buttons = rentalAnswerButtons(LEAD);
    expect(buttons?.map((b) => b.payload)).toEqual([`rr:y:${LEAD}`, `rr:n:${LEAD}`]);
    expect(buttons?.every((b) => b.payload.length <= 128)).toBe(true);
    expect(parseRequestAnswer(`rr:y:${LEAD}`)).toEqual({ answer: 'take', leadId: LEAD });
    expect(parseRequestAnswer(`rr:n:${LEAD.toUpperCase()}`)).toEqual({ answer: 'decline', leadId: LEAD });
    expect(parseRequestAnswer('rr:y:not-a-uuid')).toBeNull();
    expect(parseRequestAnswer(`rb:s:${OFFER}:2026-11-10:1`)).toBeNull();
  });

  it('три календарных дня включительно; 31-й день и кривая дата — не ряд', () => {
    expect(rentalSpanDays('2026-11-10', '2026-11-12')).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
    expect(rentalSpanDays('2026-11-12', '2026-11-10')).toBeNull();
    expect(rentalSpanDays('2026-02-30', '2026-03-01')).toBeNull();
    expect(rentalSpanDays('2026-11-01', '2026-12-01')).toBeNull();
  });

  it('менеджеру — факт без телефона; правка экранирует исходный текст', () => {
    const text = managerAnswerText({
      partnerName: 'Лагуна <Прокат>', leadId: LEAD, answer: 'take',
      carTitle: 'Suzuki Jimny', from: '2026-11-10', to: '2026-11-12', marked: 3,
    });
    expect(text).toContain('беру');
    expect(text).toContain('Лагуна &lt;Прокат&gt;');
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain('<Прокат>');
    const edited = requestAnswerEditText(`Анна ${PHONE} <script>`, partnerAnswerText({ kind: 'decline' }));
    expect(edited).toContain('не могу');
    expect(edited).toContain('&lt;script&gt;');
    expect(edited).not.toContain('<script>');
  });
});

describe('поток ответа', () => {
  const sent: Array<{ text: string; edit: string | null }> = [];
  const managers: string[] = [];
  const send = async (text: string, edit: string | null) => { sent.push({ text, edit }); };
  const notifyManager = async (text: string) => { managers.push(text); };

  function arm(opts: { prior?: 'take' | 'decline' | null; lead?: Record<string, unknown> | null; markRows?: number } = {}) {
    sent.length = 0;
    managers.length = 0;
    pool.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const s = String(sql);
      if (/FROM leads/.test(s)) return { rows: opts.lead === null ? [] : [opts.lead ?? leadRow()] };
      if (/lead_activity_log/.test(s) && /SELECT/.test(s)) return { rows: opts.prior ? [{ answer: opts.prior }] : [] };
      if (/INSERT INTO lead_activity_log/.test(s)) return { rows: [{ id: '1' }] };
      if (/INSERT INTO rental_car_busy/.test(s)) {
        const days = Array.isArray(params?.[2]) ? params[2] as string[] : [];
        const n = opts.markRows ?? days.length;
        return { rows: days.slice(0, n).map((day) => ({ day })) };
      }
      if (/FROM car_rental_offers/.test(s)) return { rows: [{ id: OFFER, title: 'Suzuki Jimny' }] };
      return { rows: [] };
    });
  }

  const press = (payload: string, slug = 'laguna-prokat') => handleRentalRequestAnswer({
    lookup: { outcome: 'found', partner: { partnerId: PARTNER, partnerName: 'Лагуна Прокат', slug } },
    payload, editMid: 'mid-1', originalText: `Заявка\nТелефон: ${PHONE}`,
    send, notifyManager,
  });

  it('«Беру» пишет три дня и журнал, менеджеру без телефона, кнопки снимает правкой', async () => {
    arm();
    await press(`rr:y:${LEAD}`);
    const insert = pool.mock.calls.find((c) => /INSERT INTO rental_car_busy/.test(String(c[0])));
    expect(insert?.[1]).toEqual([OFFER, PARTNER, ['2026-11-10', '2026-11-11', '2026-11-12'], LEAD]);
    const journal = pool.mock.calls.find((c) => /INSERT INTO lead_activity_log/.test(String(c[0])));
    expect(String(journal?.[1]?.[1])).toContain('"answer":"take"');
    expect(String(journal?.[1]?.[1])).not.toContain(PHONE);
    expect(managers).toHaveLength(1);
    expect(managers[0]).not.toContain(PHONE);
    expect(managers[0]).toContain('3');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.edit).toBe('mid-1');
    expect(sent[0]?.text).toContain('отмечены занятыми (3)');
    expect(sent[0]?.text).toContain(PHONE);
  });

  it('«Не могу» дни не занимает', async () => {
    arm();
    await press(`rr:n:${LEAD}`);
    expect(pool.mock.calls.some((c) => /INSERT INTO rental_car_busy/.test(String(c[0])))).toBe(false);
    expect(managers[0]).toContain('не могу');
    expect(managers[0]).not.toContain(PHONE);
    expect(sent[0]?.text).toContain('не могу');
  });

  it('повтор не пишет дни и менеджера не будит', async () => {
    arm({ prior: 'take' });
    await press(`rr:y:${LEAD}`);
    expect(pool.mock.calls.some((c) => /INSERT INTO rental_car_busy/.test(String(c[0])))).toBe(false);
    expect(pool.mock.calls.some((c) => /INSERT INTO lead_activity_log/.test(String(c[0])))).toBe(false);
    expect(managers).toHaveLength(0);
    expect(sent[0]?.text).toContain('уже записан');
  });

  it('чужой прокатчик и не пилот ничего не пишут', async () => {
    arm({ lead: { ...leadRow(), operator_id: '99999999-9999-4999-8999-999999999999' } });
    await press(`rr:y:${LEAD}`);
    expect(pool.mock.calls.some((c) => /INSERT/.test(String(c[0])))).toBe(false);
    expect(sent[0]?.text).toContain('не ваша');

    arm();
    pool.mockClear();
    await press(`rr:y:${LEAD}`, 'fishing');
    expect(pool.mock.calls.some((c) => /FROM leads/.test(String(c[0])))).toBe(false);
    expect(sent.at(-1)?.text).toContain('не принимаю');
  });

  it('заявки нет — дни не отмечает', async () => {
    arm({ lead: null });
    await press(`rr:y:${LEAD}`);
    expect(pool.mock.calls.some((c) => /INSERT/.test(String(c[0])))).toBe(false);
    expect(sent[0]?.text).toContain('не нашёл');
    expect(managers).toHaveLength(0);
  });
});

/**
 * tests/unit/answer-subject-date.test.ts
 *
 * Ответ оператора кнопкой знает дату заявки (план «после отказа», этап 2а,
 * миграция 1422). После «Нет мест» турист сам выбирает другую дату, поэтому
 * ответ обязан быть о той дате, которую оператор видел в вопросе:
 *  - дата идёт хвостом в «Да» и в кнопки причин отказа, кнопка подписана и
 *    влезает в 64 байта Telegram;
 *  - первое нажатие ничего не пишет и показывает дату заявки;
 *  - «Да» пишет ответ с проверкой даты; сменилась — ответ не записан, вопрос
 *    заново о новой дате, статус заявки не трогается;
 *  - «Да» и причина без даты (выпущены до 1422) — вопрос заново, без записи;
 *  - дата не прочиталась — ответ не записан.
 * Сам SQL записи — на настоящем PostgreSQL: tests/integration/request-chat.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn(), find: vi.fn(), inbox: vi.fn(), status: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []) } }));
vi.mock('@/lib/kuzmich/operator-chat', () => ({ findPartnerByChat: (...a: unknown[]) => h.find(...a), processPartnerMessage: vi.fn() }));
vi.mock('@/lib/crm/inbox', () => ({ loadInbox: (...a: unknown[]) => h.inbox(...a) }));
vi.mock('@/lib/leads/owner-lead-status', () => ({ changeLeadStatus: (...a: unknown[]) => h.status(...a) }));

import { LEAD_ANSWER_DATE_SQL, answerDayCode, answerDayOf } from '@/lib/requests/answer-date';
import {
  CHAT_ANSWER_INSERT_SQL, LEAD_ANSWER_DATE_READ_SQL, chatAnswerAsk, declineReasonButtons, parseChatAnswer,
} from '@/lib/requests/chat-answer';
import { CALLBACK_MAX_BYTES, unwrapPress } from '@/lib/chat-cabinet/signed-payload';
import { operatorDeskPress } from '@/lib/telegram/operator-desk-press';

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const PARTNER = '22222222-3333-4444-8555-666666666666';

const unsigned = (p: string): string => {
  const v = unwrapPress(p);
  if (!v.ok) throw new Error(`кнопка не прошла подпись: ${p}`);
  return v.payload;
};

describe('дата заявки — код дня и выражение', () => {
  it('код дня туда и обратно; «даты нет» — x; кривое — не код', () => {
    for (const d of ['2026-11-11', '2027-01-15', '2028-02-29', '2027-12-31']) {
      const code = answerDayCode(d);
      expect(code).toMatch(/^[0-9a-z]{3,4}$/);
      expect(answerDayOf(code!)).toBe(d);
    }
    expect(answerDayCode(null)).toBe('x');
    expect(answerDayOf('x')).toBeNull();
    expect(answerDayCode('15.01.2027')).toBeNull();
    // Регулярку проходит, а в календаре нет (или до 1970): кода нет — кнопка без хвоста, запись без сверки.
    for (const d of ['2027-02-30', '2027-13-01', '1969-12-31']) expect(answerDayCode(d)).toBeNull();
    expect(answerDayOf('zz!')).toBeUndefined();
    expect(answerDayOf('abcde')).toBeUndefined();
  });

  it('выражение — только строгий ISO; псевдоним не подставит постороннего', () => {
    expect(LEAD_ANSWER_DATE_SQL('l')).toContain("l.source_data->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'");
    expect(() => LEAD_ANSWER_DATE_SQL('l; DROP TABLE leads')).toThrow();
  });
});

describe('кнопки «Да» и причины несут дату заявки', () => {
  beforeEach(() => vi.stubEnv('CALLBACK_SIGNING_SECRET', 'unit-signing'));

  it('«Да» каждого ответа: подписана, не длиннее 64 байт, дата разбирается обратно', () => {
    for (const a of ['accept', 'other_date', 'no_seats', 'clarify', 'self'] as const) {
      for (const d of ['2027-01-15', null] as const) {
        const yes = chatAnswerAsk(a, 'lead', ID, d).rows[0]![0]!.payload;
        expect(yes).toContain('~');
        expect(Buffer.byteLength(yes)).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
        expect(parseChatAnswer(unsigned(yes))).toEqual({ answer: a, kind: 'lead', subjectId: ID, confirmed: true, date: d });
      }
    }
  });

  it('причины отказа — с той же датой; у других предметов хвоста даты нет', () => {
    for (const b of declineReasonButtons('lead', ID, '2027-01-15').flat()) {
      expect(b.payload).toContain('~');
      expect(Buffer.byteLength(b.payload)).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
      expect(parseChatAnswer(unsigned(b.payload))).toMatchObject({ answer: 'decline', subjectId: ID, date: '2027-01-15' });
    }
    const booking = chatAnswerAsk('no_seats', 'booking', '123', '2027-01-15').rows[0]![0]!.payload;
    expect(unsigned(booking)).toBe('ia:yn:b:123');
    expect(parseChatAnswer('ia:yn:b:123')).not.toHaveProperty('date');
  });

  it('вопрос называет дату заявки: «Нет мест» — на какую дату', () => {
    expect(chatAnswerAsk('no_seats', 'lead', ID, '2027-01-15').text).toBe('Записать ответ «Нет мест» на 15.01.2027? Расписание не закрывается.');
    expect(chatAnswerAsk('accept', 'lead', ID, '2027-01-15').text).toMatch(/^Записать ответ «Подтверждаю заявку» по заявке на 15\.01\.2027\?/);
    expect(chatAnswerAsk('no_seats', 'lead', ID, null).text).toBe('Записать ответ «Нет мест»? Расписание не закрывается.');
  });

  it('хвост даты: только у «Да» и причины заявки; на первом нажатии и у чужого предмета — не кнопка', () => {
    const code = answerDayCode('2027-01-15')!;
    expect(parseChatAnswer(`ia:n:l:${ID}:${code}`)).toBeNull();
    expect(parseChatAnswer(`ia:yn:b:123:${code}`)).toBeNull();
    expect(parseChatAnswer(`ia:rs:g:123:${code}`)).toBeNull();
    expect(parseChatAnswer(`ia:yn:l:${ID}:!!`)).toBeNull();
    expect(parseChatAnswer(`ia:yn:l:${ID}`)).toEqual({ answer: 'no_seats', kind: 'lead', subjectId: ID, confirmed: true });
  });
});

describe('нажатие оператора: ответ о той дате, что он видел', () => {
  /** Дата заявки сейчас; Error — база не ответила. */
  let leadDate: string | null | Error;
  /** Что вернёт запись: id — записано; null — нет строки (повтор или дата сменилась). */
  let inserted: string | null;

  beforeEach(() => {
    vi.stubEnv('CALLBACK_SIGNING_SECRET', 'unit-signing');
    h.query.mockReset();
    h.status.mockReset();
    leadDate = '2027-01-15';
    inserted = '901';
    h.find.mockResolvedValue({ outcome: 'found', partner: { partnerId: PARTNER, category: 'operator', slug: 'op', userId: 'u1' } });
    h.inbox.mockResolvedValue({ items: [{ kind: 'lead', id: ID }], failed: [] });
    h.status.mockResolvedValue({ kind: 'changed' });
    h.query.mockImplementation(async (sql: string) => {
      if (sql === LEAD_ANSWER_DATE_READ_SQL) {
        if (leadDate instanceof Error) throw leadDate;
        return { rows: [{ d: leadDate }] };
      }
      if (sql === CHAT_ANSWER_INSERT_SQL) {
        if (leadDate instanceof Error) throw leadDate;
        return { rows: [{ answer_id: inserted, subject_date: leadDate }] };
      }
      throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
    });
  });

  // Вебхук снимает подпись до разбора (unwrapPress) — сюда приходит payload без хвоста.
  const press = (payload: string) => operatorDeskPress({ channel: 'max', chatId: 7, payload });
  const inserts = () => h.query.mock.calls.filter(([s]) => s === CHAT_ANSWER_INSERT_SQL).map(([, p]) => p as unknown[]);
  const reasonsOf = (r: Awaited<ReturnType<typeof press>>) => r!.buttons.flat()
    .filter((b) => b.payload && unsigned(b.payload).startsWith('ia:r'))
    .map((b) => parseChatAnswer(unsigned(b.payload!)));
  const yesOf = (r: Awaited<ReturnType<typeof press>>) => {
    const yes = r!.buttons.flat().find((b) => b.text === 'Да');
    return yes ? parseChatAnswer(unsigned(yes.payload!)) : null;
  };

  it('первое нажатие: вопрос с датой заявки, «Да» несёт её; ничего не записано', async () => {
    const r = await press(`ia:n:l:${ID}`);
    expect(r!.text).toContain('Записать ответ «Нет мест» на 15.01.2027?');
    expect(yesOf(r)).toMatchObject({ answer: 'no_seats', confirmed: true, date: '2027-01-15' });
    expect(inserts()).toHaveLength(0);
  });

  it('«Да» с той же датой: запись с проверкой даты, итог называет дату', async () => {
    const r = await press(`ia:yn:l:${ID}:${answerDayCode('2027-01-15')}`);
    expect(inserts()).toEqual([[PARTNER, 'lead', ID, 'no_seats', null, true, '2027-01-15']]);
    expect(r!.text).toContain('Ваш ответ: нет мест на 15.01.2027.');
  });

  it('дата сменилась между вопросом и «Да»: ответ не записан, вопрос заново о новой дате, статус не тронут', async () => {
    leadDate = '2027-01-20';
    inserted = null;
    const r = await press(`ia:yd:l:${ID}:${answerDayCode('2027-01-15')}`);
    expect(inserts()[0]!.slice(5)).toEqual([true, '2027-01-15']);
    expect(r!.text).toContain('Дата заявки сменилась: сейчас в ней 20.01.2027. Ответ не записал');
    expect(yesOf(r)).toMatchObject({ answer: 'other_date', date: '2027-01-20' });
    expect(h.status).not.toHaveBeenCalled();
  });

  it('повтор «Да» на ту же дату — «уже записан», а не «дата сменилась»', async () => {
    inserted = null;
    const r = await press(`ia:yn:l:${ID}:${answerDayCode('2027-01-15')}`);
    expect(r!.text).toContain('Ответ по этой заявке уже записан');
  });

  it('отказ: причины с датой; причина с другой датой — не записано, причины заново по новой', async () => {
    const pick = await press(`ia:x:l:${ID}`);
    expect(pick!.text).toContain('Почему отказ по заявке на 15.01.2027?');
    const reasons = pick!.buttons.flat().filter((b) => b.payload?.startsWith('ia:r'));
    expect(reasons.length).toBe(5);
    expect(reasons.every((b) => (parseChatAnswer(unsigned(b.payload!)) as { date?: string }).date === '2027-01-15')).toBe(true);

    leadDate = '2027-01-20';
    inserted = null;
    const r = await press(`ia:rw:l:${ID}:${answerDayCode('2027-01-15')}`);
    expect(r!.text).toContain('Дата заявки сменилась');
    expect(r!.text).toContain('Почему отказ по заявке на 20.01.2027?');
    expect(h.status).not.toHaveBeenCalled();
    // Новые причины — о новой дате; нажатие одной из них пишет отказ на 20.01.
    const again = reasonsOf(r);
    expect(again.map((a) => a?.date)).toEqual(Array(5).fill('2027-01-20'));
    inserted = '902';
    h.query.mockClear();
    await press(unsigned(r!.buttons.flat().find((b) => b.text === 'Погода, безопасность')!.payload!));
    expect(inserts()).toEqual([[PARTNER, 'lead', ID, 'decline', 'weather', true, '2027-01-20']]);
  });

  it('«Да» и причина без даты (выпущены до 1422) — вопрос заново с датой, без записи', async () => {
    const yes = await press(`ia:yn:l:${ID}`);
    expect(yes!.text).toMatch(/^Кнопка старая — сверьте дату заявки/);
    expect(yesOf(yes)).toMatchObject({ date: '2027-01-15' });
    const reason = await press(`ia:rs:l:${ID}`);
    expect(reason!.text).toMatch(/^Кнопка старая/);
    expect(reasonsOf(reason).map((a) => a?.date)).toEqual(Array(5).fill('2027-01-15'));
    expect(inserts()).toHaveLength(0);
  });

  it('дата заявки не из календаря (30.02): кнопка без хвоста, «Да» пишет без сверки — не «кнопка старая» по кругу', async () => {
    leadDate = '2027-02-30';
    const ask = await press(`ia:n:l:${ID}`);
    const yes = yesOf(ask);
    expect(yes).toMatchObject({ answer: 'no_seats', confirmed: true });
    expect(yes).not.toHaveProperty('date');
    const r = await press(`ia:yn:l:${ID}`);
    expect(r!.text).not.toMatch(/Кнопка старая|Дата заявки сменилась/);
    expect(inserts()).toEqual([[PARTNER, 'lead', ID, 'no_seats', null, false, null]]);
    // Причины отказа — так же.
    h.query.mockClear();
    const pick = await press(`ia:x:l:${ID}`);
    expect(reasonsOf(pick).every((a) => a !== null && !('date' in a))).toBe(true);
    await press(`ia:rd:l:${ID}`);
    expect(inserts()).toEqual([[PARTNER, 'lead', ID, 'decline', 'dates', false, null]]);
  });

  it('дата заявки не прочиталась — ответ не записан, сказано честно', async () => {
    leadDate = Object.assign(new Error('down'), { code: '57P01' });
    const r = await press(`ia:n:l:${ID}`);
    expect(r!.text).toMatch(/^Не удалось прочитать дату заявки/);
    expect(inserts()).toHaveLength(0);
  });
});

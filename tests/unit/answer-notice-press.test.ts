/**
 * tests/unit/answer-notice-press.test.ts
 *
 * Сообщение туристу уходит из самого нажатия оператора (план «после отказа»,
 * 2б; ревью 2б: «отправку из нажатия можно удалить, и тесты останутся
 * зелёными»). Судится вызовом operatorDeskPress, с подложенной базой и
 * модулем отправки:
 *  - «Нет мест» с новой строкой сообщения — отправка сразу, строка исхода в
 *    ответе оператору;
 *  - «Отказать» — сначала статус заявки (`lost`), потом отправка: сообщение
 *    строится из вида заявки, а тот читает статус;
 *  - строка «пропущено» — никуда не шлёт, называет причину;
 *  - повтор нажатия — исход записанного сообщения, второй отправки нет.
 * Сама отправка — tests/unit/answer-notice.test.ts, SQL — request-chat.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(), find: vi.fn(), inbox: vi.fn(), status: vi.fn(), deliver: vi.fn(), readOutcome: vi.fn(), ask: vi.fn(),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []) } }));
vi.mock('@/lib/kuzmich/operator-chat', () => ({ findPartnerByChat: (...a: unknown[]) => h.find(...a), processPartnerMessage: vi.fn() }));
vi.mock('@/lib/crm/inbox', () => ({ loadInbox: (...a: unknown[]) => h.inbox(...a) }));
vi.mock('@/lib/leads/owner-lead-status', () => ({ changeLeadStatus: (...a: unknown[]) => h.status(...a) }));
vi.mock('@/lib/requests/answer-notice', () => ({
  deliverAnswerNotice: (...a: unknown[]) => h.deliver(...a),
  readNoticeOutcomeFor: (...a: unknown[]) => h.readOutcome(...a),
}));

// Вопрос другим компаниям после отказа (этап 4б): сам поток — tests/unit/offer-asks.test.ts.
vi.mock('@/lib/requests/offer-asks', () => ({ askOtherCompaniesWithinPress: (...a: unknown[]) => h.ask(...a) }));

import { answerDayCode } from '@/lib/requests/answer-date';
import { CHAT_ANSWER_INSERT_SQL, LEAD_ANSWER_DATE_READ_SQL } from '@/lib/requests/chat-answer';
import { operatorDeskPress } from '@/lib/telegram/operator-desk-press';
import { NOTICE_PRESS_BUDGET_MS, withinPress } from '@/lib/requests/press-budget';

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const PARTNER = '22222222-3333-4444-8555-666666666666';
const DAY = '2027-01-15';

/** Что вернёт запись ответа: answer_id null — повтор (ответ уже был, дата та же). */
let inserted: {
  answer_id: string | null; subject_date: string; notice_id: string | null; notice_state: string | null; notice_skip: string | null;
  lead_status?: string | null;
};

beforeEach(() => {
  vi.stubEnv('CALLBACK_SIGNING_SECRET', 'unit-signing');
  for (const f of Object.values(h)) f.mockReset();
  inserted = { answer_id: '901', subject_date: DAY, notice_id: '555', notice_state: 'pending', notice_skip: null };
  h.find.mockResolvedValue({ outcome: 'found', partner: { partnerId: PARTNER, category: 'operator', slug: 'op', userId: 'u1' } });
  h.inbox.mockResolvedValue({ items: [{ kind: 'lead', id: ID }], failed: [] });
  h.status.mockResolvedValue({ kind: 'changed' });
  h.deliver.mockResolvedValue({ state: 'delivered', via: 'max', dates: [] });
  h.readOutcome.mockResolvedValue({ state: 'undelivered', manager: 'max', why: { broken: false, chat: 'none', agent: 'none' } });
  h.ask.mockResolvedValue(null);
  h.query.mockImplementation(async (sql: string) => {
    if (sql === LEAD_ANSWER_DATE_READ_SQL) return { rows: [{ d: DAY }] };
    if (sql === CHAT_ANSWER_INSERT_SQL) return { rows: [inserted] };
    throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
  });
});

const press = (payload: string) => operatorDeskPress({ channel: 'max', chatId: 7, payload });
const yes = (code: string) => `ia:y${code}:l:${ID}:${answerDayCode(DAY)}`;

describe('нажатие оператора шлёт туристу сразу', () => {
  it('«Нет мест»: отправка этой строки сообщения, исход — в ответе оператору', async () => {
    const r = await press(yes('n'));
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0]![0]).toBe('555');
    expect(r!.text).toContain('Ваш ответ: нет мест на 15.01.2027.');
    expect(r!.text).toContain('Туристу ушло сообщение в MAX');
    // «Нет мест» статус заявки не меняет.
    expect(h.status).not.toHaveBeenCalled();
  });

  it('«Отказать»: статус `lost` — раньше отправки; не дошло — оператору честно, без выдуманного агента', async () => {
    h.deliver.mockResolvedValue({ state: 'undelivered', manager: 'max', why: { broken: false, chat: 'none', agent: 'none' } });
    const r = await press(`ia:rs:l:${ID}:${answerDayCode(DAY)}`);
    expect(h.status).toHaveBeenCalledTimes(1);
    expect((h.status.mock.calls[0]![0] as { status: string }).status).toBe('lost');
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.status.mock.invocationCallOrder[0]!).toBeLessThan(h.deliver.mock.invocationCallOrder[0]!);
    expect(r!.text).toContain('Туристу сообщить не удалось: чат с ним не подключён.');
    expect(r!.text).not.toMatch(/ИИ-агент/);
    expect(r!.text).toContain('менеджер Ведара — он позвонит');
  });

  it('нажатие ждёт отправку не дольше общего срока: дальше оператор читает «отправляется», а не «не ушло»', async () => {
    vi.useFakeTimers();
    try {
      // Отправка зависла (канал не отвечает, проверка дат после отказа по погоде тянется).
      h.deliver.mockImplementation(() => new Promise(() => {}));
      let done: Awaited<ReturnType<typeof press>> | undefined;
      const run = press(`ia:rw:l:${ID}:${answerDayCode(DAY)}`).then((r) => { done = r; });
      await vi.advanceTimersByTimeAsync(NOTICE_PRESS_BUDGET_MS - 1);
      expect(done).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);
      await run;
      expect(done!.text).toContain('Сообщение туристу отправляется; не уйдёт — повторю автоматически');
      expect(done!.text).not.toMatch(/сейчас не ушло/);
      // Срок нажатия не длиннее полуминуты. Сколько ждёт ответа сам вебхук мессенджера,
      // в этой сессии не проверено — число здесь наше, а не его.
      expect(NOTICE_PRESS_BUDGET_MS).toBeLessThanOrEqual(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('срок нажатия: работа успела — её итог; не успела — запасной итог, а сама работа не отменяется', async () => {
    expect(await withinPress(Promise.resolve('готово'), 'поздно', 50)).toBe('готово');
    let finished = false;
    const slow = new Promise<string>((resolve) => setTimeout(() => { finished = true; resolve('готово'); }, 40));
    expect(await withinPress(slow, 'поздно', 5)).toBe('поздно');
    await slow;
    expect(finished).toBe(true);
  });

  it('после «Нет мест» и «Отказать» другим компаниям задан вопрос — оператору сказано строкой; после других ответов вопроса нет', async () => {
    const ASKED = 'Другим компаниям с турами к этому месту (2) задан вопрос, возьмут ли они туриста на эту дату, — без его имени и телефона.';
    h.ask.mockResolvedValue(ASKED);
    for (const payload of [yes('n'), `ia:rs:l:${ID}:${answerDayCode(DAY)}`]) {
      h.ask.mockClear();
      const r = await press(payload);
      expect(h.ask, payload).toHaveBeenCalledTimes(1);
      // Спрашивают по заявке; кого и о чём — решает сам вопрос, не кнопка.
      expect(h.ask.mock.calls[0]).toEqual([ID]);
      expect(r!.text).toContain(`Туристу ушло сообщение в MAX: ваш ответ.\n${ASKED}`);
    }
    // Вопросов нет (погода, группа, некого спросить) — строка исхода прежняя.
    h.ask.mockResolvedValue(null);
    const plain = await press(yes('n'));
    expect(plain!.text).toContain('Туристу ушло сообщение в MAX');
    expect(plain!.text).not.toContain('задан вопрос');
  });

  it('вопросов другим компаниям нет: ответ не отказ, сообщение пропущено, повтор нажатия', async () => {
    // «Другая дата» рождает сообщение человеку, но не вопрос другим: оператор от человека не отказался.
    const other = await press(yes('d'));
    expect(other).not.toBeNull();
    expect(h.ask).not.toHaveBeenCalled();
    // «Подтвердить» — сообщения нет вовсе.
    inserted = { answer_id: '902', subject_date: DAY, notice_id: null, notice_state: null, notice_skip: null };
    await press(yes('a'));
    // Сообщение пропущено (заявка закрыта, своя проба, не адресат).
    inserted = { answer_id: '903', subject_date: DAY, notice_id: '556', notice_state: 'skipped', notice_skip: 'self' };
    await press(yes('n'));
    // Повтор нажатия: вопросы уже ушли с первым.
    inserted = { answer_id: null, subject_date: DAY, notice_id: null, notice_state: null, notice_skip: null };
    await press(yes('n'));
    expect(h.ask).not.toHaveBeenCalled();
  });

  it('вопросы идут рядом с сообщением человеку: нажатие ждёт дольшее из двух, а не их сумму', async () => {
    vi.useFakeTimers();
    try {
      const later = <T,>(value: T, ms: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
      h.deliver.mockImplementation(() => later({ state: 'delivered', via: 'max', dates: [] }, 10_000));
      h.ask.mockImplementation(() => later('Одной другой компании задан вопрос.', 7_000));
      let done: Awaited<ReturnType<typeof press>> | undefined;
      const run = press(yes('n')).then((r) => { done = r; });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(done).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);
      await run;
      expect(done!.text).toContain('Туристу ушло сообщение в MAX: ваш ответ.\nОдной другой компании задан вопрос.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('строка «пропущено» — никуда не шлёт и называет причину', async () => {
    inserted = { answer_id: '901', subject_date: DAY, notice_id: '556', notice_state: 'skipped', notice_skip: 'lead_closed' };
    const r = await press(`ia:rs:l:${ID}:${answerDayCode(DAY)}`);
    expect(h.deliver).not.toHaveBeenCalled();
    expect(r!.text).toContain('Заявка уже была закрыта — туристу ничего не отправлял.');
  });

  it('клиент отменил заявку (1427): оператору сказано это, а не «принято» — на любой ответ и на повтор; статус не трогается, туристу ничего не шлётся', async () => {
    const CANCELLED = 'Клиент отменил эту заявку — она закрыта. Отвечать по ней и держать места не нужно.';
    const cases: Array<[string, typeof inserted]> = [
      // «Подтвердить»: без этой строки оператор прочёл бы «Заявка отмечена «Связался»» и ждал бы человека.
      [yes('a'), { answer_id: '901', subject_date: DAY, notice_id: null, notice_state: null, notice_skip: null, lead_status: 'cancelled' }],
      [yes('n'), { answer_id: '902', subject_date: DAY, notice_id: '557', notice_state: 'skipped', notice_skip: 'lead_closed', lead_status: 'cancelled' }],
      [`ia:rs:l:${ID}:${answerDayCode(DAY)}`, { answer_id: '903', subject_date: DAY, notice_id: '558', notice_state: 'skipped', notice_skip: 'lead_closed', lead_status: 'cancelled' }],
      // Повтор нажатия по уже отменённой.
      [yes('a'), { answer_id: null, subject_date: DAY, notice_id: null, notice_state: null, notice_skip: null, lead_status: 'cancelled' }],
    ];
    for (const [payload, row] of cases) {
      inserted = row;
      const r = await press(payload);
      expect(r!.text, payload).toBe(CANCELLED);
    }
    expect(h.status).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.readOutcome).not.toHaveBeenCalled();
    // Живая заявка с тем же ответом — прежние слова.
    inserted = { answer_id: '904', subject_date: DAY, notice_id: null, notice_state: null, notice_skip: null, lead_status: 'new' };
    expect((await press(yes('a')))!.text).toContain('Ваш ответ: подтверждаю заявку.');
    expect(h.status).toHaveBeenCalledTimes(1);
  });

  it('повтор нажатия — исход записанного сообщения по ответу на ту же дату, второй отправки нет', async () => {
    inserted = { answer_id: null, subject_date: DAY, notice_id: null, notice_state: null, notice_skip: null };
    const r = await press(yes('n'));
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.readOutcome).toHaveBeenCalledWith(ID, PARTNER, DAY);
    expect(r!.text).toContain('Ответ по этой заявке уже записан');
    expect(r!.text).toContain('Туристу сообщить не удалось');
  });

  it('ответ, о котором туристу не сообщаем («Подтвердить»), — без строки исхода', async () => {
    inserted = { answer_id: '902', subject_date: DAY, notice_id: null, notice_state: null, notice_skip: null };
    const r = await press(yes('a'));
    expect(h.deliver).not.toHaveBeenCalled();
    expect(r!.text).not.toMatch(/Туристу/);
  });
});

// @vitest-environment node
/**
 * Ответ перевозчика на заявку на машину целиком — «Беру» / «Не могу»
 * (#2862 этап A, слово владельца 30.10 «нужно тоже продумать CRM полное с
 * ТГ и MAX и закрыть дыры»). До этого дня заявку вёл только менеджер:
 * перевозчик получал факты в MAX и ответить через платформу не мог.
 *
 * Сторож держит вызовом:
 *   · одна кнопка — два смысла: вид заявки читается из лида; у перевозчика
 *     нет пилотного списка, дни не отмечаются, машина не закрепляется;
 *   · ответ записывается один раз (та же строка partner_answered, что у
 *     проката), с видом и меткой времени; повтор ничего не меняет;
 *   · после ответа: статус лида той же дверью, что у оператора и гида,
 *     после «Беру» заказчику — сообщение в переписку заявки, менеджеру — факт
 *     без ПД; отказ следствий не отменяет ответ и назван (в логе и партнёру);
 *   · «Не могу» (план «после отказа», этап 2б-2, слово владельца 12.11):
 *     строка сообщения заказчику рождается в транзакции ответа, отправляется
 *     один раз и после смены статуса; слов перевозчика в переписке нет;
 *     партнёру и менеджеру назван исход отправки, обещания «заявка остаётся у
 *     менеджера Ведара» нет нигде;
 *   · карточка кабинета в чате даёт те же кнопки в MAX и Telegram, переписку
 *     — только в MAX; Telegram-нажатие не из пилота идёт без строки проката;
 *   · дверь сайта — перевозчику, тем же правилом;
 *   · словарь «Входящих»: заявка на машину ждёт, снятого товара мест нет,
 *     вид входит в медиану и в напоминания, CHECK напоминаний его знает.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { pool, statusMock, postMock, tgMock, lookupMock, requirePartnerMock, deliverMock, readNoticeMock } = vi.hoisted(() => ({
  pool: vi.fn(), statusMock: vi.fn(), postMock: vi.fn(), tgMock: vi.fn(), lookupMock: vi.fn(), requirePartnerMock: vi.fn(),
  deliverMock: vi.fn(), readNoticeMock: vi.fn(),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => pool(...a),
    connect: async () => ({ query: (...a: unknown[]) => pool(...a), release: () => undefined }),
  },
}));
vi.mock('@/lib/leads/owner-lead-status', () => ({ changeLeadStatus: (...a: unknown[]) => statusMock(...a) }));
vi.mock('@/lib/requests/request-chat-service', () => ({ postOwnerMessage: (...a: unknown[]) => postMock(...a) }));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (...a: unknown[]) => tgMock(...a) }));
vi.mock('@/lib/kuzmich/operator-chat', () => ({ findPartnerByChat: (...a: unknown[]) => lookupMock(...a) }));
vi.mock('@/lib/crm/partner-context', () => ({ requirePartner: (...a: unknown[]) => requirePartnerMock(...a) }));
// Сама отправка заказчику — в tests/unit/answer-notice.test.ts; здесь — что дверь зовёт её один раз и когда.
vi.mock('@/lib/requests/answer-notice', () => ({
  deliverAnswerNotice: (...a: unknown[]) => deliverMock(...a),
  readVehicleNoticeOutcome: (...a: unknown[]) => readNoticeMock(...a),
}));

import { DECLINE_TELL_BUDGET_MS, answerRentalRequest, handleRentalRequestAnswer } from '@/lib/rental/request-answer-flow';
import { clientCharterTakeText, managerAnswerText, partnerAnswerText } from '@/lib/rental/request-answer';
import { answerTellAttention, answerTellPlain } from '@/lib/rental/web-cabinet';
import type { NoticeOutcome } from '@/lib/requests/answer-notice-text';
import { itemCardScreen, type CabinetPartner } from '@/lib/chat-cabinet/screens';
import { tryRentalCabinetTelegramPress } from '@/lib/rental/cabinet-telegram';
import { INBOX_BY_CATEGORY, INBOX_KINDS, INBOX_NOT_HERE, RESPONSE_METRIC_KINDS } from '@/lib/crm/inbox-kinds';
import { INBOX_REMIND_KINDS } from '@/lib/crm/inbox-reminders';
import type { InboxItem } from '@/lib/crm/inbox';

const PARTNER = '22222222-2222-4222-8222-222222222222';
const OTHER = '99999999-9999-4999-8999-999999999999';
const LEAD = '33333333-3333-4333-8333-333333333333';
const PHONE = '+79001234567';
const SHATUN = { partnerId: PARTNER, partnerName: 'Шатун <ИП>', slug: 'shatun', userId: 'u-shatun' };

function charterLead(over: Record<string, unknown> = {}) {
  return {
    id: LEAD,
    operator_id: PARTNER,
    source_data: {
      kind: 'charter', carrier_id: PARTNER, carrier_slug: 'shatun', destination: 'Вулкан Горелый',
      date_from: '2026-11-10', date_to: '2026-11-11', passengers: 10, ...over,
    },
  };
}

let journal: Array<Record<string, unknown>> = [];
/** Параметры вставки строки сообщения заказчику: [заявка, запись журнала, партнёр]. */
let notices: unknown[][] = [];
/** Порядок следствий: что шло раньше — статус или отправка. */
let order: string[] = [];

const DELIVERED_MAX: NoticeOutcome = { state: 'delivered', via: 'max', dates: [] };
const UNDELIVERED: NoticeOutcome = { state: 'undelivered', manager: 'max', why: { broken: false, chat: 'none', agent: 'none' } };

function arm(opts: { lead?: Record<string, unknown> | null; notice?: 'none' | 'throws' | { state: 'pending' | 'skipped'; skipped_reason: string | null } } = {}) {
  journal = [];
  notices = [];
  order = [];
  pool.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const s = String(sql);
    order.push(/^\s*(BEGIN|COMMIT|ROLLBACK)/.exec(s)?.[1] ?? (/INSERT INTO answer_notices/.test(s) ? 'notice' : /INSERT INTO lead_activity_log/.test(s) ? 'journal' : 'sql'));
    if (/INSERT INTO answer_notices/.test(s)) {
      if (opts.notice === 'throws') throw Object.assign(new Error('x'), { code: '57P01' });
      notices.push(params ?? []);
      if (opts.notice === 'none') return { rows: [] };
      return { rows: [{ id: '77', state: 'pending', skipped_reason: null, ...(typeof opts.notice === 'object' ? opts.notice : {}) }] };
    }
    if (/FROM leads/.test(s)) return { rows: opts.lead === null ? [] : [opts.lead ?? charterLead()] };
    if (/lead_activity_log/.test(s) && /SELECT/.test(s)) {
      const last = journal.at(-1);
      return { rows: last ? [{ answer: last.answer }] : [] };
    }
    if (/INSERT INTO lead_activity_log/.test(s)) {
      journal.push(JSON.parse(String(params?.[1])) as Record<string, unknown>);
      return { rows: [{ id: '41' }] };
    }
    if (/FROM partners/.test(s)) return { rows: [{ name: 'Шатун <ИП>', slug: 'shatun' }] };
    return { rows: [] };
  });
}

beforeEach(() => {
  pool.mockReset();
  statusMock.mockReset().mockImplementation(async () => {
    order.push('status');
    return { kind: 'ok', changed: true, prevStatus: 'new', lead: { id: LEAD, status: 'contacted', notes: null } };
  });
  deliverMock.mockReset().mockImplementation(async () => { order.push('deliver'); return DELIVERED_MAX; });
  readNoticeMock.mockReset().mockResolvedValue(null);
  postMock.mockReset().mockResolvedValue({ outcome: 'sent', delivery: 'max' });
  tgMock.mockReset().mockResolvedValue({ ok: true });
  lookupMock.mockReset();
  requirePartnerMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // Пилотный список пуст: у перевозчика его и не должно быть.
  vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', '');
});

describe('«Беру» перевозчика', () => {
  it('записывает один ответ с видом и временем, дни не трогает, лид → contacted, заказчику и менеджеру сказано без ПД', async () => {
    arm();
    const managers: string[] = [];
    const r = await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'take', via: 'max', notifyManager: async (t) => { managers.push(t); } });
    expect(r.tell).toEqual({ kind: 'charter_take', clientTold: true });
    expect(r.request).toMatchObject({ kind: 'charter', title: 'Вулкан Горелый', dateFrom: '2026-11-10', dateTo: '2026-11-11', offerId: null });

    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ answer: 'take', kind: 'charter', car_title: 'Вулкан Горелый', days_marked: null });
    expect(String(journal[0].at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(pool.mock.calls.some((c) => /rental_car_busy|car_rental_offers/.test(String(c[0])))).toBe(false);
    expect(pool.mock.calls.some((c) => /pg_advisory_xact_lock/.test(String(c[0])))).toBe(true);

    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(statusMock.mock.calls[0][0]).toMatchObject({
      leadId: LEAD, status: 'contacted', via: 'max',
      actor: { kind: 'partner_user', userId: 'u-shatun' },
      scope: { kind: 'owner', partnerId: PARTNER, claimUnowned: false },
    });

    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock.mock.calls[0][0]).toEqual({ kind: 'lead', id: LEAD });
    const toClient = String(postMock.mock.calls[0][1]);
    expect(toClient).toContain('«Шатун <ИП>» берёт вашу заявку');
    expect(toClient).not.toMatch(/₽|руб|закрепл[её]на за вами/);

    expect(managers).toHaveLength(1);
    expect(managers[0]).toContain('Перевозчик «Шатун &lt;ИП&gt;» ответил «беру» на заявку на машину');
    // Направление — свободный ввод заказчика: в рабочий Telegram оно не уходит вовсе, заявка находится по номеру.
    expect(managers[0]).not.toContain('Горелый');
    expect(managers[0]).toContain(LEAD);
    expect(managers[0]).not.toContain(PHONE);
  });

  it('«Не могу»: лид → lost, заказчику — одно сообщение Ведара после смены статуса, слов перевозчика в переписке нет; партнёру и менеджеру — исход', async () => {
    arm();
    const managers: string[] = [];
    const r = await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'decline', via: 'site', notifyManager: async (t) => { managers.push(t); } });
    expect(r.tell).toEqual({ kind: 'charter_decline', notice: DELIVERED_MAX });
    expect(statusMock.mock.calls[0][0]).toMatchObject({ status: 'lost', via: 'site' });

    // Строка сообщения — в транзакции ответа: после журнала и до фиксации, с номером записи журнала и партнёром.
    expect(notices).toEqual([[LEAD, '41', PARTNER]]);
    const tx = order.filter((o) => o !== 'sql');
    expect(tx.slice(0, 4)).toEqual(['BEGIN', 'journal', 'notice', 'COMMIT']);
    // Отправка — одна, по этой строке, и после статуса: вид заявки, из которого она строится, читает его.
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock.mock.calls[0][0]).toBe('77');
    expect(tx.indexOf('status')).toBeGreaterThan(tx.indexOf('COMMIT'));
    expect(tx.indexOf('deliver')).toBeGreaterThan(tx.indexOf('status'));
    // Двух сообщений об одном отказе заказчик не получает.
    expect(postMock).not.toHaveBeenCalled();

    expect(managers).toHaveLength(1);
    expect(managers[0]).toContain('ответил «не могу» на заявку на машину');
    // Менеджеру — и что заявка теперь за ним, и знает ли заказчик об отказе.
    expect(managers[0]).toContain('Нужен другой перевозчик: заявка остаётся у менеджера. Заказчику ушло сообщение об отказе в MAX');
    expect(managers[0]).not.toContain(PHONE);
    const told = partnerAnswerText(r.tell);
    expect(told).toContain('<b>Ваш ответ:</b> не могу. Заказчику ушло сообщение в MAX: ваш ответ.');
    expect(told).not.toMatch(/остаётся у менеджера|турист/i);
  });

  it('«Не могу», а до заказчика не дошло: партнёр читает, кто позвонит, менеджер — что письмо с телефоном ушло отдельно; сайт помечает итог предупреждением', async () => {
    arm();
    deliverMock.mockResolvedValue(UNDELIVERED);
    const managers: string[] = [];
    const r = await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'decline', notifyManager: async (t) => { managers.push(t); } });
    expect(r.tell).toEqual({ kind: 'charter_decline', notice: UNDELIVERED });
    expect(partnerAnswerText(r.tell)).toContain('Заказчику сообщить не удалось: чат с ним не подключён. Заявку с телефоном получил менеджер Ведара — он позвонит.');
    expect(managers[0]).toContain('До заказчика отказ не дошёл — заявка с телефоном ушла отдельным сообщением в MAX: позвонить.');
    expect(answerTellAttention(r.tell)).toBe(true);
    expect(answerTellAttention({ kind: 'charter_decline', notice: DELIVERED_MAX })).toBe(false);
    expect(answerTellAttention({ kind: 'charter_decline', notice: { state: 'skipped', reason: 'lead_closed' } })).toBe(false);
    expect(answerTellAttention({ kind: 'charter_decline', notice: { state: 'pending' } })).toBe(true);
    expect(answerTellAttention({ kind: 'charter_decline', notice: { state: 'pending', sending: true } })).toBe(true);
    expect(answerTellAttention({ kind: 'charter_decline', notice: null })).toBe(true);
  });

  it('канал завис: нажатие ждёт отправку не дольше срока, партнёр читает «отправляется», а не «не ушло» и не «ушло»', async () => {
    arm();
    vi.useFakeTimers();
    try {
      // Отправка не кончается никогда — как при зависшем канале.
      deliverMock.mockImplementation(() => { order.push('deliver'); return new Promise(() => undefined); });
      const managers: string[] = [];
      const pending = answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'decline', notifyManager: async (t) => { managers.push(t); } });
      await vi.advanceTimersByTimeAsync(DECLINE_TELL_BUDGET_MS - 1);
      expect(managers).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      const r = await pending;
      expect(r.tell).toEqual({ kind: 'charter_decline', notice: { state: 'pending', sending: true } });
      expect(partnerAnswerText(r.tell)).toContain('Сообщение заказчику отправляется; не уйдёт — повторю автоматически');
      expect(partnerAnswerText(r.tell)).not.toMatch(/сейчас не ушло|ушло сообщение/);
      expect(managers[0]).toContain('Сообщение заказчику об отказе отправляется');
      // Срок — меньше худшего срока самой отправки, иначе он ничего не ограничивает.
      expect(DECLINE_TELL_BUDGET_MS).toBeLessThanOrEqual(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('строка сообщения не создалась — отправки нет, партнёру сказано «не записалось», а не «ушло»; сбой её записи откатывает и ответ', async () => {
    arm({ notice: 'none' });
    const managers: string[] = [];
    const r = await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'decline', notifyManager: async (t) => { managers.push(t); } });
    expect(r.tell).toEqual({ kind: 'charter_decline', notice: null });
    expect(deliverMock).not.toHaveBeenCalled();
    expect(partnerAnswerText(r.tell)).toContain('Сообщение заказчику не записалось — свяжитесь с ним сами по телефону из заявки.');
    expect(managers[0]).toContain('Сообщение заказчику об отказе не записалось');
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/строка сообщения заказчику не создана/);

    arm({ notice: 'throws' });
    statusMock.mockClear();
    const failed = await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'decline', notifyManager: async () => undefined });
    expect(failed.tell).toEqual({ kind: 'retry' });
    expect(order).toContain('ROLLBACK');
    expect(order).not.toContain('COMMIT');
    expect(statusMock).not.toHaveBeenCalled();
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('«Беру» строки сообщения не рождает: о нём заказчику говорит сам перевозчик', async () => {
    arm();
    const r = await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'take', notifyManager: async () => undefined });
    expect(r.tell).toEqual({ kind: 'charter_take', clientTold: true });
    expect(notices).toEqual([]);
    expect(deliverMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('повтор, даже другим ответом, — «уже записан»: ни статуса, ни сообщения, ни менеджера второй раз', async () => {
    arm();
    const managers: string[] = [];
    const notify = async (t: string) => { managers.push(t); };
    await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'take', notifyManager: notify });
    const again = await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'decline', notifyManager: notify });
    expect(again.tell).toEqual({ kind: 'already', answer: 'take', notice: null });
    expect(journal).toHaveLength(1);
    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(managers).toHaveLength(1);
    expect(notices).toEqual([]);
    expect(deliverMock).not.toHaveBeenCalled();
    expect(readNoticeMock).not.toHaveBeenCalled();
  });

  it('повтор после «Не могу»: второго сообщения заказчику нет, партнёр читает прежний исход', async () => {
    arm();
    const notify = async () => undefined;
    await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'decline', notifyManager: notify });
    readNoticeMock.mockResolvedValue(UNDELIVERED);
    const again = await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'decline', notifyManager: notify });
    expect(again.tell).toEqual({ kind: 'already', answer: 'decline', notice: UNDELIVERED });
    expect(readNoticeMock).toHaveBeenCalledWith(LEAD);
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(1);
    expect(partnerAnswerText(again.tell)).toContain('Ответ уже записан: не могу.');
    expect(partnerAnswerText(again.tell)).toContain('Заказчику сообщить не удалось');
    // Исход не прочитался — строки об отправке нет, выдумывать её нечем.
    expect(partnerAnswerText({ kind: 'already', answer: 'decline', notice: null })).toBe('Ответ уже записан: не могу. Дни не отмечал.');
  });

  it('отказ следствий не отменяет ответ и назван: статус не сменился — в лог, заказчику не ушло — партнёру словами', async () => {
    arm();
    statusMock.mockRejectedValue(Object.assign(new Error('x'), { code: '57P01' }));
    postMock.mockResolvedValue({ outcome: 'sent', delivery: 'no_address', pageVisible: false });
    const r = await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'take', notifyManager: async () => undefined });
    expect(r.tell).toEqual({ kind: 'charter_take', clientTold: false });
    expect(journal).toHaveLength(1);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/статус заявки не сменён, SQLSTATE 57P01/);

    arm();
    postMock.mockResolvedValue({ outcome: 'not_found' });
    const r2 = await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'take', notifyManager: async () => undefined });
    expect(r2.tell).toEqual({ kind: 'charter_take', clientTold: false });
  });

  it('чужая заявка, не заявка партнёру и заявка проката у не-пилота — без записи; пилотного списка у перевозчика нет', async () => {
    arm({ lead: charterLead({ carrier_id: OTHER }) });
    expect((await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'take', notifyManager: async () => undefined })).tell).toEqual({ kind: 'not_yours' });
    arm({ lead: { ...charterLead(), operator_id: OTHER } });
    expect((await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'take', notifyManager: async () => undefined })).tell).toEqual({ kind: 'not_yours' });
    arm({ lead: { id: LEAD, operator_id: PARTNER, source_data: { source: 'site' } } });
    expect((await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'take', notifyManager: async () => undefined })).tell).toEqual({ kind: 'not_yours' });
    arm({ lead: { id: LEAD, operator_id: PARTNER, source_data: { kind: 'car_rental', company_id: PARTNER } } });
    expect((await answerRentalRequest({ partner: SHATUN, leadId: LEAD, answer: 'take', notifyManager: async () => undefined })).tell).toEqual({ kind: 'not_pilot' });
    expect(journal).toHaveLength(0);
    expect(statusMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('текст заказчику после «Беру» без суммы и без «машина за вами»; пустое имя — «Перевозчик»', () => {
    expect(clientCharterTakeText('  ')).toContain('Перевозчик «Перевозчик» берёт');
    expect(clientCharterTakeText('Шатун')).toContain('согласуете с ним напрямую');
    expect(clientCharterTakeText('Шатун')).not.toMatch(/₽|руб|менеджер/);
  });

  it('менеджеру в Telegram: направление — слова заказчика, телефон и почта из них не уходят; исход отправки назван по каждому случаю', () => {
    const base = { kind: 'charter' as const, partnerName: 'Шатун', leadId: LEAD, answer: 'decline' as const, from: '2026-11-10', to: null, marked: null };
    const dirty = managerAnswerText({ ...base, carTitle: `Горелый, встретить Петра у дома на Тестовой, ${PHONE}, ivan@example.com`, notice: DELIVERED_MAX });
    // Не только телефон и почта: адрес и имя чисткой не вырезать, поэтому направления в тексте нет вовсе.
    expect(dirty).not.toMatch(/Горелый|Петра|Тестовой|Направление/);
    expect(dirty).not.toContain(PHONE);
    expect(dirty).not.toContain('ivan@example.com');
    const CUE = 'Нужен другой перевозчик: заявка остаётся у менеджера. ';
    const line = (notice: NoticeOutcome | null) => {
      const last = managerAnswerText({ ...base, carTitle: 'Горелый', notice }).split('\n').at(-1)!;
      expect(last.startsWith(CUE), last).toBe(true);
      return last.slice(CUE.length);
    };
    expect(line({ state: 'delivered', via: 'agent_webhook', dates: [] })).toBe('Отказ ушёл ИИ-агенту заказчика: его уведомление принято.');
    expect(line({ state: 'delivered', via: 'page_seen', dates: [] })).toBe('Заказчик уже открыл страницу заявки и видит отказ.');
    expect(line({ ...UNDELIVERED, manager: 'telegram-stub' } as NoticeOutcome)).toContain('заглушка без телефона, номер в админке');
    expect(line({ ...UNDELIVERED, manager: 'none' } as NoticeOutcome)).toContain('письмо с телефоном сейчас не ушло — повторится автоматически');
    expect(line({ state: 'skipped', reason: 'self' })).toBe('Тестовая заявка карточки партнёра — заказчику ничего не отправлялось.');
    expect(line({ state: 'pending' })).toBe('Сообщение заказчику сейчас не ушло — отправка повторится автоматически.');
    expect(line({ state: 'pending', sending: true })).toBe('Сообщение заказчику об отказе отправляется; не уйдёт — повторится автоматически.');
    // Заявку уже вели, сообщение не ушло — об отказе заказчику больше сказать некому.
    expect(line({ state: 'skipped', reason: 'outgrown' })).toBe('Статус заявки уже сменился — заказчику ничего не отправлялось: об отказе ему нужно сказать самим.');
    expect(line(null)).toContain('не записалось');
    // «Беру» строки об отправке отказа не несёт.
    expect(managerAnswerText({ ...base, answer: 'take', carTitle: 'Горелый' })).toContain('Перевозчик свяжется с заказчиком сам');
  });
});

describe('нажатие в чате', () => {
  it('MAX: сообщение заявки правится ответом, под ним остаётся «Ответить клиенту»; текст без повтора телефона в строке ответа', async () => {
    arm();
    const sent: Array<{ text: string; edit: string | null; keep?: unknown }> = [];
    await handleRentalRequestAnswer({
      lookup: { outcome: 'found', partner: SHATUN },
      payload: `rr:y:${LEAD}`,
      editMid: 'mid-1',
      originalText: `Заявка\nТелефон: ${PHONE}`,
      via: 'max',
      send: async (text, edit, keep) => { sent.push({ text, edit, keep }); },
      notifyManager: async () => undefined,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].edit).toBe('mid-1');
    expect(sent[0].text).toContain('<b>Ваш ответ:</b> беру. Машина заявкой не закрепляется');
    expect(sent[0].text).toContain('Заказчику сообщил');
    expect(sent[0].keep).toEqual([{ text: 'Ответить клиенту', payload: `lq:o:${LEAD}` }]);
  });

  it('Telegram: перевозчик не из пилота отвечает без строки кабинета проката (sendBare); пилот проката — как раньше', async () => {
    arm();
    lookupMock.mockResolvedValue({ outcome: 'found', partner: { ...SHATUN, category: 'transfer', crmCategory: 'transfer' } });
    const bare: string[] = [];
    const withBar: string[] = [];
    const handled = await tryRentalCabinetTelegramPress({
      chatId: 777, payload: `rr:n:${LEAD}`,
      send: async (t) => { withBar.push(t); },
      sendBare: async (t) => { bare.push(t); },
    });
    expect(handled).toBe(true);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ answer: 'decline', kind: 'charter' });
    expect(bare).toHaveLength(1);
    expect(bare[0]).toContain('не могу');
    expect(withBar).toEqual([]);
    expect(statusMock.mock.calls[0][0]).toMatchObject({ via: 'telegram' });

    // Строка кабинета проката (`rk:`) у перевозчика по-прежнему не его.
    const other: string[] = [];
    await tryRentalCabinetTelegramPress({ chatId: 777, payload: 'rk:fleet', send: async (t) => { other.push(t); }, sendBare: async () => undefined });
    expect(other[0]).toContain('кабинет проката');
  });

  it('карточка заявки в кабинете чата: «Беру» / «Не могу» в обоих каналах, переписка — только в MAX, ПД в карточке нет', () => {
    const partner: CabinetPartner = { partnerId: PARTNER, role: 'transfer', seat: 'owner', bookingActions: false, leadActions: false, operatorAnswers: false, sellsTours: false, summary: false };
    const item: InboxItem = {
      kind: 'charter_request', id: LEAD, created_at: '2026-10-30T00:00:00Z', title: 'Вулкан Горелый', date: '2026-11-10',
      people: 10, contact_id: null, contact_name: null, waiting_minutes: 90,
    };
    for (const channel of ['max', 'telegram'] as const) {
      const screen = itemCardScreen({ item, partner, channel, base: 'https://vedarai.ru' });
      const payloads = screen.rows.flat().map((b) => ('payload' in b ? b.payload : ''));
      expect(payloads, channel).toContain(`rr:y:${LEAD}`);
      expect(payloads, channel).toContain(`rr:n:${LEAD}`);
      expect(payloads.includes(`lq:o:${LEAD}`), channel).toBe(channel === 'max');
      expect(screen.text, channel).toContain('Заявка на машину');
      expect(screen.text, channel).toContain('машина заявкой не закрепляется');
      expect(screen.text, channel).toContain('«Не могу» — заказчику уйдёт сообщение об этом');
      expect(screen.text, channel).not.toContain('остаётся у менеджера');
      expect(screen.pd, channel).toBe(false);
    }
    // У оператора такой карточки с кнопками нет: вид — перевозчика.
    const op = itemCardScreen({ item, partner: { ...partner, role: 'operator' }, channel: 'max', base: 'https://vedarai.ru' });
    expect(op.rows.flat().map((b) => ('payload' in b ? b.payload : ''))).not.toContain(`rr:y:${LEAD}`);
  });
});

describe('дверь сайта — POST /api/hub/crm/charter-requests/[id]/answer', () => {
  const req = (body: unknown) => new NextRequest(`http://localhost/api/hub/crm/charter-requests/${LEAD}/answer`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  const params = Promise.resolve({ id: LEAD });

  it('перевозчик → тем же правилом: ответ записан, 200 с текстом без разметки; повтор — 409', async () => {
    arm();
    requirePartnerMock.mockResolvedValue({ outcome: 'ok', partnerId: PARTNER, category: 'transfer', userId: 'u-shatun', seat: 'owner' });
    const { POST } = await import('@/app/api/hub/crm/charter-requests/[id]/answer/route');
    const res = await POST(req({ answer: 'take' }), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ success: true, outcome: 'charter_take' });
    expect(json.message).not.toMatch(/<b>/);
    expect(journal).toHaveLength(1);
    expect(statusMock.mock.calls[0][0]).toMatchObject({ via: 'site', actor: { userId: 'u-shatun' } });
    // Менеджеру — через рабочий чат, без телефона заказчика.
    expect(tgMock).toHaveBeenCalledTimes(1);
    expect(String(tgMock.mock.calls[0][1])).not.toContain(PHONE);

    const again = await POST(req({ answer: 'decline' }), { params });
    expect(again.status).toBe(409);
  });

  it('«Не могу» с сайта: 200, в тексте исход отправки заказчику; не дошло — признак attention', async () => {
    arm();
    requirePartnerMock.mockResolvedValue({ outcome: 'ok', partnerId: PARTNER, category: 'transfer', userId: 'u-shatun', seat: 'owner' });
    const { POST } = await import('@/app/api/hub/crm/charter-requests/[id]/answer/route');
    const ok = await (await POST(req({ answer: 'decline' }), { params })).json();
    expect(ok).toMatchObject({ success: true, outcome: 'charter_decline', attention: false });
    expect(ok.message).toBe('Ваш ответ: не могу. Заказчику ушло сообщение в MAX: ваш ответ.');

    arm();
    deliverMock.mockResolvedValue(UNDELIVERED);
    const warn = await (await POST(req({ answer: 'decline' }), { params })).json();
    expect(warn).toMatchObject({ success: true, attention: true });
    expect(warn.message).toContain('Заказчику сообщить не удалось');
    expect(answerTellPlain({ kind: 'charter_decline', notice: UNDELIVERED })).not.toMatch(/<b>/);
  });

  it('не перевозчик — 403 без чтения; гард не пропустил — его ответ; кривое тело — 400', async () => {
    const { POST } = await import('@/app/api/hub/crm/charter-requests/[id]/answer/route');
    requirePartnerMock.mockResolvedValue({ outcome: 'ok', partnerId: PARTNER, category: 'operator', userId: 'u', seat: 'owner' });
    expect((await POST(req({ answer: 'take' }), { params })).status).toBe(403);
    expect(pool).not.toHaveBeenCalled();
    requirePartnerMock.mockResolvedValue(NextResponse.json({ success: false }, { status: 401 }));
    expect((await POST(req({ answer: 'take' }), { params })).status).toBe(401);
    requirePartnerMock.mockResolvedValue({ outcome: 'ok', partnerId: PARTNER, category: 'transfer', userId: 'u', seat: 'owner' });
    expect((await POST(req({ answer: 'maybe' }), { params })).status).toBe(400);
    expect(pool).not.toHaveBeenCalled();
  });
});

describe('словарь «Входящих» и напоминания', () => {
  it('у перевозчика ждёт заявка на машину, снятого товара мест в ящике нет; вид в медиане и в напоминаниях; строки «ведёт менеджер» нет', () => {
    expect(INBOX_BY_CATEGORY.transfer).toEqual(['charter_request', 'charter_ride']);
    expect([...INBOX_KINDS]).not.toContain('transfer_seat_booking');
    expect(RESPONSE_METRIC_KINDS.has('charter_request')).toBe(true);
    expect([...INBOX_REMIND_KINDS]).toContain('charter_request');
    expect(INBOX_NOT_HERE.transfer.join(' ')).not.toMatch(/менеджер/);
  });

  it('CHECK таблицы напоминаний знает вид charter_request (миграция 1352), прежние исходы остаются', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/1352_charter_request_inbox_reminder.sql'), 'utf8');
    const check = /ADD CONSTRAINT crm_inbox_reminders_kind_check CHECK \(item_kind IN \(([\s\S]*?)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    // Виды на день 1352; charter_ride добавила 1353 (сторож — charter-ride-outcome), текущий список держит она.
    for (const kind of ['operator_booking', 'accommodation_booking', 'gear_rental', 'guide_invite', 'charter_request', 'transfer_seat_booking']) {
      expect(check![1], kind).toContain(`'${kind}'`);
    }
    expect([...INBOX_REMIND_KINDS]).toContain('charter_request');
  });
});

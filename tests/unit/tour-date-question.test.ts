// @vitest-environment node
/**
 * Вопрос оператору с формы брони сайта: «ходите ли вы в этот день?» (план
 * «после отказа», этап 6, срез б).
 *
 * Дату закрыл Ведар, а не оператор; бронь отвечает отказом, и до этого среза
 * человеку с сайта спросить оператора было нечем. Судится поведение — сервис
 * и дверь вызовом (CLAUDE.md §4, 13.10):
 *  - вопрос уходит ТОЛЬКО на дату, закрытую Ведаром; «не закрывал» и «не
 *    прочиталось» — разные исходы, и заявки нет ни в одном;
 *  - заявка та же, что у ИИ-агента: общий префикс (повтор узнаётся между
 *    дверями), строка оператору, отметка источника;
 *  - без согласия заявки нет; согласие записано с каналом формы тура;
 *  - ответ на повтор неотличим от ответа на новую заявку, а уведомления и
 *    переписку открывает только новая;
 *  - человеку не обещано, что оператор ответит: сказано, где появится ответ.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const queryMock = vi.hoisted(() => vi.fn());
const closedMock = vi.hoisted(() => vi.fn());
const findRecentMock = vi.hoisted(() => vi.fn());
const createLeadMock = vi.hoisted(() => vi.fn());
const personalMock = vi.hoisted(() => vi.fn());
const managerMock = vi.hoisted(() => vi.fn());
const deliveryMock = vi.hoisted(() => vi.fn());
const issueKeyMock = vi.hoisted(() => vi.fn());
const selfMock = vi.hoisted(() => vi.fn());
const predraftMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db-pool', () => ({ pool: { query: queryMock } }));
vi.mock('@/lib/tours/date-closure', () => ({ isClosedByPlatform: closedMock }));
vi.mock('@/lib/leads/create', () => ({ createLeadDetailed: createLeadMock, findRecentLeadByCommentPrefix: findRecentMock }));
vi.mock('@/lib/notifications/lead-notify', () => ({ notifyPartnerNewLeadPersonally: personalMock, notifyOperatorNewLead: managerMock }));
vi.mock('@/lib/leads/delivery-outcome', () => ({ recordPartnerDelivery: deliveryMock }));
vi.mock('@/lib/analytics/self-visit', () => ({ isSelfVisit: selfMock }));
vi.mock('@/lib/requests/operator-predraft', () => ({ operatorPredraft: predraftMock }));
vi.mock('@/lib/mcp/request-status', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/request-status')>()),
  issueRequestKey: issueKeyMock,
}));

import {
  askOperatorAboutDate, dateQuestionComment, dateQuestionRefusal, dateQuestionSentText, tourRequestPrefix,
  type DateQuestionInput,
} from '@/lib/requests/tour-date-question';
import { PLATFORM_CLOSED_LEAD_NOTE } from '@/lib/mcp/booking-closed-date';
import { POST } from '@/app/api/leads/tour-date-question/route';

const TOUR = { id: '27', title: 'Зимний Мутновский', operator_id: 'op-1', operator_name: 'Берег' };
const CONSENT = { at: new Date('2026-11-12T00:00:00Z'), ip: '203.0.113.5', source: 'tour-form', version: 'v' };
const INPUT: DateQuestionInput = {
  tourId: 27, date: '2027-02-10', participants: 2, name: 'Пётр Вопрос', phone: '+79001234567',
  comment: 'Поедем с детьми', consent: CONSENT, sourceUrl: 'https://vedarai.ru/catalog/tours/27',
};
const TODAY = () => '2026-11-12';

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue({ rows: [TOUR] });
  closedMock.mockResolvedValue(true);
  findRecentMock.mockResolvedValue(null);
  createLeadMock.mockResolvedValue({ id: 'lead-1', created: true });
  personalMock.mockResolvedValue({ state: 'sent', channel: 'max' });
  managerMock.mockResolvedValue({ ok: true });
  deliveryMock.mockResolvedValue(true);
  issueKeyMock.mockResolvedValue('key_abc');
  selfMock.mockReturnValue(false);
  predraftMock.mockResolvedValue(['На дату свободных мест в календаре: 0']);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('сервис: вопрос уходит только на дату, закрытую Ведаром', () => {
  it('дату закрыл Ведар — заявка оператору тура: тот же префикс, строка оператору, отметка источника, согласие', async () => {
    const out = await askOperatorAboutDate(INPUT, { today: TODAY });
    expect(out).toEqual({ state: 'sent', leadId: 'lead-1', created: true, tourTitle: TOUR.title, operatorId: 'op-1', operatorName: 'Берег' });
    expect(createLeadMock).toHaveBeenCalledTimes(1);
    const lead = createLeadMock.mock.calls[0]![0];
    expect(lead.comment.startsWith(tourRequestPrefix(TOUR.title, 27, '2027-02-10'))).toBe(true);
    expect(lead.comment).toContain(' участников 2.');
    expect(lead.comment).toContain(PLATFORM_CLOSED_LEAD_NOTE);
    expect(lead.comment.endsWith(' Поедем с детьми')).toBe(true);
    expect(lead).toMatchObject({
      name: 'Пётр Вопрос', phone: '+79001234567', route_title: TOUR.title, operator_id: 'op-1',
      source_url: INPUT.sourceUrl, pd_consent: CONSENT, is_self: false,
      source_data: { source: 'tour_page', form: 'tour-date-question', tour_id: '27', date: '2027-02-10', participants: 2, date_closed_by: 'platform' },
    });
    // Повтор ищется по тому же префиксу и телефону.
    expect(findRecentMock).toHaveBeenCalledWith('+79001234567', tourRequestPrefix(TOUR.title, '27', '2027-02-10'));
  });

  it('префикс заявки на тур на дату — один у формы сайта и у ИИ-агента', () => {
    expect(tourRequestPrefix('Т', 5, '2027-02-10')).toBe('[Заявка на бронь] Тур "Т" (ID5), дата 2027-02-10,');
    expect(dateQuestionComment({ tourTitle: 'Т', tourId: 5, date: '2027-02-10', participants: 3 }))
      .toBe(`[Заявка на бронь] Тур "Т" (ID5), дата 2027-02-10, участников 3.${PLATFORM_CLOSED_LEAD_NOTE}`);
  });

  it('дату Ведар не закрывал (открыта, занята, закрыл оператор) — заявки нет, исход назван', async () => {
    closedMock.mockResolvedValue(false);
    expect(await askOperatorAboutDate(INPUT, { today: TODAY })).toEqual({ state: 'not_platform_closed' });
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(findRecentMock).not.toHaveBeenCalled();
  });

  it('кто закрыл, не прочиталось — «не знаю», а не «закрыл Ведар»: заявки нет', async () => {
    closedMock.mockResolvedValue(null);
    expect(await askOperatorAboutDate(INPUT, { today: TODAY })).toEqual({ state: 'unknown' });
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('тур не прочитан — «не знаю» и строка в лог с SQLSTATE; тура нет на витрине — «нет тура»', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('db'), { code: '57014' }));
    expect(await askOperatorAboutDate(INPUT, { today: TODAY })).toEqual({ state: 'unknown' });
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/тур 27 не прочитан.*57014/);
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await askOperatorAboutDate(INPUT, { today: TODAY })).toEqual({ state: 'no_tour' });
    expect(closedMock).not.toHaveBeenCalled();
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('несуществующая и прошедшая дата — до базы дело не доходит', async () => {
    expect(await askOperatorAboutDate({ ...INPUT, date: '2027-02-30' }, { today: TODAY })).toEqual({ state: 'bad_date' });
    expect(await askOperatorAboutDate({ ...INPUT, date: '2026-11-11' }, { today: TODAY })).toEqual({ state: 'past' });
    expect(queryMock).not.toHaveBeenCalled();
    // Сегодняшняя дата — ещё не прошедшая.
    expect((await askOperatorAboutDate({ ...INPUT, date: '2026-11-12' }, { today: TODAY })).state).toBe('sent');
  });

  it('повтор (тот же телефон, тур и дата) — прежняя заявка, второй нет', async () => {
    findRecentMock.mockResolvedValue('lead-old');
    expect(await askOperatorAboutDate(INPUT, { today: TODAY })).toMatchObject({ state: 'sent', leadId: 'lead-old', created: false });
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('заявка не записалась — «не удалось», а не «отправлено»', async () => {
    createLeadMock.mockResolvedValue(null);
    expect(await askOperatorAboutDate(INPUT, { today: TODAY })).toEqual({ state: 'failed' });
  });

  it('слова: у каждого исхода без заявки — свой отказ; человеку не обещан ответ оператора', () => {
    expect(dateQuestionRefusal({ state: 'sent', leadId: 'x', created: true, tourTitle: 'Т', operatorId: null, operatorName: null })).toBeNull();
    expect(dateQuestionRefusal({ state: 'not_platform_closed' })).toMatchObject({ status: 409, error: expect.stringContaining('Ведар не закрывал') });
    expect(dateQuestionRefusal({ state: 'unknown' })).toMatchObject({ status: 503, error: expect.stringContaining('вопрос не отправлен') });
    expect(dateQuestionRefusal({ state: 'failed' })?.status).toBe(503);
    expect(dateQuestionRefusal({ state: 'no_tour' })?.status).toBe(404);
    expect(dateQuestionRefusal({ state: 'past' })).toMatchObject({ status: 422, field: 'date' });
    expect(dateQuestionRefusal({ state: 'bad_date' })).toMatchObject({ status: 400, field: 'date' });
    for (const hasPage of [true, false]) {
      const text = dateQuestionSentText(hasPage);
      expect(text).toContain('Это не бронь — места не закреплены.');
      expect(text).not.toMatch(/перезвонит|ответит в течение|обязательно|подтвердит/);
    }
    expect(dateQuestionSentText(true)).toContain('появится на странице заявки');
    expect(dateQuestionSentText(false)).toContain('Страница заявки не выдалась');
  });
});

function post(body: Record<string, unknown>, ip = '203.0.113.5'): NextRequest {
  return new Request('https://vedarai.ru/api/leads/tour-date-question', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
const BODY = { tour_id: 27, date: '2099-02-10', participants: 2, name: 'Пётр Вопрос', phone: '8 900 123-45-67', comment: 'Поедем с детьми', pd_consent: true };
/** Уведомления идут после ответа, не дожидаясь его: даём им отработать. */
const settle = () => new Promise((r) => setTimeout(r, 20));
let ipSeq = 0;
/** Свой адрес на вызов: ограничитель частоты двери считает по адресу. */
const freshIp = () => `198.51.100.${(ipSeq += 1)}`;

describe('дверь POST /api/leads/tour-date-question', () => {
  it('новая заявка: человеку — что это вопрос, а не бронь, и страница заявки; оператору — лично; менеджеру — исход доставки', async () => {
    const res = await POST(post(BODY, freshIp()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.message).toContain('Вопрос отправлен оператору');
    expect(json.data.message).toContain('Это не бронь — места не закреплены.');
    expect(json.data.page).toContain('key_abc');
    // Номера заявки в ответе нет.
    expect(JSON.stringify(json)).not.toContain('lead-1');

    const lead = createLeadMock.mock.calls[0]![0];
    expect(lead.phone).toBe('+79001234567');
    expect(lead.pd_consent).toMatchObject({ source: 'tour-form' });
    expect(lead.pd_consent.at).toBeInstanceOf(Date);
    // Переписку открывает ключ новой заявки.
    expect(issueKeyMock).toHaveBeenCalledWith({ leadId: 'lead-1' }, 'partner-lead-form', { opensChat: true });

    await settle();
    expect(personalMock).toHaveBeenCalledTimes(1);
    expect(personalMock.mock.calls[0]![0]).toMatchObject({
      operatorId: 'op-1', leadId: 'lead-1', name: 'Пётр Вопрос', phone: '+79001234567',
      routeTitle: TOUR.title, origin: 'форма брони тура на Ведаре', predraft: ['На дату свободных мест в календаре: 0'],
    });
    expect(personalMock.mock.calls[0]![0].comment).toContain(PLATFORM_CLOSED_LEAD_NOTE);
    expect(deliveryMock).toHaveBeenCalledWith('lead-1', 'op-1', { state: 'sent', channel: 'max' });
    expect(managerMock.mock.calls[0]![0]).toMatchObject({ leadId: 'lead-1', forPartner: { name: 'Берег', outcome: { state: 'sent', channel: 'max' } } });
  });

  it('без согласия заявки нет: 400 у галочки, в базу и в уведомления ничего не уходит', async () => {
    for (const consent of [undefined, false, 'true']) {
      const res = await POST(post({ ...BODY, pd_consent: consent }, freshIp()));
      expect(res.status).toBe(400);
      expect((await res.json()).field).toBe('pd_consent');
    }
    expect(queryMock).not.toHaveBeenCalled();
    expect(createLeadMock).not.toHaveBeenCalled();
    await settle();
    expect(personalMock).not.toHaveBeenCalled();
  });

  it('телефон не номер — 400 у телефона, заявки нет', async () => {
    const res = await POST(post({ ...BODY, phone: '12345' }, freshIp()));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('phone');
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('дату Ведар не закрывал — 409 словами; заявки, ключа и уведомлений нет', async () => {
    closedMock.mockResolvedValue(false);
    const res = await POST(post(BODY, freshIp()));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain('Ведар не закрывал');
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(issueKeyMock).not.toHaveBeenCalled();
    await settle();
    expect(personalMock).not.toHaveBeenCalled();
    expect(managerMock).not.toHaveBeenCalled();
  });

  it('кто закрыл, не прочиталось — 503 «вопрос не отправлен», заявки нет', async () => {
    closedMock.mockResolvedValue(null);
    const res = await POST(post(BODY, freshIp()));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('вопрос не отправлен');
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('повтор отвечает тем же, что новая заявка, но оператора второй раз не будит и переписку не открывает', async () => {
    const first = await (await POST(post(BODY, freshIp()))).json();
    await settle();
    vi.clearAllMocks();
    issueKeyMock.mockResolvedValue('key_abc');
    findRecentMock.mockResolvedValue('lead-1');
    const again = await POST(post(BODY, freshIp()));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(issueKeyMock).toHaveBeenCalledWith({ leadId: 'lead-1' }, 'partner-lead-form', { opensChat: false });
    await settle();
    expect(personalMock).not.toHaveBeenCalled();
    expect(managerMock).not.toHaveBeenCalled();
  });

  it('своя проба владельца — заявка с пометкой, без уведомлений и без переписки', async () => {
    selfMock.mockReturnValue(true);
    const res = await POST(post(BODY, freshIp()));
    expect(res.status).toBe(200);
    expect(createLeadMock.mock.calls[0]![0].is_self).toBe(true);
    expect(issueKeyMock).toHaveBeenCalledWith({ leadId: 'lead-1' }, 'partner-lead-form', { opensChat: false });
    await settle();
    expect(personalMock).not.toHaveBeenCalled();
    expect(managerMock).not.toHaveBeenCalled();
  });

  it('у тура нет оператора — заявка менеджеру: личной доставки нет, исход ей не выдуман', async () => {
    queryMock.mockResolvedValue({ rows: [{ ...TOUR, operator_id: null, operator_name: null }] });
    const res = await POST(post(BODY, freshIp()));
    expect(res.status).toBe(200);
    await settle();
    expect(personalMock).not.toHaveBeenCalled();
    expect(deliveryMock).not.toHaveBeenCalled();
    expect(managerMock.mock.calls[0]![0].forPartner).toBeUndefined();
  });

  it('страница заявки не выдалась — сказано словами, а не ссылкой в никуда', async () => {
    issueKeyMock.mockResolvedValue(null);
    const json = await (await POST(post(BODY, freshIp()))).json();
    expect(json.success).toBe(true);
    expect(json.data.page).toBeNull();
    expect(json.data.message).toContain('Страница заявки не выдалась');
  });

  it('шестой запрос с одного адреса за минуту — 429, заявки нет', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i += 1) expect((await POST(post(BODY, ip))).status).toBe(200);
    createLeadMock.mockClear();
    const res = await POST(post(BODY, ip));
    expect(res.status).toBe(429);
    expect(createLeadMock).not.toHaveBeenCalled();
  });
});

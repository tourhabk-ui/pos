// @vitest-environment node
/**
 * Слова клиента не по-русски — адресату заявки с переводом (слово владельца
 * 13.11: «когда иностранцы обращаются к оператору, то нужно для оператора
 * переводить на русский»).
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * 1. Строки перевода: по строке на часть не по-русски; русская часть модель
 *    не зовёт; перевод назван машинным; отказ и опоздание сказаны словами, а
 *    не тишиной; текст клиента в лог не уходит; длинный текст режется.
 * 2. Четыре сообщения адресату — заявка на тур, на машину, на прокат, на
 *    жильё: перевод стоит РЯДОМ со словами клиента и только в сообщении с ПД
 *    (MAX). В заглушке Telegram нет ни слов клиента, ни перевода.
 * 3. У заявки на тур переводятся слова клиента, а не служебная часть
 *    комментария.
 *
 * Судится поведение: функции зовутся с подставной моделью и подставной
 * отправкой, проверяется то, что уходит адресату.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { callAIQualityOrNull, reachMock, pdMock, teamMock, query } = vi.hoisted(() => ({
  callAIQualityOrNull: vi.fn(), reachMock: vi.fn(), pdMock: vi.fn(), teamMock: vi.fn(), query: vi.fn(),
}));
vi.mock('@/lib/ai/providers', () => ({ callAIQualityOrNull, callAIFastOrNull: vi.fn() }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: reachMock }));
vi.mock('@/lib/operators/team-notify', () => ({ notifyTeam: teamMock }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: pdMock }));
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/crm/contacts', () => ({ linkContactQuietly: vi.fn(async () => undefined) }));
vi.mock('@/lib/leads/create', () => ({
  createLead: vi.fn(async () => 'lead-new'),
  createLeadDetailed: vi.fn(async () => ({ id: '55555555-5555-4555-8555-555555555555', created: true })),
  findRecentLeadByCommentPrefix: vi.fn(async () => null),
}));
vi.mock('@/lib/leads/delivery-outcome', () => ({ recordPartnerDelivery: vi.fn(async () => undefined) }));

import {
  clientTranslationLines, NOTICE_TRANSLATE_SOURCE_MAX, NOTICE_TRANSLATE_TIMEOUT_MS,
} from '@/lib/requests/foreign-text';
import type { TranslationOutcome } from '@/lib/ai/translate-text';
import { notifyPartnerNewLeadPersonally } from '@/lib/notifications/lead-notify';
import { notifyPartnerRequestPersonally, partnerRequestTexts, type PartnerRequestNotice } from '@/lib/notifications/partner-request-notify';
import { stayRequestTexts } from '@/lib/stay/stay-request';
import { saveCharterLead } from '@/lib/transfers/charter-request-service';
import { planCharterRequest } from '@/lib/transfers/charter-request';
import type { CharterCarrier } from '@/lib/transfers/charter-format';
import { submitStayRequest } from '@/lib/stay/stay-request-service';

const ZH = '我们2个人，想带小孩，需要中文向导';
const RU = 'Нас 2 человека, хотим взять ребёнка, нужен гид со знанием китайского';
const ZH_DEST = '穆特诺夫斯基火山';
const RU_DEST = 'вулкан Мутновский';

const ok = (text: string): TranslationOutcome => ({ status: 'translated', text, model: 'ai-quality' });
const fake = (map: Record<string, TranslationOutcome>) =>
  vi.fn(async (text: string): Promise<TranslationOutcome> => map[text] ?? { status: 'failed', reason: 'нет в подставных переводах' });
/** Модель отвечает переводом по исходнику сегмента. */
function modelAnswers(map: Record<string, string>) {
  callAIQualityOrNull.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
    const { segments } = JSON.parse(messages.find((m) => m.role === 'user')!.content) as { segments: string[] };
    const ru = map[segments[0]];
    return ru === undefined ? null : JSON.stringify({ segments: [ru] });
  });
}
type PdArgs = { text: string; stub: string; to?: unknown };
const pdCalls = () => pdMock.mock.calls.map((c) => c[0] as PdArgs);

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  for (const m of [callAIQualityOrNull, reachMock, pdMock, teamMock, query]) m.mockReset();
  reachMock.mockResolvedValue({ maxChatId: '111', telegramChatId: '222', telegramSource: 'partner', reachable: true, category: 'operator' });
  pdMock.mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
  teamMock.mockResolvedValue(undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  vi.useRealTimers();
});

describe('строки перевода для адресата', () => {
  it('всё по-русски или пусто — строк нет, переводчик не зовётся', async () => {
    const translate = fake({});
    expect(await clientTranslationLines(
      [{ what: 'комментарий', text: 'Нужен трансфер из аэропорта' }, { what: 'пожелания', text: null }, { what: 'направление', text: '  ' }],
      'заявка L-1', { translate },
    )).toEqual([]);
    expect(translate).not.toHaveBeenCalled();
  });

  it('по строке на часть не по-русски, в порядке частей; русская часть пропущена', async () => {
    const translate = fake({ [ZH_DEST]: ok(RU_DEST), [ZH]: ok(RU) });
    expect(await clientTranslationLines(
      [{ what: 'направление', text: ZH_DEST }, { what: 'даты', text: 'с 10 по 12 июля' }, { what: 'пожелания', text: ZH }],
      'заявка L-1', { translate },
    )).toEqual([
      `Перевод (машинный), направление: ${RU_DEST}`,
      `Перевод (машинный), пожелания: ${RU}`,
    ]);
    expect(translate.mock.calls.map((c) => c[0])).toEqual([ZH_DEST, ZH]);
  });

  it('перевод не получен — сказано словами; в лог идёт род причины без слов клиента', async () => {
    const translate = fake({ [ZH]: { status: 'failed', reason: 'ответ модели не той формы: JSON не разобран: Unexpected token «Меня зовут Ван Вэй»' } });
    expect(await clientTranslationLines([{ what: 'комментарий', text: ZH }], 'заявка L-1', { translate }))
      .toEqual(['Комментарий не по-русски; машинный перевод не получен.']);
    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('заявка L-1');
    expect(logged).toContain('ответ модели не той формы');
    expect(logged).not.toContain('Ван Вэй');
    expect(logged).not.toContain(ZH);
  });

  it('переводчик упал или сказал «переводить нечего» — та же честная строка, заявка не падает', async () => {
    const boom = vi.fn(async (): Promise<TranslationOutcome> => { throw new Error('socket hang up'); });
    expect(await clientTranslationLines([{ what: 'пожелания', text: ZH }], 'заявка L-2', { translate: boom }))
      .toEqual(['Пожелания не по-русски; машинный перевод не получен.']);
    const odd = vi.fn(async (): Promise<TranslationOutcome> => ({ status: 'not_needed' }));
    expect(await clientTranslationLines([{ what: 'пожелания', text: ZH }], 'заявка L-2', { translate: odd }))
      .toEqual(['Пожелания не по-русски; машинный перевод не получен.']);
  });

  it('перевод опоздал — заявка его не ждёт', async () => {
    vi.useFakeTimers();
    const never = vi.fn((): Promise<TranslationOutcome> => new Promise(() => {}));
    const lines = clientTranslationLines([{ what: 'комментарий', text: ZH }], 'заявка L-3', { translate: never });
    await vi.advanceTimersByTimeAsync(NOTICE_TRANSLATE_TIMEOUT_MS + 1);
    expect(await lines).toEqual(['Комментарий не по-русски; машинный перевод не получен.']);
    expect(errSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/не уложился/);
  });

  it('длинный текст: на перевод идёт начало, и это сказано', async () => {
    const long = '火'.repeat(NOTICE_TRANSLATE_SOURCE_MAX + 50);
    const translate = vi.fn(async (text: string): Promise<TranslationOutcome> => ok(`Огонь ×${text.length}`));
    const lines = await clientTranslationLines([{ what: 'комментарий', text: long }], 'заявка L-4', { translate });
    expect((translate.mock.calls[0][0] as string).length).toBe(NOTICE_TRANSLATE_SOURCE_MAX);
    expect(lines).toEqual([`Перевод (машинный), комментарий: Огонь ×${NOTICE_TRANSLATE_SOURCE_MAX} … (переведено начало текста)`]);
  });

  it('настоящий переводчик: телефон клиента в модель не уходит', async () => {
    const withPhone = `${ZH}，电话 +86 138 0013 8000`;
    callAIQualityOrNull.mockResolvedValue(JSON.stringify({ segments: [`${RU}, телефон [телефон]`] }));
    const lines = await clientTranslationLines([{ what: 'комментарий', text: withPhone }], 'заявка L-5');
    expect(lines).toEqual([`Перевод (машинный), комментарий: ${RU}, телефон [телефон]`]);
    const user = (callAIQualityOrNull.mock.calls[0][0] as Array<{ role: string; content: string }>).find((m) => m.role === 'user')!;
    expect(user.content).not.toContain('138');
  });
});

describe('заявка на тур: оператору — слова клиента с переводом', () => {
  const base = { operatorId: 'op-1', leadId: '11111111-1111-4111-8111-111111111111', name: 'Ван Вэй', phone: '+8613800138000', routeTitle: 'Вулкан Мутновский' };
  const composite = `Заявка на тур «Вулкан Мутновский» (#12) на 2026-11-17, участников 2. ${ZH}`;

  it('перевод стоит под комментарием в сообщении для MAX; в заглушке Telegram его нет', async () => {
    modelAnswers({ [ZH]: RU });
    await notifyPartnerNewLeadPersonally({ ...base, comment: composite, clientText: ZH });
    const { text, stub } = pdCalls()[0];
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.startsWith('<b>Комментарий:</b>'));
    expect(lines[at]).toContain(ZH);
    expect(lines[at + 1]).toBe(`Перевод (машинный), комментарий: ${RU}`);
    expect(stub).not.toContain(RU);
    expect(stub).not.toContain(ZH);
    expect(stub).not.toContain('Перевод');
    // Копия команде кабинета — тот же текст и та же заглушка.
    const team = teamMock.mock.calls[0][1] as { text: string; stub: string };
    expect(team.text).toContain(`Перевод (машинный), комментарий: ${RU}`);
    expect(team.stub).not.toContain('Перевод');
  });

  it('в модель уходят слова клиента, а не служебная часть комментария', async () => {
    modelAnswers({ [ZH]: RU });
    await notifyPartnerNewLeadPersonally({ ...base, comment: composite, clientText: ZH });
    expect(callAIQualityOrNull).toHaveBeenCalledTimes(1);
    const user = (callAIQualityOrNull.mock.calls[0][0] as Array<{ role: string; content: string }>).find((m) => m.role === 'user')!;
    expect(JSON.parse(user.content)).toEqual({ segments: [ZH] });
  });

  it('слова клиента по-русски — модель не зовётся, строки перевода нет', async () => {
    await notifyPartnerNewLeadPersonally({ ...base, comment: 'Заявка на тур … участников 2. Нужен детский спасжилет', clientText: 'Нужен детский спасжилет' });
    expect(callAIQualityOrNull).not.toHaveBeenCalled();
    expect(pdCalls()[0].text).not.toContain('Перевод');
  });

  it('форма сайта без отдельных слов клиента — судится сам комментарий', async () => {
    modelAnswers({ [ZH]: RU });
    await notifyPartnerNewLeadPersonally({ ...base, comment: ZH });
    expect(pdCalls()[0].text).toContain(`Перевод (машинный), комментарий: ${RU}`);
  });

  it('модель не ответила — заявка всё равно доставлена, и про перевод сказано честно', async () => {
    callAIQualityOrNull.mockResolvedValue(null);
    const out = await notifyPartnerNewLeadPersonally({ ...base, comment: composite, clientText: ZH });
    expect(out).toEqual({ state: 'delivered', channel: 'max' });
    expect(pdCalls()[0].text).toContain('Комментарий не по-русски; машинный перевод не получен.');
    expect(pdCalls()[0].text).toContain(ZH);
  });

  it('перевод экранирован: текст уходит как HTML', async () => {
    modelAnswers({ [ZH]: 'Нужен гид <b>и</b> переводчик & 2 места' });
    await notifyPartnerNewLeadPersonally({ ...base, comment: composite, clientText: ZH });
    expect(pdCalls()[0].text).toContain('Перевод (машинный), комментарий: Нужен гид &lt;b&gt;и&lt;/b&gt; переводчик &amp; 2 места');
  });
});

describe('заявка на машину и на прокат: партнёру — направление и пожелания с переводом', () => {
  const notice: PartnerRequestNotice = {
    partnerId: 'p-1', leadId: '22222222-2222-4222-8222-222222222222', kind: 'charter',
    lines: [`Направление: ${ZH_DEST}`, 'Даты: с 2027-07-10 по 2027-07-12', 'Человек: 10'],
    name: 'Ван Вэй', phone: '+8613800138000', comment: ZH,
  };

  it('текст для MAX несёт перевод после пожеланий; заглушка — нет', () => {
    const tr = [`Перевод (машинный), направление: ${RU_DEST}`, `Перевод (машинный), пожелания: ${RU}`];
    const { text, stub } = partnerRequestTexts(notice, tr);
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.startsWith('<b>Пожелания:</b>'));
    expect(lines.slice(at + 1, at + 3)).toEqual(tr);
    expect(stub).not.toContain('Перевод');
    // Без перевода текст прежний: строк не прибавилось.
    expect(partnerRequestTexts(notice).text.split('\n')).toHaveLength(lines.length - 2);
  });

  it('перевозчику: направление и пожелания не по-русски — оба переведены и ушли только в MAX', async () => {
    modelAnswers({ [ZH_DEST]: RU_DEST, [ZH]: RU });
    await notifyPartnerRequestPersonally({ ...notice, foreign: [{ what: 'направление', text: ZH_DEST }, { what: 'пожелания', text: ZH }] });
    const { text, stub } = pdCalls()[0];
    expect(text).toContain(`Перевод (машинный), направление: ${RU_DEST}`);
    expect(text).toContain(`Перевод (машинный), пожелания: ${RU}`);
    expect(stub).not.toContain('Перевод');
    expect(stub).not.toContain(RU);
  });

  it('сервис заявки на машину называет направление и пожелания частями для перевода', async () => {
    modelAnswers({ [ZH_DEST]: RU_DEST, [ZH]: RU });
    const carrier: CharterCarrier = {
      partnerId: 'p-1', slug: 'carrier', name: 'Перевозчик', shortDescription: null, logo: null,
      vehicles: [{ kind: 'minibus', title: 'Ford Transit', seats: 17 }],
      destinations: [], extraDay: null, seatClasses: [],
      rates: [{ unit: 'day', vehicleKind: 'minibus', priceRub: 25000, note: null, conditions: null, validYear: null }],
    };
    const plan = planCharterRequest(carrier, ZH_DEST, 4);
    const id = await saveCharterLead({
      facts: { carrier, plan, destination: ZH_DEST, dateFrom: '2027-07-10', dateTo: '2027-07-12', passengers: 4, comment: ZH } as never,
      lead: { comment: '[Заявка на машину] …', sourceData: { kind: 'charter' } },
      name: 'Ван Вэй', phone: '+8613800138000', consent: null, isSelf: false, sourceUrl: 'https://vedarai.ru/transfers/carrier',
    } as never);
    expect(id).toBe('55555555-5555-4555-8555-555555555555');
    // Доставка перевозчику не ждёт ответа человеку.
    await vi.waitFor(() => expect(pdMock).toHaveBeenCalledTimes(1));
    expect(pdCalls()[0].text).toContain(`Перевод (машинный), направление: ${RU_DEST}`);
    expect(pdCalls()[0].text).toContain(`Перевод (машинный), пожелания: ${RU}`);
  });

  it('прокатчику частей не названо — переводятся пожелания; русские не трогаются', async () => {
    modelAnswers({ [ZH]: RU });
    await notifyPartnerRequestPersonally({ ...notice, kind: 'car_rental', lines: ['Машина: Toyota Prado'], companySlug: 'x' });
    expect(pdCalls()[0].text).toContain(`Перевод (машинный), пожелания: ${RU}`);

    pdMock.mockClear();
    callAIQualityOrNull.mockClear();
    await notifyPartnerRequestPersonally({ ...notice, kind: 'car_rental', lines: ['Машина: Toyota Prado'], comment: 'Нужно детское кресло' });
    expect(callAIQualityOrNull).not.toHaveBeenCalled();
    expect(pdCalls()[0].text).not.toContain('Перевод');
  });
});

describe('заявка на жильё: хозяину — комментарий гостя с переводом', () => {
  const message = {
    accommodationName: 'Гостевой дом', checkIn: '2026-12-01', checkOut: '2026-12-04', nights: 3, guests: 2,
    guestName: 'Ван Вэй', guestPhone: '+8613800138000', comment: ZH, priceFrom: 5000, priceTo: null,
  };

  it('перевод — под комментарием в тексте для MAX; в обеих заглушках его нет', () => {
    const { text, ownerStub, platformStub } = stayRequestTexts({ ...message, translation: [`Перевод (машинный), комментарий: ${RU}`] });
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.startsWith('Комментарий:'));
    expect(lines[at + 1]).toBe(`Перевод (машинный), комментарий: ${RU}`);
    for (const stub of [ownerStub, platformStub]) {
      expect(stub).not.toContain('Перевод');
      expect(stub).not.toContain(ZH);
    }
  });

  it('сервис заявки: комментарий не по-русски уходит хозяину и платформе с переводом', async () => {
    modelAnswers({ [ZH]: RU });
    query.mockImplementation((sql: string) => {
      const q = String(sql);
      if (/FROM accommodations a/.test(q)) return Promise.resolve({ rows: [{ name: 'Гостевой дом', price_from: '5000', price_to: null, max_chat_id: '111', telegram_chat_id: null }] });
      if (/INSERT INTO stay_requests/.test(q)) return Promise.resolve({ rows: [{ id: '33333333-3333-4333-8333-333333333333' }] });
      return Promise.resolve({ rows: [] });
    });
    const out = await submitStayRequest({
      accommodationId: '44444444-4444-4444-8444-444444444444', checkIn: '2026-12-01', checkOut: '2026-12-04', nights: 3, guests: 2,
      guestName: 'Ван Вэй', guestPhone: '+8613800138000', comment: ZH,
      consent: { at: new Date('2026-11-13T00:00:00Z'), ip: '127.0.0.1', source: 'mcp', version: 'v' } as never, door: 'mcp',
    });
    expect(out).toMatchObject({ ok: true, delivered: 'owner' });
    // Хозяину и оператору платформы — один текст с переводом.
    expect(pdCalls()).toHaveLength(2);
    for (const call of pdCalls()) {
      expect(call.text).toContain(`Комментарий: ${ZH}`);
      expect(call.text).toContain(`Перевод (машинный), комментарий: ${RU}`);
      expect(call.stub).not.toContain('Перевод');
    }
    // Заявка записана ДО перевода: модель её не держит и не теряет.
    const insertAt = query.mock.invocationCallOrder[query.mock.calls.findIndex((c) => /INSERT INTO stay_requests/.test(String(c[0])))];
    expect(insertAt).toBeLessThan(callAIQualityOrNull.mock.invocationCallOrder[0]);
  });

  it('комментарий по-русски — модель не зовётся', async () => {
    query.mockImplementation((sql: string) => {
      const q = String(sql);
      if (/FROM accommodations a/.test(q)) return Promise.resolve({ rows: [{ name: 'Гостевой дом', price_from: null, price_to: null, max_chat_id: '111', telegram_chat_id: null }] });
      if (/INSERT INTO stay_requests/.test(q)) return Promise.resolve({ rows: [{ id: '33333333-3333-4333-8333-333333333333' }] });
      return Promise.resolve({ rows: [] });
    });
    await submitStayRequest({
      accommodationId: '44444444-4444-4444-8444-444444444444', checkIn: '2026-12-01', checkOut: '2026-12-04', nights: 3, guests: 2,
      guestName: 'Анна', guestPhone: '+79001234567', comment: 'Приедем поздно вечером',
      consent: { at: new Date('2026-11-13T00:00:00Z'), ip: '127.0.0.1', source: 'form', version: 'v' } as never, door: 'form',
    });
    expect(callAIQualityOrNull).not.toHaveBeenCalled();
    expect(pdCalls()[0].text).not.toContain('Перевод');
  });
});

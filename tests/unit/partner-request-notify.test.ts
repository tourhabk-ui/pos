// @vitest-environment node
/**
 * Заявка на машину и на прокат — лично перевозчику или прокатчику в его
 * MAX/Telegram (23.10, «Лагуна Прокат»). До этого дня три двери (форма
 * перевозчика, форма проката, MCP request_charter) после записи ничего партнёру
 * не слали: заявку видел менеджер и CRM, а партнёр — никто.
 *
 * Сторож держит вызовом:
 *   · адрес — только партнёра (`to`), без отката на рабочий чат платформы;
 *   · ПД заказчика — только в тексте для MAX; заглушка для Telegram без ПД и
 *     без слов про кабинет (у перевозчика и прокатчика кабинета заявок нет);
 *   · у заявки на машину кнопок нет; у проката пилота — «Беру» / «Не могу»
 *     (payload, без url: в заглушку Telegram такие кнопки не попадают);
 *   · исходов четыре: доставлено / заглушка / нет канала / адрес не прочитался;
 *   · факты для партнёра — без его телефона и без заметок менеджеру;
 *   · оба сервиса записи зовут доставку после createLead, пишут исход в журнал
 *     лида, а повтор и свой визит владельца партнёра не будят; отказ доставки
 *     не роняет запись и уходит в лог без ПД.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { reachMock, pdMock, createLeadMock, recentLeadMock, recordMock } = vi.hoisted(() => ({
  reachMock: vi.fn(), pdMock: vi.fn(), createLeadMock: vi.fn(), recentLeadMock: vi.fn(), recordMock: vi.fn(),
}));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: reachMock }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: pdMock }));
vi.mock('@/lib/leads/create', () => ({
  createLead: (...a: unknown[]) => createLeadMock(...a),
  createLeadDetailed: async (...a: unknown[]) => { const id = await createLeadMock(...a); return id ? { id, created: true } : null; },
  findRecentLeadByCommentPrefix: (...a: unknown[]) => recentLeadMock(...a),
}));
vi.mock('@/lib/leads/delivery-outcome', () => ({ recordPartnerDelivery: (...a: unknown[]) => recordMock(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { notifyPartnerRequestPersonally, partnerRequestButtons, partnerRequestTexts, type PartnerRequestNotice } from '@/lib/notifications/partner-request-notify';
import { charterRequestLines, planCharterRequest, type CharterRequestFacts } from '@/lib/transfers/charter-request';
import { rentalRequestLines, type RentalRequestFacts } from '@/lib/rental/rental-request';
import { saveCharterLead } from '@/lib/transfers/charter-request-service';
import { saveRentalLead } from '@/lib/rental/rental-request-service';
import type { CharterCarrier } from '@/lib/transfers/charter-format';
import type { RentalOffer } from '@/lib/rental/rental-format';

const BOUND = { maxChatId: '111', telegramChatId: '222', telegramSource: 'partner' as const, reachable: true };
type PdArgs = { text: string; stub: string; buttons?: unknown[]; to?: { maxChatId?: unknown; telegramChatId?: unknown } };
const lastPd = () => pdMock.mock.calls[pdMock.mock.calls.length - 1]![0] as PdArgs;

const NOTICE: PartnerRequestNotice = {
  partnerId: 'p-lp', leadId: 'lead-7', kind: 'charter',
  lines: ['Направление: Авачинский перевал', 'Даты: с 2027-07-10 по 2027-07-12', 'Человек: 10'],
  name: 'Анна Петрова', phone: '+79001234567', comment: 'С палатками <и> рюкзаками',
};

const CARRIER: CharterCarrier = {
  partnerId: 'p-lp', slug: 'laguna-prokat', name: 'Лагуна Прокат', shortDescription: null, logo: null,
  vehicles: [{ kind: 'minibus', title: 'Ford Transit', seats: 17 }, { kind: 'vahtovka', title: 'Урал', seats: 25 }],
  destinations: [], extraDay: null, seatClasses: [],
  rates: [
    { unit: 'day', vehicleKind: 'minibus', priceRub: 25000, note: null, conditions: null, validYear: null },
    { unit: 'day', vehicleKind: 'vahtovka', priceRub: 50000, note: null, conditions: null, validYear: null },
  ],
  photos: [], clips: [], legal: null, video: null,
  phone: '+79060835070', telegramHref: null, whatsappHref: null,
};

const OFFER: RentalOffer = {
  id: 'o-1', title: 'Suzuki Jimny', bodyKind: 'suv', seats: 4, transmission: 'automatic', drive: '4wd', engineHp: 105,
  priceRubPerDay: 7000, priceIsFrom: false, depositRub: 15000, driver: 'self', conditions: null, sourceUrl: null, pricesSeenOn: null, photo: null,
};

function charterFacts(over: Partial<CharterRequestFacts> = {}): CharterRequestFacts {
  const plan = planCharterRequest(CARRIER, 'Авачинский перевал', 10);
  if (plan.kind !== 'rated') throw new Error('ожидался rated');
  return { carrier: CARRIER, plan, destination: 'Авачинский перевал', dateFrom: '2027-07-10', dateTo: '2027-07-12', passengers: 10, comment: 'С палатками', ...over };
}

function rentalFacts(over: Partial<RentalRequestFacts> = {}): RentalRequestFacts {
  return {
    company: { partnerId: 'p-lp', slug: 'laguna-prokat', name: 'Лагуна Прокат', phone: '+79060835070' },
    offer: OFFER, dateFrom: '2027-07-10', dateTo: '2027-07-12', days: 3, comment: null, ...over,
  };
}

beforeEach(() => {
  reachMock.mockReset();
  pdMock.mockReset().mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
  createLeadMock.mockReset().mockResolvedValue('lead-7');
  recentLeadMock.mockReset().mockResolvedValue(null);
  recordMock.mockReset().mockResolvedValue(true);
});

describe('тексты: ПД только для MAX, заглушка без ПД и без кабинета', () => {
  it('текст несёт факты, имя, телефон и пожелания (экранированные); заглушка — факты и номер заявки, но не ПД', () => {
    const { text, stub } = partnerRequestTexts(NOTICE);
    expect(text).toContain('Новая заявка на машину с Ведара');
    expect(text).toContain('Направление: Авачинский перевал');
    expect(text).toContain('Анна Петрова');
    expect(text).toContain('+79001234567');
    expect(text).toContain('С палатками &lt;и&gt; рюкзаками');
    expect(text).toContain('Менеджер Ведара согласует заказ с вами');

    expect(stub).toContain('Направление: Авачинский перевал');
    expect(stub).toContain('lead-7');
    expect(stub).not.toContain('Анна');
    expect(stub).not.toContain('79001234567');
    expect(stub).not.toContain('палатками');
    expect(stub).not.toMatch(/кабинет/i);
    expect(stub).toContain('Контакты заказчика — у менеджера Ведара');
  });

  it('заголовок по роду заявки', () => {
    expect(partnerRequestTexts({ ...NOTICE, kind: 'car_rental' }).text).toContain('Новая заявка на прокат с Ведара');
  });
});

describe('доставка: адрес партнёра, четыре исхода', () => {
  it('привязан → ПД в его MAX строго по адресу, без кнопок', async () => {
    reachMock.mockResolvedValue(BOUND);
    expect(await notifyPartnerRequestPersonally(NOTICE)).toEqual({ state: 'delivered', channel: 'max' });
    expect(reachMock).toHaveBeenCalledWith('p-lp');
    const args = lastPd();
    expect(args.to).toEqual({ maxChatId: '111', telegramChatId: '222' });
    expect(args.buttons).toBeUndefined();
    expect(args.text).toContain('+79001234567');
    expect(args.stub).not.toContain('+79001234567');
  });

  it('не привязан → no_channel, ничего не шлётся; адрес не прочитался → unknown', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    reachMock.mockResolvedValue({ ...BOUND, maxChatId: null, telegramChatId: null, reachable: false });
    expect(await notifyPartnerRequestPersonally(NOTICE)).toEqual({ state: 'no_channel' });
    reachMock.mockResolvedValue(null);
    expect(await notifyPartnerRequestPersonally(NOTICE)).toEqual({ state: 'unknown' });
    expect(pdMock).not.toHaveBeenCalled();
    // В логе — id партнёра и заявки, не имя и не телефон.
    expect(quiet.mock.calls.map((c) => c.join(' ')).join('\n')).not.toMatch(/Анна|79001234567/);
    quiet.mockRestore();
  });

  it('прокат пилота — кнопки «Беру» и «Не могу» без ссылок; перевозчик, чужой slug и пустой список — без кнопок', async () => {
    const leadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const rental: PartnerRequestNotice = {
      ...NOTICE, kind: 'car_rental', leadId, companySlug: 'laguna-prokat',
      lines: ['Машина: Suzuki Jimny — 7 000 ₽/сутки, без водителя'],
    };
    vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
    const buttons = partnerRequestButtons(rental);
    // «Ответить клиенту» (переписка, 1350) — первой, у пилота следом «Беру» / «Не могу».
    expect(buttons).toEqual([
      { text: 'Ответить клиенту', payload: `lq:o:${leadId}` },
      { text: 'Беру', payload: `rr:y:${leadId}` },
      { text: 'Не могу', payload: `rr:n:${leadId}` },
    ]);
    expect(buttons?.every((b) => !('url' in b))).toBe(true);
    expect(partnerRequestTexts(rental).text).toContain('«Беру» отмечает эти дни занятыми');
    expect(partnerRequestTexts(rental).stub).not.toContain('Беру');
    expect(partnerRequestTexts(rental).stub).not.toContain('+79001234567');

    reachMock.mockResolvedValue(BOUND);
    expect(await notifyPartnerRequestPersonally(rental)).toEqual({ state: 'delivered', channel: 'max' });
    expect(lastPd().buttons).toEqual(buttons);
    expect(lastPd().stub).not.toContain('Анна');

    // Не пилот — только переписка; id не uuid — ни одной кнопки-действия.
    const replyOnly = [{ text: 'Ответить клиенту', payload: `lq:o:${leadId}` }];
    expect(partnerRequestButtons({ ...rental, kind: 'charter', companySlug: 'laguna-prokat' })).toEqual(replyOnly);
    expect(partnerRequestButtons({ ...rental, companySlug: 'fishing' })).toEqual(replyOnly);
    expect(partnerRequestButtons({ ...rental, leadId: 'lead-7' })).toBeUndefined();
    expect(partnerRequestTexts({ ...rental, companySlug: 'fishing' }).text).not.toContain('«Беру»');
    expect(partnerRequestTexts({ ...rental, companySlug: 'fishing' }).text).toContain('«Ответить клиенту»');
    vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', '');
    expect(partnerRequestButtons(rental)).toEqual(replyOnly);
    vi.unstubAllEnvs();
  });

  it('заглушка и отказ — не доставка', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    reachMock.mockResolvedValue(BOUND);
    pdMock.mockResolvedValue({ channel: 'telegram-stub', delivered: false, reason: 'MAX отказал' });
    expect(await notifyPartnerRequestPersonally(NOTICE)).toEqual({ state: 'stub', channel: 'telegram-stub' });
    pdMock.mockResolvedValue({ channel: 'none', delivered: false, reason: 'ни MAX, ни заглушка' });
    expect(await notifyPartnerRequestPersonally(NOTICE)).toEqual({ state: 'failed', channel: 'none', reason: 'ни MAX, ни заглушка' });
    quiet.mockRestore();
  });
});

describe('факты для партнёра — без его телефона и без заметок менеджеру', () => {
  it('машина: направление, даты, люди, цена по прайсу с видом машины; «уточнить у перевозчика» и его телефона нет', () => {
    const lines = charterRequestLines(charterFacts());
    expect(lines).toEqual([
      'Направление: Авачинский перевал',
      'Даты: с 2027-07-10 по 2027-07-12',
      'Человек: 10',
      'По прайсу: микроавтобус — 25000 руб за полный день работы машины; вахтовка — 50000 руб за полный день работы машины — часов поездки заказчик не называл',
    ]);
    expect(lines.join('\n')).not.toMatch(/уточнить у перевозчика|79060835070|телефон/);
    const noReturn = charterRequestLines(charterFacts({ dateTo: null }));
    expect(noReturn[1]).toBe('Даты: с 2027-07-10, дата возвращения не указана');
  });

  it('прокат: машина с ценой за сутки, даты и дни, залог; «от» — названо', () => {
    const lines = rentalRequestLines(rentalFacts()).map((l) => l.replace(/\u00a0/g, ' '));
    expect(lines).toEqual([
      'Машина: Suzuki Jimny — 7 000 ₽/сутки, без водителя',
      'Даты: с 2027-07-10 по 2027-07-12, 3 дня',
      'Залог по прайсу: 15000 руб',
    ]);
    const from = rentalRequestLines(rentalFacts({ offer: { ...OFFER, priceIsFrom: true, depositRub: null } })).join('\n');
    expect(from).toContain('Цена в прайсе «от» — точную называете вы');
    expect(from).not.toContain('Залог');
    expect(from).not.toMatch(/79060835070|телефон/);
  });
});

describe('сервисы записи зовут доставку после createLead', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('заявка на машину: после записи — лично перевозчику, исход в журнал; повтор и свой визит не будят', async () => {
    reachMock.mockResolvedValue(BOUND);
    const facts = charterFacts();
    const id = await saveCharterLead({
      facts, lead: { comment: '[Заявка на машину] …', sourceData: { kind: 'charter' } },
      name: 'Анна Петрова', phone: '+79001234567', consent: null, isSelf: false, sourceUrl: 'https://vedarai.ru/transfers/laguna-prokat',
    });
    expect(id).toBe('lead-7');
    await flush();
    expect(pdMock).toHaveBeenCalledTimes(1);
    expect(lastPd().text).toContain('Направление: Авачинский перевал');
    expect(recordMock).toHaveBeenCalledWith('lead-7', 'p-lp', { state: 'delivered', channel: 'max' });

    pdMock.mockClear();
    await saveCharterLead({
      facts, lead: { comment: '…', sourceData: {} }, name: 'Анна Петрова', phone: '+79001234567', consent: null, isSelf: true, sourceUrl: 'x',
    });
    await flush();
    expect(pdMock).not.toHaveBeenCalled();

    recentLeadMock.mockResolvedValue('lead-old');
    await saveCharterLead({
      facts, lead: { comment: '…', sourceData: {} }, name: 'Анна Петрова', phone: '+79001234567', consent: null, isSelf: false, sourceUrl: 'x',
    });
    await flush();
    expect(pdMock).not.toHaveBeenCalled();
  });

  it('заявка на прокат: после записи — лично прокатчику; отказ доставки не роняет запись и логируется без ПД', async () => {
    reachMock.mockResolvedValue(BOUND);
    const id = await saveRentalLead({
      facts: rentalFacts(), lead: { comment: '[Заявка на прокат] …', sourceData: { kind: 'car_rental' } },
      name: 'Анна Петрова', phone: '+79001234567', consent: null, isSelf: false, sourceUrl: 'https://vedarai.ru/car-rental/laguna-prokat',
    });
    expect(id).toBe('lead-7');
    await flush();
    expect(lastPd().text).toContain('Новая заявка на прокат с Ведара');
    expect(lastPd().text).toContain('Машина: Suzuki Jimny');
    expect(lastPd().buttons).toBeUndefined();
    expect(recordMock).toHaveBeenCalledWith('lead-7', 'p-lp', { state: 'delivered', channel: 'max' });

    vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
    createLeadMock.mockResolvedValue('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await saveRentalLead({
      facts: rentalFacts(), lead: { comment: '[Заявка на прокат] …', sourceData: { kind: 'car_rental' } },
      name: 'Анна Петрова', phone: '+79001234567', consent: null, isSelf: false, sourceUrl: 'https://vedarai.ru/car-rental/laguna-prokat',
    });
    await flush();
    expect(lastPd().buttons).toEqual([
      { text: 'Ответить клиенту', payload: 'lq:o:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { text: 'Беру', payload: 'rr:y:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { text: 'Не могу', payload: 'rr:n:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    ]);
    vi.unstubAllEnvs();

    createLeadMock.mockResolvedValue('lead-7');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    reachMock.mockRejectedValue(new Error('сеть упала, телефон +79001234567 не при чём'));
    const again = await saveRentalLead({
      facts: rentalFacts(), lead: { comment: '…', sourceData: {} }, name: 'Анна Петрова', phone: '+79001234567', consent: null, isSelf: false, sourceUrl: 'x',
    });
    expect(again).toBe('lead-7');
    await flush();
    const logged = quiet.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('[rental-request] личная доставка прокатчику');
    expect(logged).not.toContain('Анна');
    quiet.mockRestore();
  });

  it('заявка на прокат: свой визит владельца и повтор прокатчика не будят', async () => {
    reachMock.mockResolvedValue(BOUND);
    await saveRentalLead({
      facts: rentalFacts(), lead: { comment: '…', sourceData: {} }, name: 'Анна', phone: '+79001234567', consent: null, isSelf: true, sourceUrl: 'x',
    });
    recentLeadMock.mockResolvedValue('lead-old');
    await saveRentalLead({
      facts: rentalFacts(), lead: { comment: '…', sourceData: {} }, name: 'Анна', phone: '+79001234567', consent: null, isSelf: false, sourceUrl: 'x',
    });
    await flush();
    expect(reachMock).not.toHaveBeenCalled();
    expect(pdMock).not.toHaveBeenCalled();
  });

  it('createLead не записал (null) — партнёра не будят', async () => {
    createLeadMock.mockResolvedValue(null);
    expect(await saveRentalLead({
      facts: rentalFacts(), lead: { comment: '…', sourceData: {} }, name: 'Анна', phone: '+79001234567', consent: null, isSelf: false, sourceUrl: 'x',
    })).toBeNull();
    await flush();
    expect(reachMock).not.toHaveBeenCalled();
  });
});

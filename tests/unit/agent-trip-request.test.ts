import { describe, it, expect, vi } from 'vitest';
import { runTripRequest } from '@/lib/agent/trip-request';
import { planChatRequest, parseChatContact } from '@/lib/kuzmich/chat-request';

const NOTE = 'Заявка передана, подтвердит человек.';
function deps() {
  return {
    bookTour: vi.fn(async () => `Заявка на тур создана. ${NOTE}`),
    requestStay: vi.fn(async () => `Запрос хозяину отправлен. ${NOTE}`),
    requestCharter: vi.fn(async () => 'Перевозчиков несколько — укажите, кому адресовать.'),
    createLead: vi.fn(async () => `Заявка менеджеру создана. ${NOTE}`),
    confirmNote: NOTE,
  };
}

describe('create_trip_request', () => {
  it('runs all legs with a shared trip id and one confirm note', async () => {
    const d = deps();
    const r = await runTripRequest({ participants: 5, tour: '36', tour_date: '2026-11-15', stay: 'Кутха', check_in: '2026-11-15', check_out: '2026-11-18', transfer_destination: 'Елизово', transfer_date: '2026-11-15', name: 'Тест', phone: '+79990000000', consent: true }, d as never);
    expect(r.tripId).toMatch(/^TRIP-/);
    expect(r.legs).toHaveLength(3);
    expect(d.createLead).toHaveBeenCalled();
    expect(r.text.split(NOTE).length - 1).toBe(1);
    const c = (d.bookTour.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(String(c.comment)).toContain(r.tripId!);
  });
  it('refuses with no legs', async () => {
    const r = await runTripRequest({ name: 'a', phone: '1', consent: true }, deps() as never);
    expect(r.tripId).toBeNull();
  });
});

describe('kuzmich chat request plan', () => {
  const msg = 'Хочу забронировать рыбалку 15.11, нас 5 человек, меня зовут Иван, +7 999 123-45-67, согласен на обработку данных';
  it('parses contact', () => { expect(parseChatContact(msg)).toMatchObject({ name: 'Иван', phone: '+79991234567', consent: true }); });
  it('single tour → booking', () => {
    expect(planChatRequest(msg, { id: 36 }, { date: '2026-11-15', guests: 5 })).toMatchObject({ tool: 'create_booking_request', args: { tour: '36', participants: 5 } });
  });
  it('multi-intent → trip', () => {
    expect(planChatRequest(msg + ' и трансфер из аэропорта и проживание', { id: 36 }, { date: '2026-11-15', guests: 5 })?.tool).toBe('create_trip_request');
  });
  it('no consent → nothing', () => {
    expect(planChatRequest('рыбалка 15.11 Иван +79991234567', { id: 36 }, { date: '2026-11-15' })).toBeNull();
  });
});

describe('kuzmich chat: tour not resolved', () => {
  it('falls back to create_lead with date and people', () => {
    const p = planChatRequest('Хочу забронировать рыбалку 15.11, нас 2 человека, меня зовут Тест, +7 900 000-00-03, согласен', null, { date: '2026-11-15', guests: 2 });
    expect(p?.tool).toBe('create_lead');
    expect(String(p?.args.comment)).toContain('2026-11-15, 2 чел.');
  });
});

describe('chat contact: имя капсом', () => {
  it('«Меня зовут ТЕСТ Агент» распознаётся, заявка планируется', () => {
    const t = 'Хочу забронировать зимнюю рыбалку 15.11, нас 2. Меня зовут ТЕСТ Агент (не звонить), +7 900 000-00-03. Согласен.';
    expect(parseChatContact(t).name).toBe('ТЕСТ Агент');
    expect(planChatRequest(t, { id: 36 }, { date: '2026-11-15', guests: 2 })?.tool).toBe('create_booking_request');
  });
});


describe('chat: человеку — не агентский текст', () => {
  it('humanChatConfirm убирает ключ и инструкции агенту', async () => {
    const { humanChatConfirm } = await import('@/lib/kuzmich/chat-request');
    const t = 'Поездка TRIP-4A343C: создано частей 2 из 2.\n— Тур: создано. Ключ статуса заявки: abc — Ключ и ссылку не публикуйте. https://vedarai.ru/request-status#abc\n— Машина: создано. https://vedarai.ru/request-status#d-e\nСкажи человеку его языком: RU: ... ZH: 申请';
    const h = humanChatConfirm(t);
    expect(h).toContain('TRIP-4A343C (тур, транспорт)');
    expect(h).toContain('https://vedarai.ru/request-status#d-e');
    expect(h).not.toMatch(/не публикуйте|Скажи человеку|申请|недоступн/);
  });
  it('narrowToursByText: «зимнюю рыбалку 15.11» → ноябрь — январь', async () => {
    const { narrowToursByText } = await import('@/lib/ai/chat-booking-tour');
    const tours = [{ id: 4, title: 'Осенняя рыбалка (октябрь-ноябрь)' }, { id: 36, title: 'Зимняя рыбалка: ноябрь — январь' }, { id: 37, title: 'Зимняя рыбалка: январь — март' }];
    expect(narrowToursByText('Хочу забронировать зимнюю рыбалку 15.11, нас 2', tours)?.id).toBe(36);
    expect(narrowToursByText('рыбалка', tours)).toBeNull();
  });

  it('жильё на подбор: названные даты — как есть, оценённые и пустой выезд называются вслух', async () => {
    const base = { stay_wanted: true, check_in: '2026-11-15', name: 'Тест', phone: '+79990000000', consent: true, participants: 2 };
    const named = deps();
    await runTripRequest({ ...base, check_out: '2026-11-18' }, named as never);
    const namedComment = String((named.createLead.mock.calls[0] as unknown[])[0] ? ((named.createLead.mock.calls[0] as unknown[])[0] as { comment: string }).comment : '');
    expect(namedComment).toContain('заезд 2026-11-15, выезд 2026-11-18');
    expect(namedComment).not.toMatch(/ориентировочно|не назван/);

    const guessed = deps();
    await runTripRequest({ ...base, stay_dates_assumed: true }, guessed as never);
    const guessedComment = ((guessed.createLead.mock.calls[0] as unknown[])[0] as { comment: string }).comment;
    expect(guessedComment).toContain('заезд ориентировочно 2026-11-15');
    expect(guessedComment).toContain('выезд не назван, уточнить');
  });

  it('чат: заезд на подбор помечен оценкой, «3 ночи» даёт выезд', () => {
    const t = 'Хочу тур и пожить в гостинице 3 ночи. Меня зовут Анна, +7 999 000 00 00, согласна';
    const plan = planChatRequest(t, { id: 1 }, { date: '2026-11-15', guests: 2 });
    expect(plan?.args).toMatchObject({ stay_wanted: true, check_in: '2026-11-15', check_out: '2026-11-18', stay_dates_assumed: true });
  });
});

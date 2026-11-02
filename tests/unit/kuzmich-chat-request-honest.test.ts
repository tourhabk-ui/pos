/**
 * «Заявка создана» — только когда она создана (#2967, 03.11).
 *
 * Исполнители MCP возвращают отказы ТЕКСТОМ («— заявка не создана»), и
 * runPublicTool отдаёт их как kind: 'ok'. Чат Кузьмича отвечал человеку
 * «Заявка создана. Оператор свяжется» на любой такой ответ — турист ждал
 * звонка, которого не будет. Здесь таблица настоящих текстов исполнителей
 * (их формы — из app/api/mcp/route.ts и lib/agent/trip-request.ts) и разбор
 * реплики: согласие, телефон, имя, намерения, дата, число людей.
 *
 * Сторож — вызовом функций (§13.10). Мутация «вернуть старую humanChatConfirm»
 * (всегда «Заявка создана») краснит блок «отказ текстом».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestOutcome, humanReason, textFailed } from '@/lib/agent/request-outcome';
import { legFailed } from '@/lib/agent/trip-request';
import {
  humanChatConfirm, chatToolReply, parseChatContact, chatConsent,
  chatWantsStay, chatWantsTransfer, planChatRequest, chatPastDateAsk,
} from '@/lib/kuzmich/chat-request';
import { parseChatBookingPrefill } from '@/lib/kuzmich/booking-prefill';

const KEY_TAIL = ' Ключ статуса заявки: k1 — по нему get_request_status покажет, ответил ли оператор (без имени и телефона). Человеку дайте ссылку https://vedarai.ru/request-status#k1: там он сам подтверждает согласие на обработку данных и видит ответ оператора. Ключ и ссылку не публикуйте.';
const CONFIRM = '\n\nСкажи человеку его языком: RU: Заявка создана. Оператор свяжется с вами для подтверждения. EN: Request created. ZH: 申请已创建。 Это штатный порядок, а не сбой.';

const BOOKED = `Заявка оператору принята: "Мутновский вулкан", 2099-11-15. Сейчас на эту дату свободно 6 мест. Оператор перезвонит по телефону +79991234567, подтвердит заявку и состав группы. Это заявка, не оплата.${KEY_TAIL}${CONFIRM}`;
const LEAD = `Заявка принята. Менеджер Ведара свяжется по указанному телефону.${KEY_TAIL}${CONFIRM}`;
const LEAD_NO_PLAN = `Заявка принята. Менеджер Ведара свяжется по указанному телефону. План P-1 не найден (неверный ID или плану больше 7 дней) — заявка принята без плана.${KEY_TAIL}${CONFIRM}`;
const SEATS = 'У тура "Рыбалка" нет расписания в системе, поэтому места на 2099-11-15 (2 чел.) уточняются у оператора: запрос отправлен ему в мессенджер, ответ будет до 14:30 по Камчатке. Места этим запросом НЕ закреплены, и это не оплата.' + KEY_TAIL;

const REFUSALS: Array<[string, string, RegExp]> = [
  ['тур не найден', 'Тур по запросу "Горелый" не найден среди активных — заявка не создана. Уточните тур через get_tours или get_tour_availability.', /Тур по запросу "Горелый" не найден среди активных/],
  ['дата прошла', 'Дата 2026-10-01 уже прошла — заявка не создана. Свободные даты: get_tour_availability.', /Дата 2026-10-01 уже прошла/],
  ['мест нет', 'На 2099-11-09 у тура "Мутновский вулкан" нет свободных мест — заявка не создана. Ближайшие даты с местами: 2099-11-12 (4 мест).', /нет свободных мест.*Ближайшие даты с местами: 2099-11-12/],
  ['разные компании', 'По запросу «рыбалка» подходят туры разных компаний — заявка не создана. Повторите create_booking_request с номером тура (поле tour):\n1. ...', /подходят туры разных компаний/],
  ['вне сезона', 'Тур идёт с июня по сентябрь. Заявка не создана — предложите дату внутри сезона.', /Тур идёт с июня по сентябрь/],
  ['перевозчиков несколько', 'Перевозчиков несколько (Шатун, Лагуна) — укажите, кому адресовать заявку (параметр carrier). Заявка не создана.', /^Заявка не создана\.?\n/],
  ['черновик проката', 'Черновик, заявка ещё НЕ создана. Прокат: Нива с 2099-11-01. Попроси человека подтвердить: "123456" (код действует 15 мин).', /^Заявка не создана/],
];

describe('отказ текстом — «Заявка не создана», а не «создана»', () => {
  it.each(REFUSALS)('%s', (_name, text, reason) => {
    expect(requestOutcome(text).kind).toBe('not_created');
    const h = humanChatConfirm(text, 'Мутновский вулкан');
    expect(h).toMatch(/^Заявка не создана/);
    expect(h).toMatch(reason);
    expect(h).not.toMatch(/Заявка создана|Оператор свяжется|Тур в заявке/);
    // Агенту писали имена инструментов и полей — человеку их не показываем.
    expect(h).not.toMatch(/get_|create_|параметр|поле tour/);
  });

  it('поездка, где не создано ни одной части, — не «создана, номер TRIP»', () => {
    const t = 'Поездка TRIP-AB12CD: ни одна часть не создана.\n— Тур: НЕ создано. На 2099-11-09 у тура "Мутновский вулкан" нет свободных мест — заявка не создана.\n— Жильё: НЕ создано. Жильё по запросу "Кутха" не найдено среди опубликованных — заявка не создана.';
    const o = requestOutcome(t);
    expect(o.kind).toBe('not_created');
    const h = humanChatConfirm(t);
    expect(h).toMatch(/^Заявка не создана: тур — На 2099-11-09/);
    expect(h).toContain('жильё — Жильё по запросу "Кутха" не найдено');
    expect(h).not.toMatch(/создана, номер|TRIP-AB12CD \(/);
  });

  it('поездка частично: созданное и упавшая часть — порознь, тур не назван, если не создан', () => {
    const t = 'Поездка TRIP-AB12CD: создано частей 1 из 2. Каждый партнёр видит в заявке всю поездку (номер TRIP-AB12CD).\n— Тур: НЕ создано. На 2099-11-09 у тура "Мутновский вулкан" нет свободных мест — заявка не создана.\n— Жильё: создано. Жильё — в той же заявке менеджеру.\nВся поездка одной ссылкой для человека: https://vedarai.ru/trip-request/TRIP-AB12CD#k1.k2 (части, статус каждой, согласие). Ссылку не публикуйте.';
    const h = humanChatConfirm(t, 'Мутновский вулкан');
    expect(h).toContain('Заявка на поездку создана, номер TRIP-AB12CD (жильё).');
    expect(h).toContain('Не создано: тур — На 2099-11-09 у тура "Мутновский вулкан" нет свободных мест.');
    expect(h).not.toContain('Тур в заявке');
    expect(h).toContain('https://vedarai.ru/trip-request/TRIP-AB12CD#k1.k2');
  });
});

describe('успех — по признаку успеха', () => {
  it('бронь, подбор, подбор без плана — «Заявка создана», со ссылкой статуса', () => {
    for (const t of [BOOKED, LEAD, LEAD_NO_PLAN]) {
      expect(requestOutcome(t).kind).toBe('created');
      const h = humanChatConfirm(t, 'Мутновский вулкан');
      expect(h).toMatch(/^Заявка создана\./);
      expect(h).toContain('https://vedarai.ru/request-status#k1');
      expect(h).not.toMatch(/не публикуйте|Скажи человеку|get_request_status/);
    }
  });
  it('«план не найден — заявка принята без плана» часть поездки не роняет', () => {
    expect(legFailed(LEAD_NO_PLAN)).toBe(false);
    expect(textFailed('Тур не найден — заявка не создана.')).toBe(true);
  });
  it('запрос мест туру без расписания назван запросом мест, а не созданной заявкой', () => {
    const h = humanChatConfirm(SEATS, 'Рыбалка');
    expect(h).toMatch(/^Запрос мест отправлен оператору: .*ответ будет до 14:30 по Камчатке\. Места этим запросом не закреплены\./);
    expect(h).not.toMatch(/^Заявка создана/);
  });
  it('ни успеха, ни отказа — «не могу подтвердить», звонка не обещаем (§4.0)', () => {
    for (const t of ['ok', '', 'Что-то пошло иначе.']) {
      expect(requestOutcome(t).kind).toBe('unknown');
      const h = humanChatConfirm(t, 'Мутновский вулкан');
      expect(h).toMatch(/^Не могу подтвердить, что заявка записалась/);
      expect(h).not.toMatch(/Заявка создана|Оператор свяжется/);
    }
  });
  it('chatToolReply: kind ok с отказом — created false; refused — «не создана»', () => {
    expect(chatToolReply({ kind: 'ok', text: REFUSALS[2][1] }).created).toBe(false);
    expect(chatToolReply({ kind: 'ok', text: BOOKED }).created).toBe(true);
    const r = chatToolReply({ kind: 'refused', text: 'Телефон не похож на номер (нужно 10–15 цифр, например +79001234567) — заявка не создана.' });
    expect(r).toEqual({ created: false, text: expect.stringMatching(/^Заявка не создана: Телефон не похож на номер/) });
    expect(chatToolReply({ kind: 'failed', text: 'сбой' }).created).toBe(false);
    expect(chatToolReply(null).text).toMatch(/^Заявка не записалась/);
  });
  it('humanReason отрезает хвост для агента', () => {
    expect(humanReason(BOOKED)).not.toMatch(/Ключ|get_/);
    expect(humanReason(null)).toBeNull();
    expect(humanReason('Повторите create_lead.')).toBeNull();
  });
});

describe('согласие на обработку данных — только явное', () => {
  const YES = ['согласен', 'Согласна', 'даю согласие на обработку данных', 'согласен на обработку персональных данных', 'I agree', 'consent', '同意', 'согласен на любую дату, даю согласие на обработку'];
  const NO = ['не согласен', 'без согласия', 'нет согласия', 'не даю согласия', 'несогласие', 'I disagree', 'I do not agree', '不同意',
    'согласен на любую дату', 'согласна на 15 ноября', 'надо согласовать маршрут', 'согласование парка'];
  it.each(YES)('«%s» — согласие', (t) => expect(chatConsent(t)).toBe(true));
  it.each(NO)('«%s» — не согласие', (t) => expect(chatConsent(t)).toBe(false));
});

describe('телефон и имя', () => {
  it('один номер — берём; два разных — не угадываем', () => {
    expect(parseChatContact('Меня зовут Иван, +7 999 123-45-67').phone).toBe('+79991234567');
    const two = parseChatContact('Меня зовут Иван, мой +79991234567, сестры 89997654321');
    expect(two.phone).toBeUndefined();
    expect(two.phones).toBe(2);
    expect(parseChatContact('+79991234567 и ещё раз 8 (999) 123-45-67').phone).toBe('+79991234567');
  });
  it('имя — после «меня зовут» / «имя:» / «я — », не из «для меня - Горелый»', () => {
    expect(parseChatContact('Меня зовут Анна Петрова, +79991234567').name).toBe('Анна Петрова');
    expect(parseChatContact('Имя: Тест Телефон +79991234567').name).toBe('Тест');
    expect(parseChatContact('Я - Олег, +79991234567').name).toBe('Олег');
    expect(parseChatContact('Для меня - Горелый вулкан, +79991234567').name).toBeUndefined();
  });
});

describe('намерения: жильё и трансфер', () => {
  const STAY: Array<[string, boolean]> = [
    ['Хотел бы на Авачинский 15.11', false],
    ['хотела бы в отель у океана', true],
    ['и проживание на 3 ночи', true],
    ['нужна гостиница в Паратунке', true],
    ['жильё не нужно, только тур', false],
    ['без жилья', false],
    ['у нас свой домик в Паратунке', false],
    ['жильё уже есть', false],
  ];
  it.each(STAY)('жильё: «%s» → %s', (t, want) => expect(chatWantsStay(t)).toBe(want));
  const TRANSFER: Array<[string, boolean]> = [
    ['автобусный тур по городу', false],
    ['нужен трансфер из аэропорта', true],
    ['встретить в Елизово', true],
    ['без трансфера', false],
    ['трансфер не нужен', false],
    ['доберёмся сами на автобусе', true],
  ];
  it.each(TRANSFER)('трансфер: «%s» → %s', (t, want) => expect(chatWantsTransfer(t)).toBe(want));
});

describe('дата и число людей', () => {
  const TODAY = new Date('2026-11-03T00:00:00Z');
  it('не даты', () => {
    expect(parseChatBookingPrefill('нас 3 маленьких ребёнка', TODAY)).toEqual({ guests: 3 });
    expect(parseChatBookingPrefill('1.5 часа езды от города', TODAY).date).toBeUndefined();
    expect(parseChatBookingPrefill('2.50 км по тропе', TODAY).date).toBeUndefined();
    expect(parseChatBookingPrefill('сбор в 10.30', TODAY).date).toBeUndefined();
    expect(parseChatBookingPrefill('3 мая', TODAY).date).toBe('2027-05-03');
    expect(parseChatBookingPrefill('3 марта', TODAY).date).toBe('2027-03-03');
  });
  it('прошедшая явная дата — переспрос, а не заявка', () => {
    expect(parseChatBookingPrefill('на 15.11.24', TODAY)).toEqual({ pastDate: '2024-11-15' });
    expect(parseChatBookingPrefill('2026-10-01, нас 2', TODAY)).toEqual({ pastDate: '2026-10-01', guests: 2 });
    expect(chatPastDateAsk('2024-11-15')).toMatch(/^Дата 15\.11\.2024 уже прошла/);
  });
  it('«нас 15.07» — дата, не 15 человек; слова числа людей', () => {
    expect(parseChatBookingPrefill('нас 15.07', TODAY)).toEqual({ date: '2027-07-15' });
    expect(parseChatBookingPrefill('15.11 вдвоём', TODAY)).toEqual({ date: '2026-11-15', guests: 2 });
    expect(parseChatBookingPrefill('15.11, я один', TODAY)).toEqual({ date: '2026-11-15', guests: 1 });
  });
});

describe('число людей не выдумывается', () => {
  const MSG = 'Меня зовут Тест, +79990000003, согласен';
  it('подбор без числа — без participants и со словами «число людей не названо»', () => {
    const p = planChatRequest(MSG, null, { date: '2099-11-15' });
    expect(p?.tool).toBe('create_lead');
    expect(p?.args.participants).toBeUndefined();
    expect(String(p?.args.comment)).toContain('[2099-11-15, число людей не названо]');
    expect(String(p?.args.comment)).not.toContain('1 чел.');
  });
  it('поездка без числа — без participants', () => {
    const p = planChatRequest(`${MSG}, тур и гостиница`, { id: 36 }, { date: '2099-11-15' });
    expect(p?.tool).toBe('create_trip_request');
    expect(p?.args.participants).toBeUndefined();
  });
  it('бронь тура без числа — заявки нет (места проверять не на что), с числом — есть', () => {
    expect(planChatRequest(MSG, { id: 36 }, { date: '2099-11-15' })).toBeNull();
    expect(planChatRequest(MSG, { id: 36 }, { date: '2099-11-15', guests: 3 })?.args.participants).toBe(3);
  });
  it('«не согласен» — заявки нет', () => {
    expect(planChatRequest('Меня зовут Тест, +79990000003, не согласен', null, { date: '2099-11-15', guests: 2 })).toBeNull();
  });
});

// ── MAX и Telegram: submitChatRequest ───────────────────────────────────────
const runPublicToolMock = vi.fn();
vi.mock('@/app/api/mcp/route', () => ({ runPublicTool: (...a: unknown[]) => runPublicToolMock(...a) }));

describe('submitChatRequest (MAX, Telegram) — ok только при созданной заявке', () => {
  beforeEach(() => { runPublicToolMock.mockReset(); });
  const plan = { tool: 'create_booking_request' as const, args: { tour: '36', date: '2099-11-09', participants: 2 } };
  it('отказ текстом под kind ok — ok false и причина', async () => {
    const { submitChatRequest } = await import('@/lib/kuzmich/chat-request-submit');
    runPublicToolMock.mockResolvedValue({ kind: 'ok', text: REFUSALS[2][1], handoffUrl: null });
    const r = await submitChatRequest(plan, { ip: 'max:1', userAgent: 'kuzmich-max', tourTitle: 'Мутновский вулкан' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/^Заявка не создана: На 2099-11-09/);
  });
  it('успех — ok true', async () => {
    const { submitChatRequest } = await import('@/lib/kuzmich/chat-request-submit');
    runPublicToolMock.mockResolvedValue({ kind: 'ok', text: BOOKED, handoffUrl: null });
    const r = await submitChatRequest(plan, { ip: 'tg:1', userAgent: 'kuzmich-tg', tourTitle: 'Мутновский вулкан' });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Заявка создана\./);
  });
  it('исполнитель упал — не создана', async () => {
    const { submitChatRequest } = await import('@/lib/kuzmich/chat-request-submit');
    runPublicToolMock.mockImplementation(async () => { throw new Error('boom'); });
    const r = await submitChatRequest(plan, { ip: 'max:1', userAgent: 'kuzmich-max' });
    expect(r.ok).toBe(false);
    expect(r.text).not.toMatch(/Заявка создана/);
  });
});

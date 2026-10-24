/**
 * Карточка входящей заявки: четыре кнопки, ответ без подтверждения брони.
 *
 * Сторож держит вызовом: разбор payload, отказ писать без «своего» чата,
 * повтор не зовёт менеджера второй раз, чужая заявка строку не создаёт
 * (хранилище в этом файле подменено — конфликт на PostgreSQL держит
 * tests/integration/incoming-answer.pg.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { claimMock, tgMock, pdMock } = vi.hoisted(() => ({
  claimMock: vi.fn(),
  tgMock: vi.fn(),
  pdMock: vi.fn(),
}));
vi.mock('@/lib/requests/incoming-answer-store', () => ({ claimIncomingAnswer: claimMock }));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: tgMock }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: pdMock }));
vi.mock('@/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config')>();
  return { ...actual, getPublicBaseUrl: () => 'https://vedarai.ru' };
});

import { handleIncomingAnswer } from '@/lib/requests/incoming-answer-flow';
import {
  incomingAnswerButtons, incomingAnswerText, incomingEditText, incomingManagerText, parseIncomingAnswer,
} from '@/lib/requests/incoming-card';
import { notifyNewGearRental } from '@/lib/notifications/gear-rental';
import { notifyNewStayBooking } from '@/lib/notifications/stay-booking';
import type { PartnerChatLookup } from '@/lib/kuzmich/operator-chat';

const LEAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PHONE = '+79990001122';

const found: PartnerChatLookup = {
  outcome: 'found',
  partner: {
    partnerId: PARTNER,
    partnerName: 'Вулкан <Тур>',
    category: 'operator',
    slug: 'vulkan',
    crmCategory: 'operator',
    userId: null,
  },
};

function sendSink() {
  const calls: Array<{ text: string; editMid: string | null }> = [];
  return {
    calls,
    send: async (text: string, editMid: string | null) => { calls.push({ text, editMid }); },
  };
}

beforeEach(() => {
  claimMock.mockReset();
  tgMock.mockReset().mockResolvedValue({ ok: true });
  pdMock.mockReset().mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
});

describe('кнопки и разбор', () => {
  it('четыре ответа, payload короче 128, id в нижнем регистре', () => {
    const buttons = incomingAnswerButtons('lead', LEAD.toUpperCase());
    expect(buttons?.map((b) => b.text)).toEqual(['Принять', 'Нет мест', 'Уточнить', 'Свяжусь сам']);
    expect(buttons?.map((b) => b.payload)).toEqual([
      `ia:a:l:${LEAD}`, `ia:n:l:${LEAD}`, `ia:c:l:${LEAD}`, `ia:m:l:${LEAD}`,
    ]);
    expect(buttons?.every((b) => b.payload.length < 128)).toBe(true);
    expect(incomingAnswerButtons('gear', 'не-id')).toBeUndefined();
    expect(incomingAnswerButtons('booking', '77')).toEqual([
      { text: 'Принять', payload: 'ia:a:b:77' },
      { text: 'Нет мест', payload: 'ia:n:b:77' },
      { text: 'Уточнить', payload: 'ia:c:b:77' },
      { text: 'Свяжусь сам', payload: 'ia:m:b:77' },
    ]);
  });

  it('чужой payload не разбирается; строки ответа без телефона', () => {
    expect(parseIncomingAnswer('rr:y:' + LEAD)).toBeNull();
    expect(parseIncomingAnswer(`ia:a:l:${LEAD}`)).toEqual({ answer: 'accept', kind: 'lead', subjectId: LEAD });
    expect(parseIncomingAnswer('ia:m:s:42')).toEqual({ answer: 'self', kind: 'stay_booking', subjectId: '42' });
    for (const answer of ['accept', 'no_seats', 'clarify', 'self'] as const) {
      expect(incomingAnswerText(answer, false)).not.toContain(PHONE);
      expect(incomingAnswerText(answer, true)).not.toContain(PHONE);
    }
    expect(incomingAnswerText('accept', false)).toContain('Бронь этим не подтверждена');
    expect(incomingAnswerText('no_seats', false)).toContain('Расписание не закрывал');
  });

  it('менеджеру — без телефона и без угловых скобок в имени; правка экранирует исходный текст', () => {
    const text = incomingManagerText({
      partnerName: 'Вулкан <Тур> & Ко', kind: 'gear', subjectId: LEAD, answer: 'clarify',
    });
    expect(text).toContain('уточню');
    expect(text).toContain('Кто: Вулкан Тур  Ко');
    expect(text).not.toContain('<Тур>');
    expect(text).not.toContain('&');
    expect(text).not.toContain(PHONE);
    expect(text).toContain('Статус брони и оплата не менялись');
    expect(incomingEditText('Гость <b>Анна</b>', 'Ваш ответ')).toBe('Гость &lt;b&gt;Анна&lt;/b&gt;\n\nВаш ответ');
  });
});

describe('нажатие не пишет, пока чат не свой', () => {
  const payload = `ia:a:l:${LEAD}`;

  it('неразобранная кнопка, чужой чат и отказ базы хранилище не зовут или не уведомляют', async () => {
    const sink = sendSink();
    await handleIncomingAnswer({
      lookup: found, payload: 'ia:нет', editMid: null, originalText: null, send: sink.send,
    });
    expect(claimMock).not.toHaveBeenCalled();
    expect(sink.calls[0]?.text).toContain('не распознана');

    claimMock.mockClear();
    await handleIncomingAnswer({
      lookup: { outcome: 'unavailable' }, payload, editMid: 'm', originalText: 'заявка', send: sink.send,
    });
    await handleIncomingAnswer({
      lookup: { outcome: 'none' }, payload, editMid: null, originalText: null, send: sink.send,
    });
    expect(claimMock).not.toHaveBeenCalled();
    expect(tgMock).not.toHaveBeenCalled();
  });

  it('записал — менеджеру один раз; повтор и чужая заявка менеджера не зовут', async () => {
    claimMock.mockResolvedValueOnce({ outcome: 'saved' });
    const notify = vi.fn(async () => undefined);
    const sink = sendSink();
    await handleIncomingAnswer({
      lookup: found, payload, editMid: 'mid-1', originalText: 'Имя: Анна', send: sink.send, notifyManager: notify,
    });
    expect(claimMock).toHaveBeenCalledWith({
      partnerId: PARTNER, kind: 'lead', subjectId: LEAD, answer: 'accept',
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]?.[0])).not.toContain(PHONE);
    expect(String(notify.mock.calls[0]?.[0])).toContain('Вулкан Тур');
    expect(sink.calls[0]?.editMid).toBe('mid-1');
    expect(sink.calls[0]?.text).toContain('Бронь этим не подтверждена');
    expect(sink.calls[0]?.text).toContain('Имя: Анна');

    claimMock.mockResolvedValueOnce({ outcome: 'already', answer: 'accept' });
    await handleIncomingAnswer({
      lookup: found, payload: `ia:n:l:${LEAD}`, editMid: null, originalText: null, send: sink.send, notifyManager: notify,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(sink.calls.at(-1)?.text).toContain('Ответ уже записан');

    claimMock.mockResolvedValueOnce({ outcome: 'not_yours' });
    await handleIncomingAnswer({
      lookup: found, payload, editMid: null, originalText: null, send: sink.send, notifyManager: notify,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(sink.calls.at(-1)?.text).toContain('не ваша');
  });
});

describe('кнопки только у владельца предмета', () => {
  it('снаряжение: партнёру четыре ответа и ссылка «Открыть заявки», админу только ссылка', async () => {
    await notifyNewGearRental({
      rentalId: LEAD, gearName: 'Палатка', quantity: 1, startDate: '2026-11-01', endDate: '2026-11-03',
      totalPrice: 3000, customerName: 'Анна', customerPhone: PHONE, partnerMaxChatId: '9',
    });
    const sent = pdMock.mock.calls.map((c) => c[0] as { text: string; stub: string; buttons: Array<Record<string, string>>; to?: unknown });
    const admin = sent.find((s) => !s.to)!;
    const partner = sent.find((s) => s.to)!;
    expect(admin.buttons).toEqual([{ text: 'Открыть заявки', url: 'https://vedarai.ru/hub/gear/rentals' }]);
    expect(partner.buttons.map((b) => b.text)).toEqual(['Открыть заявки', 'Принять', 'Нет мест', 'Уточнить', 'Свяжусь сам']);
    expect(partner.buttons[1]?.payload).toBe(`ia:a:g:${LEAD}`);
    expect(partner.text).toContain(PHONE);
    expect(partner.text).toContain('Это ответ, не подтверждение брони');
    expect(partner.stub).not.toContain(PHONE);
    expect(partner.stub).not.toContain('Принять');
    expect(admin.text).not.toContain('Это ответ, не подтверждение брони');
  });

  it('бронь жилья: владельцу четыре ответа, админу только ссылка, заглушка без имени', async () => {
    await notifyNewStayBooking({
      bookingId: LEAD, accommodationName: 'Дом', checkInDate: '2099-08-01', checkOutDate: '2099-08-03',
      guests: 2, guestName: 'Иван', guestPhone: PHONE, ownerMaxChatId: '8',
    });
    const sent = pdMock.mock.calls.map((c) => c[0] as { text: string; stub: string; buttons: Array<Record<string, string>>; to?: unknown });
    const admin = sent.find((s) => !s.to)!;
    const owner = sent.find((s) => s.to)!;
    expect(admin.buttons).toEqual([{ text: 'Открыть брони', url: 'https://vedarai.ru/hub/stay/bookings' }]);
    expect(owner.buttons.map((b) => b.payload ?? b.url)).toEqual([
      'https://vedarai.ru/hub/stay/bookings',
      `ia:a:s:${LEAD}`, `ia:n:s:${LEAD}`, `ia:c:s:${LEAD}`, `ia:m:s:${LEAD}`,
    ]);
    expect(owner.text).toContain('Иван');
    expect(owner.stub).not.toContain('Иван');
    expect(owner.stub).not.toContain(PHONE);
    expect(admin.text).not.toContain('Это ответ, не подтверждение брони');
  });
});

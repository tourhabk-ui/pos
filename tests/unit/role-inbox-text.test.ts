/**
 * «Входящие» в чате кабинета: свободный текст туриста не несёт его ПД (план
 * «гид в чате», шаг 9; с 30.10 — кабинет в чате, lib/chat-cabinet).
 *
 * У заявки тур словами и желаемые даты пишет сам турист — в форме сайта
 * («route_title», «desired_dates»). Туда вписывают и телефон. Список и
 * карточка уходят в Telegram (ПД туриста туда не идут — решение владельца
 * 23.08) и в MAX обычным ответом, а справка меню обещает «Имени и телефона
 * туриста в этом списке нет» в обоих. Здесь — вызовом экранов кабинета
 * (`inboxScreen`, `itemCardScreen`): телефон и почта из этих полей не доходят
 * ни до текста, ни до подписи кнопки; даты и диапазоны — доходят как есть.
 */
import { describe, expect, it } from 'vitest';
import type { Inbox, InboxItem } from '@/lib/crm/inbox';
import { inboxScreen, itemCardScreen, type CabinetPartner } from '@/lib/chat-cabinet/screens';

const inboxMenuText = (i: Inbox) => inboxScreen(i, 0).text;

const PHONE = '+7 914 123-45-67';
const EMAIL = 'tourist.mail@example.com';

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    kind: 'lead',
    id: '00000000-0000-4000-8000-0000000000c1',
    created_at: '2026-10-28T00:00:00.000Z',
    title: 'Толбачик',
    date: 'ноябрь',
    people: 3,
    contact_id: null,
    contact_name: null,
    waiting_minutes: 30,
    ...over,
  };
}

function inbox(items: InboxItem[]): Inbox {
  return {
    category: 'guide',
    items,
    failed: [],
    response: { window_days: 7, median_minutes: null, responded: 0, enough: false, complete: true },
    chat: { state: 'none' },
    not_here: [],
  };
}

/** Ни одного куска номера длиннее трёх цифр и ни адреса почты. */
function expectNoContact(text: string): void {
  expect(text).not.toContain('123-45-67');
  expect(text).not.toContain('914');
  expect(text).not.toContain(EMAIL);
  expect(text).not.toContain('example.com');
}

describe('inboxMenuText: свободный текст заявки', () => {
  it('телефон и почта в желаемых датах не попадают в список — даты остаются', () => {
    const text = inboxMenuText(inbox([item({ date: `с 5 ноября, звоните ${PHONE} или ${EMAIL}` })]));
    expectNoContact(text);
    expect(text).toContain('с 5 ноября, звоните [телефон] или [email]');
    expect(text).toContain('Толбачик');
  });

  it('телефон в туре словами — тоже нет', () => {
    const text = inboxMenuText(inbox([item({ title: `Толбачик, перезвоните ${PHONE}` })]));
    expectNoContact(text);
    expect(text).toContain('Толбачик, перезвоните [телефон]');
  });

  it('диапазон дат и бюджет — не телефон: доходят как есть', () => {
    const text = inboxMenuText(inbox([item({ date: '10-15.08.2026, бюджет 150000-200000' })]));
    expect(text).toContain('10-15.08.2026, бюджет 150000-200000');
    expect(text).not.toContain('[телефон]');
  });

  it('у брони дата из базы, а не текст туриста: строка прежняя', () => {
    const text = inboxMenuText(inbox([item({ kind: 'operator_booking', id: '7001', title: 'Мутновский', date: '2026-11-05' })]));
    expect(text).toContain('Бронь тура · Мутновский · 2026-11-05 · 3 чел');
  });

  it('имя клиента CRM в строку не берётся', () => {
    const text = inboxMenuText(inbox([item({ contact_id: 'c1', contact_name: 'Пётр Туристов' })]));
    expect(text).not.toContain('Туристов');
  });
});

describe('кабинет в чате: список и карточка заявки гида со своими турами', () => {
  const guide: CabinetPartner = {
    partnerId: '22222222-2222-4222-8222-222222222222', role: 'guide', seat: 'owner', bookingActions: true, leadActions: true,
    operatorAnswers: false, sellsTours: true, summary: false,
  };
  // Номер и почта стоят в начале тура — чтобы обрезка сама их не спрятала.
  const twoLeads = [
    item({ id: '00000000-0000-4000-8000-0000000000c1', title: '89141234567 Толбачик' }),
    item({ id: '00000000-0000-4000-8000-0000000000c2', title: 'me@ya.ru Мутновский' }),
  ];

  for (const channel of ['telegram', 'max'] as const) {
    it(`${channel}: ни текст, ни подписи кнопок не несут телефона и почты; кнопки заявки текст туриста не берут`, () => {
      const list = inboxScreen(inbox(twoLeads), 0);
      const screens = [list, ...twoLeads.map((it) => itemCardScreen({ item: it, partner: guide, channel, base: 'https://vedarai.ru' }))];
      for (const sc of screens) {
        expect(sc.pd).toBe(false);
        for (const label of [sc.text, ...sc.rows.flat().map((b) => b.text)]) {
          expect(label).not.toMatch(/914|1234567|@|ya\.ru/);
        }
      }
      // Строка списка — номер и вид, без тура; кнопки карточки — без подписи туром.
      expect(list.rows.flat().map((b) => b.text).slice(0, 2)).toEqual(['1. Заявка на подбор', '2. Заявка на подбор']);
      const card = screens[1]!;
      expect(card.rows.flat().map((b) => b.text)).toEqual(expect.arrayContaining(['Связался', 'Договорились', 'Отказ']));
      expect(card.text).toContain('«[телефон] Толбачик»');
    });
  }
});

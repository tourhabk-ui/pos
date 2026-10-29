/**
 * «Входящие» в чате кабинета: свободный текст туриста не несёт его ПД (план
 * «гид в чате», шаг 9).
 *
 * У заявки тур словами и желаемые даты пишет сам турист — в форме сайта
 * («route_title», «desired_dates»). Туда вписывают и телефон. Список уходит в
 * Telegram (ПД туриста туда не идут — решение владельца 23.08) и в MAX
 * обычным ответом, а справка меню обещает «Имени и телефона туриста в этом
 * списке нет» в обоих. Здесь — вызовом `inboxMenuText` и экрана кнопки
 * `roleMenuScreen`: телефон и почта из этих полей не доходят ни до текста, ни
 * до подписи кнопки; даты и диапазоны — доходят как есть.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Inbox, InboxItem } from '@/lib/crm/inbox';

const m = vi.hoisted(() => ({ loadInbox: vi.fn() }));
vi.mock('@/lib/crm/inbox', () => ({ loadInbox: m.loadInbox }));

const { inboxMenuText } = await import('@/lib/roles/inbox-text');
const { roleMenuScreen } = await import('@/lib/roles/role-screen');

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

describe('экран «Входящие» гида со своими турами: подпись кнопки заявки', () => {
  const guide = { partnerId: '22222222-2222-4222-8222-222222222222', category: 'guide', slug: 'g', userId: 'u-1', sellsTours: true };
  // Подпись кнопки — первые 14 знаков тура: номер и почта стоят в начале,
  // чтобы обрезка сама их не спрятала.
  const twoLeads = [
    item({ id: '00000000-0000-4000-8000-0000000000c1', title: `89141234567 Толбачик` }),
    item({ id: '00000000-0000-4000-8000-0000000000c2', title: `me@ya.ru Мутновский` }),
  ];

  for (const channel of ['telegram', 'max'] as const) {
    it(`${channel}: ни текст, ни подписи кнопок не несут телефона и почты`, async () => {
      m.loadInbox.mockResolvedValue(inbox(twoLeads));
      const screen = await roleMenuScreen({ role: 'guide', action: 'inbox', channel, partner: guide, nowMs: Date.UTC(2026, 9, 29) });
      expect(screen.pd).toBe(false);
      const labels = (screen.buttons ?? []).flat().map((b) => b.text);
      // Кнопки заявки есть, подписаны туром, когда заявок две.
      expect(labels.some((t) => t.startsWith('Связался · '))).toBe(true);
      for (const label of [screen.text, ...labels]) {
        expect(label).not.toMatch(/914|1234567|@|ya\.ru/);
      }
      expect(labels).toContain('Связался · [телефон] Тол…');
    });
  }
});

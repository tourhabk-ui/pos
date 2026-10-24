/**
 * Меню роли в привязанном чате: кнопка есть только у уже написанного чтения.
 * Прокатчик пилота остаётся на своей строке rk:. Имени и телефона во
 * «Входящих» нет. Справка не называет цен.
 */
import { describe, expect, it } from 'vitest';
import { appendMenu } from '@/lib/roles/chat-menu';
import { inboxMenuText } from '@/lib/roles/inbox-text';
import {
  adminMenu, adminMenuHelp, menuRoleOf, parseRoleMenuPress, partnerMenu, partnerMenuHelp, roleMenuAsk,
} from '@/lib/roles/role-menu';
import { roleMenuScreen } from '@/lib/roles/role-screen';
import { rentalCabinetBar } from '@/lib/rental/cabinet-bar';
import { SUMMARY_PARTNER_IDS } from '@/lib/seat-requests/summary';
import type { Inbox, InboxItem } from '@/lib/crm/inbox';

const OTHER = '11111111-1111-4111-8111-111111111111';

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    kind: 'operator_booking',
    id: 'b1',
    created_at: '2026-10-24T00:00:00.000Z',
    title: 'Горелый <x>',
    date: '2026-11-01',
    people: 2,
    contact_id: 'c1',
    contact_name: 'Анна +79001234567',
    waiting_minutes: 90,
    ...over,
  };
}

function inbox(over: Partial<Inbox> = {}): Inbox {
  return {
    category: 'operator',
    items: [],
    failed: [],
    response: { window_days: 30, median_minutes: null, responded: 0, enough: false, complete: true },
    chat: { state: 'none' },
    not_here: ['Заявки без оператора — в разделе «Заявки с сайта»: здесь только заявки, отданные вам.'],
    ...over,
  };
}

describe('меню роли', () => {
  it('строка проката не сменилась и второй раз не клеится', () => {
    expect(rentalCabinetBar().map((b) => b.payload)).toEqual(['rk:fleet', 'rk:cal', 'rk:req', 'rk:edit', 'rk:help']);
    const bar = rentalCabinetBar();
    const once = appendMenu([], bar);
    expect(appendMenu(once, bar)).toBe(once);
  });

  it('оператор — входящие и помощь; сводка только у пилота запросов мест', () => {
    const plain = partnerMenu({ partnerId: OTHER, category: 'operator', slug: 'mesto' });
    expect(plain?.map((b) => b.text)).toEqual(['Входящие', 'Помощь']);
    expect(plain?.map((b) => b.payload)).toEqual(['rm:op:in', 'rm:op:hp']);
    const pilotId = [...SUMMARY_PARTNER_IDS][0];
    expect(pilotId).toBeTruthy();
    const withSummary = partnerMenu({ partnerId: pilotId ?? '', category: 'operator', slug: 'fishing' });
    expect(withSummary?.map((b) => b.payload)).toEqual(['rm:op:in', 'rm:op:sm', 'rm:op:hp']);
  });

  it('пилот проката, агент и снаряжение меню роли не получают', () => {
    expect(menuRoleOf({ partnerId: OTHER, category: 'transfer', slug: 'laguna-prokat' })).toBeNull();
    expect(partnerMenu({ partnerId: OTHER, category: 'transfer', slug: 'laguna-prokat' })).toBeNull();
    expect(partnerMenu({ partnerId: OTHER, category: 'agent', slug: 'agent-1' })).toBeNull();
    expect(partnerMenu({ partnerId: OTHER, category: 'gear', slug: 'gear-1' })).toBeNull();
    expect(partnerMenu({ partnerId: OTHER, category: 'transfer', slug: 'carrier-1' })?.map((b) => b.payload))
      .toEqual(['rm:tf:in', 'rm:tf:hp']);
    expect(partnerMenu({ partnerId: OTHER, category: 'stay', slug: 'turbaza' })?.map((b) => b.payload))
      .toEqual(['rm:st:in', 'rm:st:hp']);
    expect(partnerMenu({ partnerId: OTHER, category: 'guide', slug: 'guide-1' })?.map((b) => b.payload))
      .toEqual(['rm:gd:in', 'rm:gd:hp']);
  });

  it('админ — шесть чтений, входящих у него нет', () => {
    const row = adminMenu();
    expect(row.map((b) => b.text)).toEqual(['Даты', 'Брони', 'Заявки', 'Сводка', 'Здоровье', 'Помощь']);
    expect(row.map((b) => b.payload)).toEqual(['rm:ad:dt', 'rm:ad:bk', 'rm:ad:ld', 'rm:ad:sm', 'rm:ad:hl', 'rm:ad:hp']);
    for (const b of row) expect(b.payload.length).toBeLessThan(64);
    expect(parseRoleMenuPress('rm:ad:bk')).toEqual({ role: 'admin', action: 'bookings' });
    expect(parseRoleMenuPress('rm:ad:in')).toBeNull();
    expect(parseRoleMenuPress('rm:op:bk')).toBeNull();
    expect(parseRoleMenuPress('rm:zz:in')).toBeNull();
    expect(parseRoleMenuPress('rk:req')).toBeNull();
  });

  it('фраза кнопки — только точная; «заявки» и «покажи входящие» не она', () => {
    expect(roleMenuAsk('Входящие')).toBe('inbox');
    expect(roleMenuAsk('мои входящие')).toBe('inbox');
    expect(roleMenuAsk('Помощь')).toBe('help');
    expect(roleMenuAsk('Новые заявки')).toBe('inbox');
    expect(roleMenuAsk('Мои заявки')).toBe('inbox');
    expect(roleMenuAsk('Мои туры и цены')).toBe('tours');
    expect(roleMenuAsk('Обновить места')).toBe('seats');
    expect(roleMenuAsk('заявки')).toBeNull();
    expect(roleMenuAsk('покажи входящие')).toBeNull();
    expect(roleMenuAsk('найди мне в аренду автомобиль')).toBeNull();
  });

  it('справка называет только свои кнопки и не называет цен', () => {
    const menu = partnerMenu({ partnerId: OTHER, category: 'transfer', slug: 'carrier-1' }) ?? [];
    const help = partnerMenuHelp('transfer', menu);
    expect(help).toContain('Входящие');
    expect(help).toContain('Помощь');
    expect(help).not.toContain('Сводка');
    expect(help).not.toContain('Мои машины');
    expect(help).not.toMatch(/<|>/);
    expect(help).not.toMatch(/₽/);
    expect(adminMenuHelp()).not.toMatch(/₽|<|>/);
    expect(adminMenuHelp()).toContain('только в MAX');
  });
});

describe('текст входящих', () => {
  it('имя и телефон не попадают в список, угол в названии экранирован', () => {
    const text = inboxMenuText(inbox({ items: [item()] }));
    expect(text).toContain('Горелый &lt;x&gt;');
    expect(text).toContain('Бронь тура');
    expect(text).not.toContain('Анна');
    expect(text).not.toContain('+79001234567');
    expect(text).not.toContain('7900');
    expect(text).toContain('Заявки без оператора');
  });

  it('непрочитанный вид назван и не выдаётся за пустой список', () => {
    const text = inboxMenuText(inbox({ failed: ['lead'], items: [] }));
    expect(text).toContain('Заявка на подбор');
    expect(text).toContain('Это не «таких нет»');
    expect(text).not.toMatch(/Ждут ответа: нет/);
    expect(text).not.toMatch(/пока нет/);
  });

  it('непрочитанные чата — только когда счёт сошёлся', () => {
    expect(inboxMenuText(inbox({ chat: { state: 'ok', unread: 3 } }))).toContain('Непрочитанных сообщений в чате кабинета: 3');
    expect(inboxMenuText(inbox({ chat: { state: 'ok', unread: 0 } }))).not.toContain('Непрочитанных');
    expect(inboxMenuText(inbox({ chat: { state: 'failed' } }))).toContain('не посчитались');
    expect(inboxMenuText(inbox({ chat: { state: 'none' } }))).not.toContain('не посчитались');
  });
});

describe('экран кнопки', () => {
  it('сводка выключена — так и сказано, базу не спрашиваем смыслом ответа', async () => {
    const screen = await roleMenuScreen({
      role: 'operator',
      action: 'summary',
      channel: 'telegram',
      partner: { partnerId: OTHER, category: 'operator', slug: 'mesto' },
    });
    expect(screen.pd).toBe(false);
    expect(screen.text).toContain('не включена');
  });

  it('чужая кнопка в этом чате не выполняется', async () => {
    const screen = await roleMenuScreen({
      role: 'guide',
      action: 'inbox',
      channel: 'max',
      partner: { partnerId: OTHER, category: 'operator', slug: 'mesto' },
    });
    expect(screen.text).toContain('другой роли');
  });
});

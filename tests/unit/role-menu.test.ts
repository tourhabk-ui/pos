/**
 * Меню роли в привязанном чате: кнопка есть только у уже написанного чтения.
 * Строка партнёра — вкладки кабинета в чате (30.10): «Входящие», «Задачи»,
 * «Клиенты», «Ещё»; прежние кнопки — в «Ещё». Прокатчик пилота остаётся на
 * своей строке rk:. Справка не называет цен. Экран «Входящих» судит
 * tests/unit/chat-cabinet-screens.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { appendMenu } from '@/lib/roles/chat-menu';
import {
  adminMenu, adminMenuHelp, menuRoleOf, parseRoleMenuPress, partnerMenu, partnerMenuExtras, partnerMenuHelp, roleMenuAsk,
} from '@/lib/roles/role-menu';
import { roleMenuScreen } from '@/lib/roles/role-screen';
import { operatorSeatsText } from '@/lib/telegram/operator-desk';
import { rentalCabinetBar } from '@/lib/rental/cabinet-bar';
import { SUMMARY_PARTNER_IDS } from '@/lib/seat-requests/summary';

const OTHER = '11111111-1111-4111-8111-111111111111';
const TABS = ['Входящие', 'Задачи', 'Клиенты', 'Ещё'];
const tabs = (code: string) => ['in', 'tk', 'cl', 'mn'].map((a) => `rm:${code}:${a}`);

describe('меню роли', () => {
  it('строка проката не сменилась и второй раз не клеится', () => {
    expect(rentalCabinetBar().map((b) => b.payload)).toEqual(['rk:fleet', 'rk:cal', 'rk:req', 'rk:edit', 'rk:help']);
    const bar = rentalCabinetBar();
    const once = appendMenu([], bar);
    expect(appendMenu(once, bar)).toBe(once);
  });

  it('оператор — вкладки кабинета; в «Ещё» помощь, сводка — только у пилота запросов мест', () => {
    const plain = { partnerId: OTHER, category: 'operator', slug: 'mesto' };
    expect(partnerMenu(plain)?.map((b) => b.text)).toEqual(TABS);
    expect(partnerMenu(plain)?.map((b) => b.payload)).toEqual(tabs('op'));
    expect(partnerMenuExtras(plain).map((b) => b.payload)).toEqual(['rm:op:hp']);
    const pilotId = [...SUMMARY_PARTNER_IDS][0];
    expect(pilotId).toBeTruthy();
    const pilot = { partnerId: pilotId ?? '', category: 'operator', slug: 'fishing' };
    expect(partnerMenu(pilot)?.map((b) => b.payload)).toEqual(tabs('op'));
    expect(partnerMenuExtras(pilot).map((b) => b.payload)).toEqual(['rm:op:sm', 'rm:op:hp']);
    for (const b of partnerMenu(pilot) ?? []) expect(b.payload.length).toBeLessThan(64);
  });

  it('пилот проката, агент и снаряжение меню роли не получают', () => {
    expect(menuRoleOf({ partnerId: OTHER, category: 'transfer', slug: 'laguna-prokat' })).toBeNull();
    expect(partnerMenu({ partnerId: OTHER, category: 'transfer', slug: 'laguna-prokat' })).toBeNull();
    expect(partnerMenu({ partnerId: OTHER, category: 'agent', slug: 'agent-1' })).toBeNull();
    expect(partnerMenu({ partnerId: OTHER, category: 'gear', slug: 'gear-1' })).toBeNull();
    expect(partnerMenuExtras({ partnerId: OTHER, category: 'transfer', slug: 'laguna-prokat' })).toEqual([]);
    expect(partnerMenu({ partnerId: OTHER, category: 'transfer', slug: 'carrier-1' })?.map((b) => b.payload))
      .toEqual(tabs('tf'));
    expect(partnerMenu({ partnerId: OTHER, category: 'stay', slug: 'turbaza' })?.map((b) => b.payload))
      .toEqual(tabs('st'));
    expect(partnerMenu({ partnerId: OTHER, category: 'guide', slug: 'guide-1' })?.map((b) => b.payload))
      .toEqual(tabs('gd'));
  });

  it('гид, который продаёт свои туры, — в «Ещё» «Брони» и «Мои туры»; гид команды и оператор — без них (29.10)', () => {
    const seller = { partnerId: OTHER, category: 'guide', slug: 'g-1', sellsTours: true };
    expect(partnerMenu(seller)?.map((b) => b.text)).toEqual(TABS);
    expect(partnerMenuExtras(seller).map((b) => b.text)).toEqual(['Брони', 'Мои туры', 'Помощь']);
    expect(partnerMenuExtras(seller).map((b) => b.payload)).toEqual(['rm:gd:bk', 'rm:gd:tr', 'rm:gd:hp']);
    for (const b of partnerMenuExtras(seller)) expect(b.payload.length).toBeLessThan(64);
    expect(partnerMenuExtras({ partnerId: OTHER, category: 'guide', slug: 'g-2', sellsTours: false }).map((b) => b.payload))
      .toEqual(['rm:gd:hp']);
    // Признак у туроператора «Ещё» меню роли не меняет: его туры — кнопки его кабинета (opd:) и /tours.
    expect(partnerMenuExtras({ partnerId: OTHER, category: 'operator', slug: 'op', sellsTours: true }).map((b) => b.payload))
      .toEqual(['rm:op:hp']);

    expect(parseRoleMenuPress('rm:gd:bk')).toEqual({ role: 'guide', action: 'bookings' });
    expect(parseRoleMenuPress('rm:gd:tr')).toEqual({ role: 'guide', action: 'tours' });
    for (const p of ['rm:op:tr', 'rm:st:bk', 'rm:tf:tr', 'rm:ad:tr', 'rm:gd:dt', 'rm:gd:ld']) {
      expect(parseRoleMenuPress(p), p).toBeNull();
    }
  });

  it('вкладки кабинета в чате разбираются у всех ролей партнёра и не у администратора (30.10)', () => {
    for (const [code, role] of [['op', 'operator'], ['tf', 'transfer'], ['st', 'stay'], ['gd', 'guide']] as const) {
      expect(parseRoleMenuPress(`rm:${code}:tk`)).toEqual({ role, action: 'tasks' });
      expect(parseRoleMenuPress(`rm:${code}:cl`)).toEqual({ role, action: 'clients' });
      expect(parseRoleMenuPress(`rm:${code}:mn`)).toEqual({ role, action: 'more' });
    }
    for (const p of ['rm:ad:tk', 'rm:ad:cl', 'rm:ad:mn']) expect(parseRoleMenuPress(p), p).toBeNull();
  });

  it('справка гида-продавца называет «Брони» и «Мои туры» и где их нет; у гида команды — ни слова о них', () => {
    const help = partnerMenuHelp('guide', { partnerId: OTHER, category: 'guide', slug: 'g-1', sellsTours: true });
    expect(help).toContain('Под ответами кнопки: Входящие, Задачи, Клиенты, Ещё.');
    expect(help).toContain('Ещё — Брони, Мои туры, Ежедневная сводка, Помощь, кабинет на сайте.');
    // Время сводки выбирается (1354) — справка не обещает «утром».
    expect(help).toContain('«Ежедневная сводка» в «Ещё»');
    expect(help).not.toMatch(/^Утром/m);
    expect(help).toContain('Имя и телефон туриста — только в MAX');
    expect(help).toContain('/hub/guide/own');
    // Кнопки ответа брони (шаг 6) названы — и что бронь меняется только после «Да».
    expect(help).toContain('«Подтвердить» и «Отклонить»');
    expect(help).toContain('бронь меняется только после «Да»');
    expect(help).not.toMatch(/₽/);
    // Даты словами (шаг 8): фраза в личном диалоге MAX и кнопка «Открыть».
    expect(help).toContain('Даты можно открыть фразой в личном диалоге с ботом в MAX, например «открой субботы июля, 8 мест»');
    expect(help).toContain('откроет после кнопки «Открыть»');
    const team = partnerMenuHelp('guide', { partnerId: OTHER, category: 'guide', slug: 'g-2' });
    expect(team).not.toMatch(/Брони|Мои туры|Подтвердить|открой субботы/);
  });

  it('справка туроператора: кнопки брони в карточке и ответ на заявку, «Ещё» — его кабинет (30.10)', () => {
    const help = partnerMenuHelp('operator', { partnerId: OTHER, category: 'operator', slug: 'op' });
    expect(help).toContain('«Подтвердить» и «Отклонить»');
    expect(help).toContain('«Принять», «Нет мест», «Уточнить», «Свяжусь сам»');
    expect(help).toContain('Ещё — Мои туры и цены, Обновить места, Ежедневная сводка, Помощь, Написать в поддержку, кабинет на сайте.');
    expect(help).not.toMatch(/«Связался»|Брони —/);
  });

  it('«Обновить места» гида со своими турами: его раздел «Свои туры» и фраза в MAX; кабинета оператора нет (29.10)', () => {
    const guide = operatorSeatsText('guide');
    expect(guide).toMatch(/Откройте даты в разделе «Свои туры»: https?:\/\/\S+\/hub\/guide\/own/);
    expect(guide).toContain('В MAX можно написать фразу целиком, например: «открой весь ноябрь, 8 мест» — там есть кнопка подтверждения.');
    expect(guide).not.toMatch(/\/hub\/operator/);
    // Туроператору — прежний текст: календарь кабинета и та же фраза.
    expect(operatorSeatsText()).toMatch(/Откройте календарь: https?:\/\/\S+\/hub\/operator\/calendar/);
    expect(operatorSeatsText()).toContain('«открой весь ноябрь, 8 мест»');
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
    expect(roleMenuAsk('Задачи')).toBe('tasks');
    expect(roleMenuAsk('мои задачи')).toBe('tasks');
    expect(roleMenuAsk('Клиенты')).toBe('clients');
    expect(roleMenuAsk('мои клиенты')).toBe('clients');
    expect(roleMenuAsk('покажи задачи')).toBeNull();
    expect(roleMenuAsk('меню')).toBeNull();
    expect(roleMenuAsk('заявки')).toBeNull();
    expect(roleMenuAsk('покажи входящие')).toBeNull();
    expect(roleMenuAsk('найди мне в аренду автомобиль')).toBeNull();
  });

  it('справка называет только свои кнопки и не называет цен', () => {
    const help = partnerMenuHelp('transfer', { partnerId: OTHER, category: 'transfer', slug: 'carrier-1' });
    expect(help).toContain('Входящие');
    expect(help).toContain('Помощь');
    expect(help).not.toContain('Сводка');
    expect(help).not.toContain('Мои машины');
    expect(help).not.toMatch(/<|>/);
    expect(help).not.toMatch(/₽/);
    expect(adminMenuHelp()).not.toMatch(/₽|<|>/);
    expect(adminMenuHelp()).toContain('только в MAX');
  });

  it('справка гида называет то, что правда стоит в его «Входящих»: брони, запросы мест и заявки своих туров (29.10)', async () => {
    const { INBOX_BY_CATEGORY } = await import('@/lib/crm/inbox-kinds');
    const help = partnerMenuHelp('guide', { partnerId: OTHER, category: 'guide', slug: 'guide-1' });
    expect(INBOX_BY_CATEGORY.guide).toEqual(expect.arrayContaining(['operator_booking', 'seat_request', 'lead']));
    expect(help).toContain('брони, запросы мест и заявки на туры, которые вы продаёте сами');
    expect(help).toContain('Имени и телефона туриста в этом списке нет');
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

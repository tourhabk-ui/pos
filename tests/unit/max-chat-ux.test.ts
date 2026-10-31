/**
 * Кабинет в MAX проще (снимок владельца 31.10, «изучить макс и предложить
 * варианты проще лучше ux/ui», выбраны «Исправления»):
 *
 * - строка меню — не больше трёх кнопок в ряду: четыре в ряд MAX режет
 *   подписи («Входящ…»), прокат шёл пятью;
 * - «Обновить места» в MAX — даты кнопками (судит chat-dates-wizard), а не
 *   текст Telegram («В MAX можно…» в самом MAX был нелеп); в Telegram —
 *   текст про кабинет и MAX;
 * - образец фразы — следующий месяц, и разбор его принимает: «весь ноябрь»
 *   в декабре был бы прошедшим;
 * - «Мои туры и цены» без живых туров называет причину и куда идти, а не
 *   «Цену не называю» и тупик.
 *
 * Судится вызовом: ряды, тексты, разбор образца, нажатие кнопки.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findPartnerByChat = vi.fn();
const readPartnerTours = vi.fn();
vi.mock('@/lib/operators/chat-dates/proposals', async (orig) => ({
  ...(await orig<typeof import('@/lib/operators/chat-dates/proposals')>()),
  readPartnerTours: (...args: unknown[]) => readPartnerTours(...args),
}));
vi.mock('@/lib/operators/chat-dates/switch', () => ({ CHAT_OPEN_DATES_ENABLED: true }));
vi.mock('@/lib/kuzmich/operator-chat', () => ({
  findPartnerByChat: (...args: unknown[]) => findPartnerByChat(...args),
  processPartnerMessage: vi.fn(),
}));

import { appendMenu, MENU_ROW_MAX, menuRows, type MenuButton } from '@/lib/roles/chat-menu';
import { adminMenu, partnerMenu } from '@/lib/roles/role-menu';
import { rentalCabinetBar, withRentalCabinetBar } from '@/lib/rental/cabinet-bar';
import { cabinetNavRow, noticeScreen } from '@/lib/chat-cabinet/screens';
import { operatorSeatsText, operatorToursReply, operatorToursText } from '@/lib/telegram/operator-desk';
import { operatorDeskPress } from '@/lib/telegram/operator-desk-press';
import { parseDatesPhrase } from '@/lib/operators/chat-dates/parse';

const OTHER = '11111111-1111-4111-8111-111111111111';
const b = (n: number): MenuButton[] => Array.from({ length: n }, (_, i) => ({ text: `К${i}`, payload: `p:${i}` }));
const shape = (rows: unknown[][]) => rows.map((r) => r.length);
// 15 ноября по Камчатке: образец обязан звать на декабрь.
const NOV_15 = Date.parse('2026-11-15T00:00:00+12:00');

describe('строка меню в MAX — не больше трёх в ряду', () => {
  it('ряды поровну: 4 — 2+2, 5 — 3+2, 6 — 3+3, 3 и меньше — один ряд', () => {
    expect(shape(menuRows(b(1)))).toEqual([1]);
    expect(shape(menuRows(b(3)))).toEqual([3]);
    expect(shape(menuRows(b(4)))).toEqual([2, 2]);
    expect(shape(menuRows(b(5)))).toEqual([3, 2]);
    expect(shape(menuRows(b(6)))).toEqual([3, 3]);
    expect(shape(menuRows(b(7)))).toEqual([3, 2, 2]);
    expect(menuRows([])).toEqual([]);
    // Порядок кнопок не меняется — меняются только ряды.
    expect(menuRows(b(5)).flat().map((x) => x.payload)).toEqual(b(5).map((x) => x.payload));
  });

  it('строка каждой роли под ответом — рядами по ≤3, подписи целы', () => {
    const bars = [
      partnerMenu({ partnerId: OTHER, category: 'operator', slug: 'op' }),
      partnerMenu({ partnerId: OTHER, category: 'guide', slug: 'g' }),
      partnerMenu({ partnerId: OTHER, category: 'transfer', slug: 't' }),
      partnerMenu({ partnerId: OTHER, category: 'stay', slug: 's' }),
      adminMenu(),
      rentalCabinetBar(),
    ];
    for (const bar of bars) {
      expect(bar).toBeTruthy();
      const rows = appendMenu([[{ text: 'Действие', payload: 'x:1' }]], bar ?? []);
      expect(rows[0]?.[0]?.payload).toBe('x:1');
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(MENU_ROW_MAX);
      expect(rows.slice(1).flat().map((x) => x.payload)).toEqual((bar ?? []).map((x) => x.payload));
    }
    // Четыре вкладки — два ряда по два: «Входящие» больше не режется.
    const op = partnerMenu({ partnerId: OTHER, category: 'operator', slug: 'op' }) ?? [];
    expect(appendMenu([], op).map((r) => r.map((x) => x.text))).toEqual([['Входящие', 'Задачи'], ['Клиенты', 'Ещё']]);
    expect(shape(withRentalCabinetBar([]))).toEqual([3, 2]);
  });

  it('повтор строки не клеится, даже когда она в два ряда', () => {
    const bar = b(4);
    const once = appendMenu([[{ text: 'Да', payload: 'y' }]], bar);
    expect(appendMenu(once, bar)).toBe(once);
    // Похожий, но другой хвост — строка клеится.
    const other = appendMenu([[{ text: 'Да', payload: 'y' }], [bar[2]!, bar[3]!]], bar);
    expect(shape(other)).toEqual([1, 2, 2, 2]);
  });

  it('строка кабинета под экраном — два ряда по два', () => {
    const rows = noticeScreen('Готово', true).rows;
    expect(rows.map((r) => r.map((x) => x.payload))).toEqual([['cb:i', 'cb:t'], ['cb:c', 'cb:m']]);
    expect(rows.flat().map((x) => x.text)).toEqual(cabinetNavRow().map((x) => x.text));
  });
});

describe('«Обновить места» говорит про свой канал', () => {
  it('Telegram: подтверждения нет — кабинет или MAX, без «прямо здесь»', () => {
    const tg = operatorSeatsText('operator', NOV_15);
    expect(tg).toContain('В Telegram даты не открываю');
    expect(tg).toMatch(/календаре кабинета: https?:\/\/\S+\/hub\/operator\/calendar/);
    expect(tg).toContain('Или в MAX — кнопками «Обновить места» или одной фразой, например «открой весь декабрь, 8 мест»');
    expect(tg).not.toContain('прямо здесь');
    const guide = operatorSeatsText('guide', NOV_15);
    expect(guide).toMatch(/разделе «Свои туры»: https?:\/\/\S+\/hub\/guide\/own/);
    expect(guide).not.toMatch(/\/hub\/operator/);
  });

  it('образец — следующий месяц, и разбор дат принимает его как предложение', () => {
    for (const now of [NOV_15, Date.parse('2026-12-20T00:00:00+12:00'), Date.parse('2027-07-01T00:00:00+12:00')]) {
      const text = operatorSeatsText('operator', now);
      const phrase = text.match(/«(открой [^»]+)»/)?.[1];
      expect(phrase).toBeTruthy();
      const parsed = parseDatesPhrase(phrase ?? '', now, [{ id: '1', title: 'Горелый', active: true }]);
      expect(parsed.kind).toBe('proposal');
      if (parsed.kind === 'proposal') {
        expect(parsed.seats).toBe(8);
        expect(parsed.dates.length).toBeGreaterThanOrEqual(28);
        expect(parsed.pastDropped).toEqual([]);
      }
    }
  });

  it('нажатие «Обновить места»: MAX в диалоге — даты кнопками, MAX в группе — «в личном диалоге», Telegram — текст', async () => {
    findPartnerByChat.mockResolvedValue({
      outcome: 'found',
      partner: { partnerId: OTHER, category: 'operator', slug: 'op', userId: 'u1', sellsTours: true },
    });
    readPartnerTours.mockResolvedValue([
      { id: '11', title: 'Вулкан Горелый', active: true },
      { id: '12', title: 'Рыбалка', active: true },
      { id: '13', title: 'Скрытый сплав', active: false },
    ]);
    const max = await operatorDeskPress({ channel: 'max', chatId: 1, payload: 'opd:seats', dialog: true, nowMs: NOV_15 });
    expect(max?.text).toContain('Для какого тура?');
    const payloads = (max?.buttons ?? []).flat().map((b) => b.payload);
    expect(payloads).toEqual(expect.arrayContaining(['dw:m:11', 'dw:m:12', 'dw:x']));
    expect(payloads).not.toContain('dw:m:13');
    for (const row of max?.buttons ?? []) expect(row.length).toBeLessThanOrEqual(MENU_ROW_MAX);
    const group = await operatorDeskPress({ channel: 'max', chatId: 1, payload: 'opd:seats', dialog: false, nowMs: NOV_15 });
    expect(group?.text).toContain('только в личном диалоге');
    expect((group?.buttons ?? []).flat().some((b) => b.payload.startsWith('dw:'))).toBe(false);
    const tg = await operatorDeskPress({ channel: 'telegram', chatId: 1, payload: 'opd:seats', nowMs: NOV_15 });
    expect(tg?.text).toContain('В Telegram даты не открываю');
    expect((tg?.buttons ?? []).flat().some((b) => b.payload.startsWith('dw:'))).toBe(false);
  });
});

describe('«Мои туры и цены» без туров — не тупик', () => {
  beforeEach(() => findPartnerByChat.mockReset());

  it('пусто: почему туристы не видят и куда идти', () => {
    const text = operatorToursText([]);
    expect(text).toContain('опубликованные и включённые');
    expect(text).toMatch(/кабинете: https?:\/\/\S+\/hub\/operator\/tours/);
    expect(text).not.toContain('Цену не называю');
  });

  it('база не ответила: так и сказано, и ссылка на кабинет', () => {
    const text = operatorToursReply({ ok: false });
    expect(text).toContain('Не смог прочитать');
    expect(text).toMatch(/\/hub\/operator\/tours/);
    expect(text).not.toContain('Цену не называю');
  });
});

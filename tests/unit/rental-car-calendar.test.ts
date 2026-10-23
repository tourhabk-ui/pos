// @vitest-environment node
/**
 * Календарь проката: 30 дней по Камчатке, день без строки — «не отмечено»,
 * отметку пишет только чат хозяина машины. Витрина таблицу не читает.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { kamchatkaDate, shiftDate } from '@/lib/analytics/kamchatka-day';
import {
  calendarAsk, calendarBody, calendarButtons, carPickButtons, horizonEnd, pageStartFor, parseCalendarPress,
  setPayload, RENTAL_CALENDAR_TOOL,
} from '@/lib/rental/car-calendar';
import { loadCalendarCars, loadCalendarMarks, setOperatorMark } from '@/lib/rental/car-calendar-store';
import { handleRentalCalendarPress, handleRentalCalendarText } from '@/lib/rental/car-calendar-flow';
import { partnerSystemPrompt } from '@/lib/kuzmich/operator-chat';
import { containsPattern } from '@/lib/db/like';

const NOW = Date.parse('2026-10-23T15:00:00Z');
const TODAY = kamchatkaDate(new Date(NOW));
const OFFER = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const pilot = { partnerId: PARTNER, partnerName: 'Лагуна Прокат', slug: 'laguna-prokat' };

beforeEach(() => {
  query.mockReset();
  vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('разбор календаря', () => {
  it('фраза про календарь — да, чужая — нет', () => {
    expect(calendarAsk('календарь')).toEqual({ car: '' });
    expect(calendarAsk('Покажи мой календарь Jimny')).toEqual({ car: 'jimny' });
    expect(calendarAsk('какие туры открыты')).toBeNull();
    expect(calendarAsk('покажи машины')).toBeNull();
  });

  it('кнопка: день, окно, список; 30 февраля и длинный payload не принимаются', () => {
    expect(parseCalendarPress(`rb:o:${OFFER}`)).toEqual({ kind: 'open', offerId: OFFER });
    expect(parseCalendarPress('rb:list')).toEqual({ kind: 'list' });
    expect(parseCalendarPress(setPayload(OFFER, TODAY, true))).toEqual({ kind: 'set', offerId: OFFER, day: TODAY, busy: true });
    expect(parseCalendarPress(`rb:s:${OFFER}:2026-02-30:1`)).toBeNull();
    expect(parseCalendarPress('rb:s:not-a-uuid:2026-10-24:1')).toBeNull();
    expect(setPayload(OFFER, TODAY, false).length).toBeLessThan(64);
  });

  it('страница — семь дней от сегодня, день вне 30 не открывается', () => {
    expect(pageStartFor(TODAY, TODAY)).toBe(TODAY);
    expect(pageStartFor(TODAY, shiftDate(TODAY, 7))).toBe(shiftDate(TODAY, 7));
    expect(pageStartFor(TODAY, shiftDate(TODAY, 1))).toBe(TODAY);
    expect(pageStartFor(TODAY, shiftDate(TODAY, -1))).toBeNull();
    expect(pageStartFor(TODAY, shiftDate(TODAY, 30))).toBeNull();
    expect(horizonEnd(TODAY)).toBe(shiftDate(TODAY, 29));
    const buttons = calendarButtons({ today: TODAY, offerId: OFFER, start: TODAY, showList: true });
    expect(buttons[0]).toHaveLength(2);
    expect(buttons.some((row) => row.some((b) => b.payload === 'rb:list'))).toBe(true);
    expect(calendarButtons({ today: TODAY, offerId: OFFER, start: shiftDate(TODAY, 1), showList: false })).toEqual([]);
  });

  it('день без отметки не называется свободным, название из базы экранируется', () => {
    const text = calendarBody({
      cars: [{ id: OFFER, title: 'Jimny <b>', active: false }],
      query: '', today: TODAY, focus: { id: OFFER, title: 'Jimny <b>', active: false },
      marks: new Map([[TODAY, true]]), canMark: true,
    });
    expect(text).toContain('Jimny &lt;b&gt;');
    expect(text).toContain('скрыта из прайса');
    expect(text).toContain('не отмечено');
    expect(text).toContain('занята');
    expect(text).toMatch(/не «свободна»/);
    expect(text).not.toContain('Jimny <b>');
    const pick = carPickButtons([{ id: OFFER, title: 'Jimny <b>', active: true }]);
    expect(pick[0]?.[0]?.text).not.toMatch(/[<>&]/);
  });

  it('витрина проката календарь не читает', () => {
    const src = readFileSync('lib/rental/rental.ts', 'utf8');
    expect(src).not.toMatch(/rental_car_busy/);
  });

  it('подсказка пилота зовёт календарь и запрещает назвать неотмеченный день свободным', () => {
    const prompt = partnerSystemPrompt(
      { partnerId: PARTNER, partnerName: 'Лагуна', slug: 'laguna-prokat', category: 'transfer', crmCategory: 'transfer', userId: null },
      NOW, true,
    );
    expect(prompt).toMatch(/operator_rental_calendar/);
    expect(prompt).toMatch(/не отмечено/);
    expect(RENTAL_CALENDAR_TOOL.function.description).toMatch(/не ставит/);
    expect(partnerSystemPrompt(
      { partnerId: PARTNER, partnerName: 'Лагуна', slug: 'fishing', category: 'transfer', crmCategory: 'transfer', userId: null },
      NOW, true,
    )).not.toMatch(/operator_rental_calendar/);
  });
});

describe('запись отметки', () => {
  it('вставка требует машину этого партнёра; пустой ответ — не его', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await setOperatorMark(PARTNER, OFFER, TODAY, true)).toBe('not_yours');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/partner_id = \$2::uuid/);
    expect(sql).toMatch(/ON CONFLICT \(offer_id, day\)/);
    expect(params).toEqual([OFFER, PARTNER, TODAY, true]);
  });

  it('отказ базы — не «записано»', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57P01' }));
    expect(await setOperatorMark(PARTNER, OFFER, TODAY, false)).toBe('db_error');
  });

  it('чтение: кривая отметка — отказ, а не догадка', async () => {
    query.mockResolvedValueOnce({ rows: [{ day: TODAY, busy: 'yes' }] });
    expect(await loadCalendarMarks(OFFER, TODAY, horizonEnd(TODAY))).toBe('db_error');
  });

  it('поиск по названию экранирует шаблон', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await loadCalendarCars(PARTNER, '100%');
    expect(query.mock.calls[0][1][2]).toBe(containsPattern('100%'));
  });
});

describe('поток чата', () => {
  const sent: Array<{ text: string; buttons: number; edit: string | null }> = [];
  const send = async (text: string, buttons: unknown[][], editMid: string | null) => {
    sent.push({ text, buttons: buttons.length, edit: editMid });
  };

  beforeEach(() => { sent.length = 0; });

  it('«календарь» ничего не пишет и не называет неотмеченный день свободным', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: OFFER, title: 'Suzuki Jimny', is_active: true }] });
    query.mockResolvedValueOnce({ rows: [] });
    const handled = await handleRentalCalendarText({
      partner: pilot, text: 'календарь', nowMs: NOW, dialog: true, canMark: true, send,
    });
    expect(handled).toBe(true);
    expect(query.mock.calls.some((c) => /INSERT INTO rental_car_busy/.test(String(c[0])))).toBe(false);
    expect(sent[0]?.text).toContain('не отмечено');
    expect(sent[0]?.text).toContain('Suzuki Jimny');
    expect(sent[0]?.buttons).toBeGreaterThan(0);
  });

  it('в группе список не читается', async () => {
    const handled = await handleRentalCalendarText({
      partner: pilot, text: 'календарь', nowMs: NOW, dialog: false, canMark: true, send,
    });
    expect(handled).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(sent[0]?.text).toMatch(/личном диалоге/);
  });

  it('не пилот — фраза уходит дальше, база не читается', async () => {
    const handled = await handleRentalCalendarText({
      partner: { ...pilot, slug: 'fishing' }, text: 'календарь', nowMs: NOW, dialog: true, canMark: true, send,
    });
    expect(handled).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('кнопка «Занята» пишет день этого партнёра и правит то же сообщение', async () => {
    query.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (/FROM car_rental_offers/.test(s)) return { rows: [{ id: OFFER, title: 'Suzuki Jimny', is_active: true }] };
      if (/INSERT INTO rental_car_busy/.test(s)) return { rows: [{ offer_id: OFFER }] };
      if (/FROM rental_car_busy/.test(s)) return { rows: [{ day: TODAY, busy: true }] };
      return { rows: [] };
    });
    await handleRentalCalendarPress({
      lookup: { outcome: 'found', partner: pilot },
      payload: setPayload(OFFER, TODAY, true),
      nowMs: NOW,
      editMid: 'mid-1',
      send,
    });
    const insert = query.mock.calls.find((c) => /INSERT INTO rental_car_busy/.test(String(c[0])));
    expect(insert?.[1]).toEqual([OFFER, PARTNER, TODAY, true]);
    expect(sent[0]?.edit).toBe('mid-1');
    expect(sent[0]?.text).toContain('занята');
    expect(sent[0]?.text).toContain('не отмечено');
  });

  it('чужая машина и день вне горизонта не пишутся', async () => {
    query.mockResolvedValue({ rows: [{ id: OFFER, title: 'Suzuki Jimny', is_active: true }] });
    await handleRentalCalendarPress({
      lookup: { outcome: 'found', partner: pilot },
      payload: setPayload('99999999-9999-4999-8999-999999999999', TODAY, true),
      nowMs: NOW, editMid: null, send,
    });
    await handleRentalCalendarPress({
      lookup: { outcome: 'found', partner: pilot },
      payload: setPayload(OFFER, '2020-01-01', true),
      nowMs: NOW, editMid: null, send,
    });
    expect(query.mock.calls.some((c) => /INSERT INTO rental_car_busy/.test(String(c[0])))).toBe(false);
    expect(sent.map((s) => s.text).join('\n')).toMatch(/не в вашем прайсе/);
    expect(sent.map((s) => s.text).join('\n')).toMatch(/вне ближайших 30/);
  });

  it('чат не проверен — отметка не пишется, и это не «не ваша»', async () => {
    await handleRentalCalendarPress({
      lookup: { outcome: 'unavailable' },
      payload: setPayload(OFFER, TODAY, true),
      nowMs: NOW, editMid: null, send,
    });
    expect(query).not.toHaveBeenCalled();
    expect(sent[0]?.text).toMatch(/Не удалось проверить/);
  });
});

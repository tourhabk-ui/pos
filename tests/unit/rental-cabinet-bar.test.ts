/**
 * Строка кнопок кабинета прокатчика: состав, тексты списков, развилка
 * «это кабинет». Цены в справке нет. Имя и телефон заявки — только в MAX.
 */
import { describe, expect, it } from 'vitest';
import {
  parseRentalCabinetPress, rentalCabinetAsk, rentalCabinetBar, rentalCabinetHelp, telegramCabinetMarkup, withRentalCabinetBar,
} from '@/lib/rental/cabinet-bar';
import { rentalEditsText, rentalRequestsView, type CabinetEditRow, type CabinetRequestRow } from '@/lib/rental/cabinet-read';

const LEAD = '33333333-3333-4333-8333-333333333333';

const openRequest: CabinetRequestRow = {
  leadId: LEAD,
  name: 'Анна <П>',
  phone: '+79001234567',
  title: 'Jimny',
  dateFrom: '2026-11-10',
  dateTo: '2026-11-12',
  answer: null,
};

describe('строка кабинета', () => {
  it('пять кнопок и короткие payload', () => {
    const bar = rentalCabinetBar();
    expect(bar.map((b) => b.text)).toEqual(['Мои машины', 'Календарь', 'Заявки', 'Правки', 'Помощь']);
    expect(bar.map((b) => b.payload)).toEqual(['rk:fleet', 'rk:cal', 'rk:req', 'rk:edit', 'rk:help']);
    for (const b of bar) expect(b.payload.length).toBeLessThan(64);
    expect(parseRentalCabinetPress('rk:req')).toBe('requests');
    expect(parseRentalCabinetPress('rr:y:x')).toBeNull();
  });

  it('вторая такая же строка не клеится', () => {
    const once = withRentalCabinetBar([]);
    expect(withRentalCabinetBar(once)).toEqual(once);
  });

  it('подписи кнопок — те же команды', () => {
    expect(rentalCabinetAsk('Мои машины')).toBe('fleet');
    expect(rentalCabinetAsk('Календарь')).toBe('calendar');
    expect(rentalCabinetAsk('Заявки')).toBe('requests');
    expect(rentalCabinetAsk('Правки')).toBe('edits');
    expect(rentalCabinetAsk('Помощь')).toBe('help');
    expect(rentalCabinetAsk('покажи машины')).toBeNull();
    expect(rentalCabinetAsk('найди мне в аренду автомобиль')).toBeNull();
  });

  it('справка без цен и без сырого угла', () => {
    const help = rentalCabinetHelp();
    expect(help).toContain('Мои машины');
    expect(help).toContain('не закрепляет машину');
    expect(help).not.toMatch(/<|>/);
    expect(help).not.toMatch(/\d[\d\s]*₽/);
  });
});

describe('заявки и правки', () => {
  it('MAX называет имя и телефон и даёт «Беру»; Telegram — нет', () => {
    const max = rentalRequestsView({ outcome: 'ok', rows: [openRequest] }, 'max');
    expect(max.text).toContain('Анна &lt;П&gt;');
    expect(max.text).toContain('+79001234567');
    expect(max.text).toContain('не закрепляет');
    expect(max.buttons).toEqual([[
      { text: 'Беру №1', payload: `rr:y:${LEAD}:1` },
      { text: 'Не могу №1', payload: `rr:n:${LEAD}:1` },
    ]]);
    const tg = rentalRequestsView({ outcome: 'ok', rows: [openRequest] }, 'telegram');
    expect(tg.text).not.toContain('+79001234567');
    expect(tg.text).not.toContain('Анна');
    expect(tg.text).toContain('Jimny');
    expect(tg.buttons[0]?.map((b) => b.payload)).toEqual([`rr:y:${LEAD}:1`, `rr:n:${LEAD}:1`]);
    const markup = telegramCabinetMarkup(tg.buttons);
    const last = markup.inline_keyboard[markup.inline_keyboard.length - 1] ?? [];
    expect(last.map((b) => b.callback_data)).toEqual(['rk:fleet', 'rk:cal', 'rk:req', 'rk:edit', 'rk:help']);
  });

  it('каждая пара кнопок называет номер своей строки, у отвеченной пары нет', () => {
    const lead2 = '44444444-4444-4444-8444-444444444444';
    const lead3 = '55555555-5555-4555-8555-555555555555';
    const view = rentalRequestsView({
      outcome: 'ok',
      rows: [
        { ...openRequest, answer: 'take' },
        { ...openRequest, leadId: lead2, title: 'Tank-300', dateFrom: '2026-11-05', dateTo: '2026-11-07' },
        { ...openRequest, leadId: lead3, title: 'Sever Truck', dateFrom: '2026-11-20', dateTo: '2026-11-21' },
      ],
    }, 'max');
    const lines = view.text.split('\n');
    expect(lines.find((l) => l.startsWith('2.'))).toContain('Tank-300');
    expect(lines.find((l) => l.startsWith('3.'))).toContain('Sever Truck');
    expect(view.buttons).toEqual([
      [{ text: 'Беру №2', payload: `rr:y:${lead2}:2` }, { text: 'Не могу №2', payload: `rr:n:${lead2}:2` }],
      [{ text: 'Беру №3', payload: `rr:y:${lead3}:3` }, { text: 'Не могу №3', payload: `rr:n:${lead3}:3` }],
    ]);
    for (const b of view.buttons.flat()) expect(Buffer.byteLength(b.payload)).toBeLessThanOrEqual(64);
  });

  it('ответ уже есть — кнопок заявки нет', () => {
    const view = rentalRequestsView({
      outcome: 'ok',
      rows: [{ ...openRequest, answer: 'take' }],
    }, 'max');
    expect(view.text).toContain('ответ: беру');
    expect(view.buttons).toEqual([]);
  });

  it('отказ базы не говорит, что заявок нет', () => {
    expect(rentalRequestsView({ outcome: 'db_error' }, 'max').text).toMatch(/Не удалось прочитать/);
    expect(rentalRequestsView({ outcome: 'db_error' }, 'max').text).not.toMatch(/пока нет/);
  });

  it('правка показывает числа из черновика и живую цену', () => {
    const row: CabinetEditRow = {
      title: 'Jimny <x>',
      livePrice: 7000,
      priceIsFrom: true,
      draftPrice: 8500,
      draftConditions: null,
    };
    const text = rentalEditsText({ outcome: 'ok', rows: [row] });
    expect(text).toContain('Jimny &lt;x&gt;');
    expect(text).toContain(`8\u00a0500`);
    expect(text).toContain(`7\u00a0000`);
    expect(text).toContain('«от»');
    expect(text).toContain('прежняя строка');
  });
});

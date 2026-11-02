import { describe, expect, it } from 'vitest';
import { monthOfText, narrowToursByText } from '@/lib/ai/chat-booking-tour';
import { humanChatConfirm } from '@/lib/kuzmich/chat-request';

const T = [
  { id: 1, slug: 'avachinsky-volcano', title: 'Восхождение на Авачинский вулкан' },
  { id: 2, slug: 'mutnovsky-volcano', title: 'Мутновский вулкан и водопады' },
  { id: 3, slug: 'winter-fishing-nov-jan', title: 'Зимняя рыбалка ноябрь — январь' },
  { id: 4, slug: 'winter-fishing-feb-apr', title: 'Зимняя рыбалка февраль — апрель' },
  { id: 5, slug: 'hot-springs', title: 'Термальные источники 温泉 Hot springs' },
];

describe('narrowToursByText', () => {
  it('slug in the message wins', () => {
    expect(narrowToursByText('хочу забронировать mutnovsky-volcano на 15.11', T)?.id).toBe(2);
  });
  it('booking words alone do not pick a tour', () => {
    expect(narrowToursByText('хочу забронировать заявку, нас двое', T)).toBeNull();
  });
  it('more matching stems wins over a shared one', () => {
    expect(narrowToursByText('бронирую Авачинский вулкан', T)?.id).toBe(1);
  });
  it('tie broken by month word, not only dd.mm', () => {
    expect(narrowToursByText('зимняя рыбалка 20 декабря', T)?.id).toBe(3);
    expect(narrowToursByText('зимняя рыбалка в марте', T)?.id).toBe(4);
    expect(narrowToursByText('зимняя рыбалка', T)).toBeNull();
  });
  it('English and Chinese words match', () => {
    expect(narrowToursByText('book hot springs please', T)?.id).toBe(5);
    expect(narrowToursByText('我想预订温泉', T)?.id).toBe(5);
  });
  it('vague text stays null — no guessing', () => {
    expect(narrowToursByText('вулкан', T)).toBeNull();
  });
});

describe('monthOfText', () => {
  it('reads formats and ignores look-alikes', () => {
    expect(monthOfText('2026-11-15')).toBe(11);
    expect(monthOfText('15.11.2026')).toBe(11);
    expect(monthOfText('15 ноября')).toBe(11);
    expect(monthOfText('in March')).toBe(3);
    expect(monthOfText('маршрут на маяк, market')).toBeNull();
  });
});

describe('humanChatConfirm names the tour', () => {
  it('RU/EN/ZH tour line, still human-confirm', () => {
    const t = humanChatConfirm('ok https://vedarai.ru/request-status#abc', 'Мутновский вулкан');
    expect(t).toContain('Тур в заявке: «Мутновский вулкан»');
    expect(t).toContain('EN: Tour in the request');
    expect(t).toContain('ZH:');
    expect(t).toContain('Мгновенного бронирования нет');
    expect(humanChatConfirm('ok')).not.toContain('Тур в заявке');
  });
});

import { titleMonths } from '@/lib/ai/chat-booking-tour';
describe('titleMonths', () => {
  it('range across New Year', () => {
    expect([...titleMonths('Зимняя рыбалка ноябрь — январь')]).toEqual([11, 12, 1]);
    expect([...titleMonths('Маршрут к маяку')]).toEqual([]);
  });
});

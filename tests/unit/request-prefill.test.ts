import { describe, it, expect } from 'vitest';
import { parseRequestPrefill, tourRequestHref } from '@/lib/booking/request-prefill';

describe('request-prefill: готовая форма заявки по ссылке', () => {
  it('читает дату и гостей, режет мусор и лимит', () => {
    expect(parseRequestPrefill('?date=2027-07-15&guests=3', 10)).toEqual({ date: '2027-07-15', guests: 3 });
    expect(parseRequestPrefill('?people=40', 10)).toEqual({ guests: 10 });
    expect(parseRequestPrefill('?date=15.07.2027&guests=-2&adults=abc', 10)).toEqual({});
    expect(parseRequestPrefill('?participants=0', 10)).toEqual({});
  });
  it('не берёт персональные данные из адреса', () => {
    expect(parseRequestPrefill('?name=Иван&phone=79990000000', 10)).toEqual({});
  });
  it('строит ссылку на форму', () => {
    expect(tourRequestHref('/catalog/tours/x', { date: '2027-07-15', guests: 2 })).toBe('/catalog/tours/x?date=2027-07-15&guests=2#booking');
    expect(tourRequestHref('/catalog/tours/x')).toBe('/catalog/tours/x#booking');
  });
});

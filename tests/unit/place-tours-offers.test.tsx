/**
 * Карточка места: все предложения к месту, по компаниям, по правилу 1в
 * (слово владельца 29.10, «1в 2б 3 да»).
 *
 * Было: `ORDER BY ot.id LIMIT 5` — шестой тур к месту не показывался никогда,
 * порядок задавал номер тура, у тура без цены печаталось «от 0 ₽». Теперь
 * (рендер, что видит человек):
 *  - компании идут по правилу: с ближайшей свободной датой — выше; остальные
 *    жребием дня, по билету на компанию; порядок блоков в документе — ровно
 *    как у groupOffersByCompany на том же дне;
 *  - сводка «5 предложений от 3 компаний» и подпись правила, которая
 *    кончается «Место в списке не продаётся.» (CLAUDE.md §0);
 *  - цена — факт строки, с единицей словами («за человека», «за группу»); нет
 *    цены — «цена не указана», а не ноль;
 *  - фраза о датах каждого вида; «проверен» — только у проверенной компании;
 *  - компания с четырьмя турами — одним блоком: три видно, «ещё 1» раскрывает;
 *  - брони, цен-призывов, фильтров и сортировок нет (§9);
 *  - «не загрузились» — сбой словами, а не «туров нет»;
 *  - якорь #tours — на него ведёт строка карточки тура.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import PlaceTours from '@/components/places/PlaceTours';
import type { PlaceTour } from '@/components/places/types';
import { groupOffersByCompany } from '@/lib/tours/offer-order';

afterEach(cleanup);

const DAY = '2026-10-29';

const base = (over: Partial<PlaceTour> & Pick<PlaceTour, 'id' | 'title' | 'partnerId' | 'operatorName'>): PlaceTour => ({
  slug: null,
  basePrice: 15000,
  priceUnit: 'per_person',
  durationType: 'day',
  multiDayCount: null,
  durationHours: 8,
  seasonStart: null,
  seasonEnd: null,
  nearestFreeDate: null,
  keepsSchedule: false,
  operatorSlug: null,
  operatorPublic: true,
  partnerVerified: null,
  linkKind: 'main_place',
  ...over,
});

const TOURS: PlaceTour[] = [
  base({ id: '11', title: 'Тур Альфа с датой', partnerId: 'p-a', operatorName: 'Компания Альфа',
    nearestFreeDate: '2026-11-03', keepsSchedule: true, partnerVerified: true, priceUnit: 'per_tour', basePrice: 48000 }),
  base({ id: '21', title: 'Тур Бета первый', partnerId: 'p-b', operatorName: 'Компания Бета',
    seasonStart: '2027-07-15', seasonEnd: '2027-10-15' }),
  base({ id: '22', title: 'Тур Бета второй', partnerId: 'p-b', operatorName: 'Компания Бета', partnerVerified: false }),
  base({ id: '31', title: 'Тур Гамма без цены', partnerId: 'p-c', operatorName: 'Компания Гамма', basePrice: null }),
  base({ id: '32', title: 'Тур Гамма всё занято', partnerId: 'p-c', operatorName: 'Компания Гамма', keepsSchedule: true,
    durationType: 'multi_day', multiDayCount: 4, durationHours: null }),
];

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ');

describe('PlaceTours: предложения к месту по компаниям', () => {
  it('компания со свободной датой — первой; порядок блоков как у правила', () => {
    const { container } = render(<PlaceTours tours={TOURS} state="ok" day={DAY} placeName="Вулкан Тестовый" />);
    const order = [...container.querySelectorAll('[data-company]')].map((e) => e.getAttribute('data-company'));
    const expected = groupOffersByCompany(TOURS.map((t) => ({ ...t, partnerName: t.operatorName })), { day: DAY })
      .map((g) => g.partnerId);
    expect(order).toEqual(expected);
    expect(order[0]).toBe('p-a');
    expect(new Set(order).size).toBe(3);
  });

  it('сводка и подпись правила: «5 предложений от 3 компаний», «Место в списке не продаётся.»', () => {
    const { container } = render(<PlaceTours tours={TOURS} state="ok" day={DAY} placeName="Вулкан Тестовый" />);
    expect(screen.getByText('5 предложений от 3 компаний')).toBeTruthy();
    const note = [...container.querySelectorAll('p')].find((p) => /Компании идут так/.test(p.textContent ?? ''));
    expect(note?.textContent?.trim().endsWith('Место в списке не продаётся.')).toBe(true);
  });

  it('цена с единицей словами; нет цены — «цена не указана», а не ноль', () => {
    const { container } = render(<PlaceTours tours={TOURS} state="ok" day={DAY} placeName="Вулкан Тестовый" />);
    const all = text(container);
    expect(all).toMatch(/48\s000 ₽ за группу/);
    expect(all).toMatch(/15\s000 ₽ за человека/);
    expect(all).toContain('цена не указана');
    expect(all).not.toMatch(/(^|\s)0 ₽/);
    expect(all).not.toMatch(/от [\d\s]+₽/);
  });

  it('фраза о датах каждого вида', () => {
    const { container } = render(<PlaceTours tours={TOURS} state="ok" day={DAY} placeName="Вулкан Тестовый" />);
    const all = text(container);
    expect(all).toContain('ближайшая дата со свободными местами — 3 ноября 2026');
    expect(all).toContain('даты по заявке, сезон 15 июля 2027 — 15 октября 2027');
    expect(all).toContain('даты не записаны — оператор подтвердит дату по заявке');
    expect(all).toContain('на открытые даты мест нет');
    expect(all).toContain('4 дн.');
  });

  it('«не загрузились» — сбой словами, не «туров нет»; якорь #tours есть', () => {
    const { container } = render(<PlaceTours tours={[]} state="failed" day={DAY} placeName="Вулкан Тестовый" />);
    expect(container.querySelector('#tours')).not.toBeNull();
    expect(text(container)).toContain('Туры к этому месту не загрузились — это сбой, а не «туров нет»');
    cleanup();
    const ok = render(<PlaceTours tours={TOURS} state="ok" day={DAY} placeName="Вулкан Тестовый" />);
    expect(ok.container.querySelector('section#tours')).not.toBeNull();
    cleanup();
    const empty = render(<PlaceTours tours={[]} state="empty" day={DAY} placeName="Вулкан Тестовый" />);
    expect(empty.container.innerHTML).toBe('');
  });

  it('«проверен» — только у компании с partnerVerified === true', () => {
    const { container } = render(<PlaceTours tours={TOURS} state="ok" day={DAY} placeName="Вулкан Тестовый" />);
    const blocks = Object.fromEntries([...container.querySelectorAll('[data-company]')]
      .map((e) => [e.getAttribute('data-company'), text(e)]));
    expect(blocks['p-a']).toContain('проверен');
    expect(blocks['p-b']).not.toContain('проверен');
    expect(blocks['p-c']).not.toContain('проверен');
  });

  it('компания с четырьмя турами — один блок: три видно, «ещё 1» раскрывает', () => {
    const four = [1, 2, 3, 4].map((i) => base({ id: String(40 + i), title: `Тур Лагуны ${i}`, partnerId: 'p-l', operatorName: 'Лагуна Тест' }));
    const one = base({ id: '50', title: 'Тур соседа', partnerId: 'p-s', operatorName: 'Сосед Тест' });
    const { container } = render(<PlaceTours tours={[...four, one]} state="ok" day={DAY} placeName="Вулкан Тестовый" />);
    expect(container.querySelectorAll('[data-company]')).toHaveLength(2);
    const block = container.querySelector('[data-company="p-l"]')!;
    expect(block.querySelectorAll('li')).toHaveLength(3);
    const more = within(block as HTMLElement).getByRole('button', { name: 'ещё 1' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(block.querySelectorAll('li')).toHaveLength(4);
    expect(within(block as HTMLElement).getByRole('button').getAttribute('aria-expanded')).toBe('true');
  });

  it('нет брони и выбора: ни «Забронировать», ни полей ввода, ни сортировок (§9)', () => {
    const { container } = render(<PlaceTours tours={TOURS} state="ok" day={DAY} placeName="Вулкан Тестовый" />);
    const clickable = [...container.querySelectorAll('a, button')].map((e) => text(e) + (e.getAttribute('aria-label') ?? ''));
    expect(clickable.some((t) => /Забронировать|Купить|Оплатить/i.test(t))).toBe(false);
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
    expect(text(container)).not.toMatch(/сортир/i);
  });

  it('строка тура — ссылка на карточку тура; про туры через несколько мест — словами', () => {
    const { container } = render(<PlaceTours tours={[base({ id: '61', slug: 'alfa-tur', title: 'Тур по ЧПУ', partnerId: 'p-a', operatorName: 'Компания Альфа' })]} state="ok" day={DAY} placeName="Вулкан Тестовый" />);
    expect(container.querySelector('a[aria-label="Тур по ЧПУ"]')?.getAttribute('href')).toBe('/catalog/tours/alfa-tur');
    expect(text(container)).toContain('Туры, которые проходят через несколько мест (облёты, многодневные), здесь не показаны');
  });
});

/**
 * Отзывы о перевозчике (слово владельца 13.10: «делай блок отзывов но
 * логично»; CLAUDE.md §14, миграция 1235). Судится вызовом правил и рендером
 * того, что видит человек:
 *
 *   · право на отзыв — только у того, кто ехал: машину заказывают целиком
 *     (владелец 13.10), и право даёт подтверждение менеджера по заявке — не
 *     раньше даты выезда — и одноразовая ссылка;
 *   · под каждым отзывом — чем доказано, что автор ехал;
 *   · средняя — по видимым, отзывов нет — нет и числа (не «0,0»);
 *   · пусто — объяснение, кто может оставить отзыв; не прочиталось — «сбой»;
 *   · подпись по ссылке — имя буквами, без телефона и почты;
 *   · форма: ключ из фрагмента адреса уходит в теле, отказ сервера — его
 *     словами; без ссылки — правило словами, а не форма и не «войдите».
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import { CarrierReviews } from '@/components/transfers/CarrierReviews';
import { CarrierReviewForm } from '@/components/transfers/CarrierReviewForm';
import type { CarrierReviewsBlock, PublicCarrierReview } from '@/lib/transfers/carrier-reviews';
import {
  carrierReviewInviteUrl,
  carrierReviewPath,
  inviteIssueVerdict,
  inviteKeyVerdict,
  normalizeAuthorName,
  reviewProofLine,
  roundedAverage,
} from '@/lib/transfers/carrier-review-rules';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
  window.location.hash = '';
});

const TODAY = '2026-10-14';

describe('право на отзыв: машина под заказ', () => {
  it('подтвердить поездку можно с даты выезда, не раньше', () => {
    expect(inviteIssueVerdict({ dateFrom: TODAY, reviewed: false }, TODAY)).toEqual({ ok: true });
    expect(inviteIssueVerdict({ dateFrom: '2026-10-01', reviewed: false }, TODAY)).toEqual({ ok: true });
    expect(inviteIssueVerdict({ dateFrom: '2026-10-15', reviewed: false }, TODAY)).toEqual({ ok: false, reason: 'not_yet' });
    expect(inviteIssueVerdict({ dateFrom: null, reviewed: false }, TODAY)).toEqual({ ok: false, reason: 'no_date' });
    expect(inviteIssueVerdict({ dateFrom: '2026-10-01', reviewed: true }, TODAY)).toEqual({ ok: false, reason: 'already_reviewed' });
  });
  it('ссылка: использованная и просроченная не годятся', () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    expect(inviteKeyVerdict({ expiresAt: '2026-11-13T00:00:00Z', usedAt: null }, now)).toEqual({ ok: true });
    expect(inviteKeyVerdict({ expiresAt: '2026-10-13T23:59:00Z', usedAt: null }, now)).toEqual({ ok: false, reason: 'expired' });
    expect(inviteKeyVerdict({ expiresAt: '2026-11-13T00:00:00Z', usedAt: '2026-10-14T00:00:00Z' }, now)).toEqual({ ok: false, reason: 'used' });
  });
  it('ключ — во фрагменте адреса: на сервер и в Referer он не уходит', () => {
    const url = carrierReviewInviteUrl('https://vedarai.ru', 'shatun', 'k'.repeat(32));
    expect(url).toBe(`https://vedarai.ru/transfers/shatun/review#${'k'.repeat(32)}`);
    expect(new URL(url).search).toBe('');
    expect(carrierReviewPath('shatun')).toBe('/transfers/shatun/review');
  });
});

describe('подпись под отзывом по ссылке', () => {
  it('имя буквами — да; телефон, почта, одна буква — нет', () => {
    expect(normalizeAuthorName('  Анна ')).toBe('Анна');
    expect(normalizeAuthorName('Анна   Петрова')).toBe('Анна Петрова');
    expect(normalizeAuthorName("Д'Артаньян")).toBe("Д'Артаньян");
    expect(normalizeAuthorName('+7 999 123-45-67')).toBeNull();
    expect(normalizeAuthorName('anna@example.com')).toBeNull();
    expect(normalizeAuthorName('Анна 89991234567')).toBeNull();
    expect(normalizeAuthorName('А')).toBeNull();
    expect(normalizeAuthorName('Я'.repeat(61))).toBeNull();
  });
});

describe('средняя и доказательство', () => {
  it('отзывов нет — средней нет, а не ноль; иначе — один знак', () => {
    expect(roundedAverage(0, null)).toBeNull();
    expect(roundedAverage(0, '0')).toBeNull();
    expect(roundedAverage(3, '4.6666666')).toBe(4.7);
    expect(roundedAverage(2, '4.5000000000000000')).toBe(4.5);
  });
  it('строка доказательства называет путь и поездку (род seat база допускает — читатель его понимает)', () => {
    expect(reviewProofLine({ proof: 'seat', rideDate: '2026-10-12', rideFrom: 'Петропавловск-Камчатский', rideTo: 'Вулкан Горелый' }))
      .toBe('Место в поездке Петропавловск-Камчатский — Вулкан Горелый, 12 октября: заказ через Ведар, перевозчик подтвердил');
    // Поездку подтвердил сам перевозчик (1353, #2862 этап B) — под отзывом так и сказано.
    expect(reviewProofLine({ proof: 'charter_carrier', rideDate: '2026-10-12', rideFrom: null, rideTo: 'Вулкан Горелый' }))
      .toBe('Машина под заказ: Вулкан Горелый, 12 октября: поездку подтвердил перевозчик');
    expect(reviewProofLine({ proof: 'charter', rideDate: '2026-10-12', rideFrom: null, rideTo: 'Вулкан Горелый' }))
      .toBe('Машина под заказ: Вулкан Горелый, 12 октября: поездку подтвердил менеджер Ведара');
  });
});

const review = (over: Partial<PublicCarrierReview>): PublicCarrierReview => ({
  id: '1', authorName: 'Анна П.', rating: 5, comment: 'Довезли вовремя.', createdAt: '2026-10-13T10:00:00Z',
  proof: 'charter', rideDate: '2026-10-12', rideFrom: null, rideTo: 'Вулкан Горелый', ...over,
});

describe('блок отзывов на странице перевозчика', () => {
  it('сводка — средняя по видимым и счёт; под каждым отзывом — доказательство поездки', () => {
    const block: CarrierReviewsBlock = {
      state: 'ok', count: 2, average: 4.5,
      items: [
        review({ id: '1' }),
        review({ id: '2', authorName: 'Ирина С.', rating: 4, comment: 'Вахтовка тёплая.', rideTo: 'Вачкажец', rideDate: '2026-10-05' }),
      ],
    };
    render(<CarrierReviews reviews={block} />);
    const rating = screen.getByTestId('carrier-rating');
    expect(rating.textContent).toContain('4,5');
    expect(rating.textContent).toContain('2 отзыва — только от тех, кто ехал');
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Анна П.')).toBeTruthy();
    expect(within(items[0]!).getByRole('img', { name: 'Оценка 5 из 5' })).toBeTruthy();
    expect(items[0]!.textContent).toContain('Машина под заказ: Вулкан Горелый, 12 октября: поездку подтвердил менеджер Ведара');
    expect(items[1]!.textContent).toContain('Машина под заказ: Вачкажец, 5 октября');
    // Кнопки «Оставить отзыв» нет: без ссылки менеджера писать некуда.
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('отзывов нет — ни числа, ни звёзд сводки; объяснено, кто может оставить', () => {
    const { container } = render(<CarrierReviews reviews={{ state: 'ok', items: [], count: 0, average: null }} />);
    expect(screen.queryByTestId('carrier-rating')).toBeNull();
    expect(container.textContent).not.toMatch(/0,0/);
    expect(container.textContent).toContain('Отзывов пока нет');
    expect(container.textContent).toContain('Отзыв оставляет только тот, кто ехал');
    expect(container.textContent).toContain('менеджер Ведара присылает заказчику ссылку на отзыв');
    expect(container.textContent).not.toMatch(/местом в поездке|войдя в аккаунт/);
  });

  it('не прочиталось — так и сказано, а не «отзывов нет»', () => {
    const { container } = render(<CarrierReviews reviews={{ state: 'failed' }} />);
    expect(container.textContent).toContain('Не смогли загрузить отзывы');
    expect(container.textContent).not.toContain('Отзывов пока нет');
  });

  it('список и сводка разошлись (отзыв скрыли между двумя запросами) — список виден, сводки нет, страница не падает', () => {
    render(<CarrierReviews reviews={{ state: 'ok', count: 0, average: null, items: [review({})] }} />);
    expect(screen.queryByTestId('carrier-rating')).toBeNull();
    expect(screen.getByText('Анна П.')).toBeTruthy();
  });

  it('показаны не все — сказано, что средняя по всем', () => {
    render(<CarrierReviews reviews={{ state: 'ok', count: 25, average: 4.8, items: [review({})] }} />);
    expect(screen.getByText(/Показаны последние 1 из 25; средняя — по всем/)).toBeTruthy();
  });
});

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('форма отзыва: ссылка по заявке на машину', () => {
  it('ключ из фрагмента — в теле; видна поездка; подпись, оценка, текст уходят как есть', async () => {
    const key = 'A'.repeat(32);
    window.location.hash = `#${key}`;
    fetchMock
      .mockResolvedValueOnce(json(200, { success: true, data: { state: 'ok', destination: 'Вулкан Горелый', date_from: '2026-10-12', date_to: '2026-10-12' } }))
      .mockResolvedValueOnce(json(200, { success: true }));
    render(<CarrierReviewForm carrierSlug="shatun" carrierName="Шатун" />);
    await screen.findByText(/Менеджер Ведара подтвердил, что она состоялась/);
    expect(screen.getByText(/машина под заказ — Вулкан Горелый, 12 октября/)).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/carrier-reviews/invite');
    expect(String(url)).not.toContain(key);
    expect(JSON.parse(init.body)).toEqual({ carrier: 'shatun', key });

    fireEvent.change(screen.getByLabelText('Подпись под отзывом'), { target: { value: 'Ирина' } });
    fireEvent.click(screen.getByRole('button', { name: 'Оценка 4 из 5' }));
    fireEvent.change(screen.getByLabelText('Как прошла поездка'), { target: { value: '  Тепло и вовремя. ' } });
    fireEvent.click(screen.getByRole('button', { name: /Опубликовать отзыв/ }));
    await screen.findByText(/Спасибо — отзыв опубликован/);
    const sent = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(sent).toEqual({ via: 'link', carrier: 'shatun', key, author_name: 'Ирина', rating: 4, comment: 'Тепло и вовремя.' });
    // Ключ погашен — из адресной строки убран.
    expect(window.location.hash).toBe('');
  });

  it('ссылка использована — словами, формы нет', async () => {
    window.location.hash = `#${'B'.repeat(32)}`;
    fetchMock.mockResolvedValueOnce(json(200, { success: true, data: { state: 'used', message: 'По этой ссылке отзыв уже оставлен. Одна поездка — один отзыв.' } }));
    render(<CarrierReviewForm carrierSlug="shatun" carrierName="Шатун" />);
    await screen.findByText(/По этой ссылке отзыв уже оставлен/);
    expect(screen.queryByRole('button', { name: /Опубликовать/ })).toBeNull();
  });

  it('отказ сервера при отправке — его словами, форма остаётся', async () => {
    window.location.hash = `#${'C'.repeat(32)}`;
    fetchMock
      .mockResolvedValueOnce(json(200, { success: true, data: { state: 'ok', destination: null, date_from: null, date_to: null } }))
      .mockResolvedValueOnce(json(400, { success: false, error: 'Подпись — имя буквами, от 2 до 60 знаков; без телефона и почты: отзыв увидят все' }));
    render(<CarrierReviewForm carrierSlug="shatun" carrierName="Шатун" />);
    await screen.findByLabelText('Подпись под отзывом');
    fireEvent.change(screen.getByLabelText('Подпись под отзывом'), { target: { value: '+7999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Оценка 5 из 5' }));
    fireEvent.click(screen.getByRole('button', { name: /Опубликовать отзыв/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('без телефона и почты');
    expect(screen.getByRole('button', { name: /Опубликовать отзыв/ })).toBeTruthy();
  });

  it('без оценки не уходит', async () => {
    window.location.hash = `#${'D'.repeat(32)}`;
    fetchMock.mockResolvedValueOnce(json(200, { success: true, data: { state: 'ok', destination: null, date_from: null, date_to: null } }));
    render(<CarrierReviewForm carrierSlug="shatun" carrierName="Шатун" />);
    await screen.findByLabelText('Подпись под отзывом');
    fireEvent.click(screen.getByRole('button', { name: /Опубликовать отзыв/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Поставьте оценку');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('форма отзыва: без ссылки', () => {
  it('ключа нет — правило словами: ссылку присылает менеджер; ни формы, ни «войдите», ни запросов', async () => {
    render(<CarrierReviewForm carrierSlug="shatun" carrierName="Шатун" />);
    const box = await screen.findByTestId('review-no-link');
    expect(box.textContent).toContain('менеджер Ведара присылает заказчику ссылку на отзыв');
    expect(screen.queryByRole('button', { name: /Опубликовать/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Войдите/ })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('в адресе мусор вместо ключа — «ссылка не распознана», а не форма', async () => {
    window.location.hash = '#abc';
    render(<CarrierReviewForm carrierSlug="shatun" carrierName="Шатун" />);
    await screen.findByText(/Ссылка на отзыв не распознана/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

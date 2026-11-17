// @vitest-environment jsdom
/**
 * Акция оператора на карточке тура (слово владельца 17.11 «покажи»).
 *
 * Судится поведение: срок по Камчатке, слова карточки и ответа агенту, три
 * исхода чтения (§4.0) и то, что видит человек на карточке (рендер). Срок и
 * адресатов на настоящей базе держит tests/integration/tour-promotions.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import {
  kamchatkaDay,
  isPromotionActive,
  loadActiveTourPromotions,
  promotionView,
  promotionsForAgent,
  PROMOTION_PRICE_NOTE,
  type TourPromotion,
} from '@/lib/tours/tour-promotion';
import { TourPromotions } from '@/components/tours/TourPromotions';

const PROMO: TourPromotion = {
  title: 'Для жителей Дальнего Востока',
  offer: 'Ужин по тарифу «Всё включено» в подарок.',
  conditions: 'Для жителей Дальнего Востока с действующей пропиской.',
  booking_from: '2026-11-18',
  booking_until: '2026-12-01',
  source_url: 'https://laguna-expedition.ru/aktsii/dlya-zhitelej-dalnego-vostoka',
  checked_on: '2026-11-17',
};

beforeEach(() => { query.mockReset(); cleanup(); });

describe('срок акции', () => {
  it('день — по Камчатке (UTC+12)', () => {
    expect(kamchatkaDay(Date.parse('2026-11-17T11:59:00Z'))).toBe('2026-11-17');
    expect(kamchatkaDay(Date.parse('2026-11-17T12:00:00Z'))).toBe('2026-11-18');
  });

  it('оба края срока включены, за краями — нет', () => {
    expect(isPromotionActive(PROMO, '2026-11-17')).toBe(false);
    expect(isPromotionActive(PROMO, '2026-11-18')).toBe(true);
    expect(isPromotionActive(PROMO, '2026-12-01')).toBe(true);
    expect(isPromotionActive(PROMO, '2026-12-02')).toBe(false);
  });

  it('запрос спрашивает день по Камчатке, строку вне срока не отдаёт', async () => {
    query.mockResolvedValueOnce({ rows: [PROMO] });
    const r = await loadActiveTourPromotions(118, { now: Date.parse('2026-12-01T12:00:00Z') });
    expect(query.mock.calls[0][1]).toEqual([118, '2026-12-02']);
    expect(r).toEqual({ state: 'ok', items: [] });
  });

  it('сбой базы — «не прочиталось», а не «акций нет»', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const r = await loadActiveTourPromotions(118, { now: Date.parse('2026-11-20T00:00:00Z') });
    expect(r).toEqual({ state: 'failed' });
    expect(err).toHaveBeenCalledWith('[tour-promotion] акции тура не прочитаны', expect.objectContaining({ tourId: 118, sqlstate: '42P01' }));
    err.mockRestore();
  });
});

describe('слова', () => {
  it('срок, источник и что Ведар не делает', () => {
    const v = promotionView(PROMO);
    expect(v.period).toBe('Бронирование с 18 ноября по 1 декабря 2026');
    expect(v.source).toBe('Условия — с сайта оператора, сверены 17 ноября 2026');
    expect(v.note).toBe(PROMOTION_PRICE_NOTE);
  });

  it('ответ агенту: акция теми же словами; пусто — молчание; сбой — назван', () => {
    const text = promotionsForAgent({ state: 'ok', items: [PROMO] });
    expect(text).toContain('Акция оператора «Для жителей Дальнего Востока»');
    expect(text).toContain('Бронирование с 18 ноября по 1 декабря 2026');
    expect(text).toContain('По этому туру: Ужин по тарифу «Всё включено» в подарок.');
    expect(text).toContain(PROMOTION_PRICE_NOTE);
    expect(text).toContain(PROMO.source_url);
    expect(promotionsForAgent({ state: 'ok', items: [] })).toBe('');
    expect(promotionsForAgent({ state: 'failed' })).toMatch(/прочитать не удалось — не говори, что акций нет/);
  });
});

describe('карточка тура', () => {
  it('показывает акцию, условия, оговорку о цене и ссылку на источник', () => {
    render(<TourPromotions promotions={[promotionView(PROMO)]} />);
    const block = screen.getByTestId('tour-promotions');
    expect(block.textContent).toContain('Акция оператора');
    expect(block.textContent).toContain('«Для жителей Дальнего Востока»');
    expect(block.textContent).toContain('Бронирование с 18 ноября по 1 декабря 2026');
    expect(block.textContent).toContain('с действующей пропиской');
    expect(block.textContent).toContain(PROMOTION_PRICE_NOTE);
    const link = screen.getByRole('link', { name: 'страница акции' });
    expect(link.getAttribute('href')).toBe(PROMO.source_url);
    expect(link.getAttribute('rel')).toContain('nofollow');
  });

  it('нет акций — нет блока', () => {
    const { container } = render(<TourPromotions promotions={[]} />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('tour-promotions')).toBeNull();
  });
});

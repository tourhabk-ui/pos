import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const seller = vi.fn();
const choice = vi.fn();
vi.mock('@/lib/kuzmich/tour-availability-tool', () => ({
  resolveSellerInText: (t: string) => seller(t),
  resolveTourChoice: (q: string) => choice(q),
}));
vi.mock('@/lib/kuzmich/core', () => ({
  extractTourKeywords: (t: string) => t.split(/\s+/).filter((w) => w.length > 4),
}));

import { pickChatBookingTour } from '@/lib/ai/chat-booking-tour';
import type { TourSuggestion } from '@/lib/ai/booking-intent';

const cand = (id: number, price: number | null = 5000) => ({
  id, title: `Тур ${id}`, operator_id: 'o', slug: `t-${id}`, base_price: price, price_unit: 'per_person',
  operator_name: `Компания ${id}`, main_place_id: null, place: null, nearest_free_date: null,
});
const sug = (id: number) => ({ id, title: `Карточка ${id}`, base_price: 1000 } as unknown as TourSuggestion);

beforeEach(() => { seller.mockReset(); choice.mockReset(); });

describe('тур формы брони в веб-чате — резолвер мессенджеров (01.11)', () => {
  it('продавец назван — его тур, а не первая карточка', async () => {
    seller.mockResolvedValue({ kind: 'seller', tours: [cand(7)] });
    const r = await pickChatBookingTour('бронирую у Компания 7 рыбалку', [sug(1), sug(7)]);
    expect(r.tour?.id).toBe(7);
    expect(choice).not.toHaveBeenCalled();
  });
  it('один тур по словам — форма на нём', async () => {
    seller.mockResolvedValue(null);
    choice.mockResolvedValue({ kind: 'one', tour: cand(3) });
    const r = await pickChatBookingTour('хочу забронировать вулкан Мутновский', [sug(1)]);
    expect(r.tour?.id).toBe(3);
    expect(r.tour?.slug).toBe('t-3');
  });
  it('несколько туров — формы нет, список на выбор', async () => {
    seller.mockResolvedValue(null);
    choice.mockResolvedValue({ kind: 'ambiguous', candidates: [cand(1), cand(2)] });
    const r = await pickChatBookingTour('хочу забронировать рыбалку', [sug(1), sug(2)]);
    expect(r.tour).toBeNull();
    expect(r.candidates.map((c) => c.id)).toEqual([1, 2]);
  });
  it('цены нет — формы нет (не ноль)', async () => {
    seller.mockResolvedValue(null);
    choice.mockResolvedValue({ kind: 'one', tour: cand(4, null) });
    expect((await pickChatBookingTour('хочу забронировать сплав', [])).tour).toBeNull();
  });
  it('отказ базы — не угадываем', async () => {
    seller.mockRejectedValue(new Error('db'));
    expect(await pickChatBookingTour('бронирую рыбалку', [sug(1)])).toEqual({ tour: null, candidates: [] });
  });
  it('маршрут больше не берёт tourSuggestions[0]', () => {
    const route = readFileSync(join(process.cwd(), 'app/api/ai/chat/route.ts'), 'utf-8');
    expect(route).not.toMatch(/tourSuggestions\[0\]/);
    expect(route).toMatch(/pickChatBookingTour\(rawMessage, tourSuggestions\)/);
  });
});

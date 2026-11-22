/**
 * Карточка места/маршрута у дня плана (22.11): только наши данные, фото —
 * только с подписью автора, миниатюра — уменьшенная копия; нет кадра с
 * автором — карточка без фото. Судится вызовом и рендером.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { placeCardFromDetail, routeCard, creditedPlacePhoto, shortText, thumbSrc } from '@/lib/planner/day-place-cards';
import { DayPlaceCard } from '@/components/planner/DayPlaceCard';
import { buildPlanPrintHtml } from '@/lib/planner/print-html';

const MAYAK = {
  id: '3268583a-05e0-4f59-8d2c-a87a69be14a6',
  name: 'Мыс Маячный',
  description: null,
  essence: 'Мыс у входа в Авачинскую бухту с маяком и видом на океан.',
  images: [
    'https://example.com/foreign.jpg',
    '/api/images/route/3268583a?v=17',
    '/api/images/place-gallery/3268583a/1?v=17',
  ],
  photoCredits: { '/api/images/route/3268583a?v=17': '', '/api/images/place-gallery/3268583a/1?v=17': 'Алина Гусакова' },
};

describe('карточка места', () => {
  it('кадр — первый свой с подписью автора; чужая ссылка и кадр без автора не берутся', () => {
    expect(creditedPlacePhoto(MAYAK)).toEqual({ src: '/api/images/place-gallery/3268583a/1?v=17', author: 'Алина Гусакова' });
  });
  it('герой места — уменьшенной копией', () => {
    expect(thumbSrc('/api/images/route/abc?v=1')).toBe('/api/images/route/abc?v=1&size=card');
    expect(thumbSrc('/api/images/route/abc')).toBe('/api/images/route/abc?size=card');
    expect(thumbSrc('/api/images/place-gallery/abc/1')).toBe('/api/images/place-gallery/abc/1');
  });
  it('нет кадра с автором — карточка без фото; описания нет — суть места', () => {
    const card = placeCardFromDetail({ ...MAYAK, photoCredits: {} });
    expect(card?.photo).toBeNull();
    expect(card?.text).toBe(MAYAK.essence);
    expect(card?.href).toBe('/places/3268583a-05e0-4f59-8d2c-a87a69be14a6');
  });
  it('снятое описание не показывается', () => {
    const card = placeCardFromDetail({ ...MAYAK, description: 'Старый текст', descriptionWithdrawn: true, essence: null });
    expect(card?.text).toBe('');
  });
  it('длинное описание — до двух строк, по предложению', () => {
    const long = `${'Вулкан с крутыми склонами и лавовыми куполами у подножия. '.repeat(2)}${'слово '.repeat(60)}`;
    const t = shortText(long);
    expect(t.length).toBeLessThanOrEqual(181);
    expect(t.endsWith('.') || t.endsWith('…')).toBe(true);
  });
  it('маршрут с карты — страница маршрута, без фото', () => {
    expect(routeCard({ id: 'r1', title: 'Река Быстрая', description: 'Сплав' })).toEqual({
      kind: 'route', id: 'r1', title: 'Река Быстрая', text: 'Сплав', href: '/routes/r1', photo: null,
    });
  });
});

describe('вид карточки', () => {
  it('миниатюра 64×64, лениво, с подписью автора; ссылка в новой вкладке', () => {
    render(<DayPlaceCard card={placeCardFromDetail(MAYAK)!} />);
    const img = screen.getByRole('img', { name: 'Мыс Маячный' });
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('width')).toBe('64');
    expect(img.getAttribute('height')).toBe('64');
    expect(screen.getByText('Фото: Алина Гусакова')).toBeTruthy();
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/places/3268583a-05e0-4f59-8d2c-a87a69be14a6');
    expect(link.getAttribute('target')).toBe('_blank');
  });
  it('без фото — без картинки', () => {
    render(<DayPlaceCard card={routeCard({ id: 'r1', title: 'Река Быстрая', description: null })} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/Страница маршрута/)).toBeTruthy();
  });
});

describe('PDF', () => {
  it('у дня с местом — строка «Место: … — vedarai.ru/places/…»', () => {
    const html = buildPlanPrintHtml({
      dateRange: '2026-11-24 — 2026-11-25', adults: 2, childAges: [], estimate: null, warnings: [], fmt: (n) => String(n),
      days: [{ num: 1, confirmed: false, title: 'Снегоход на Мыс Маячный', badge: null, priceLine: '', description: '', meta: '', warnings: [],
        place: { kind: 'place', title: 'Мыс Маячный', href: '/places/abc' } }],
    });
    expect(html).toContain('Место: <strong>Мыс Маячный</strong> — <span>vedarai.ru/places/abc</span>');
  });
});

/**
 * Строка «К месту «X» есть ещё N предложений — посмотреть» на карточке тура
 * (слово владельца 29.10, «3 да»; CLAUDE.md §11, п. 11а) — рендером.
 *
 * Держит:
 *   - есть другие туры к записанному месту — строка с числом и склонением,
 *     ссылка на «Туры к этому месту» карточки места (якорь #tours);
 *   - других нет, связи нет, чтение не удалось — строки нет вовсе;
 *   - строка нейтральная: без цен и без «дешевле», «лучше», «выгоднее»,
 *     «альтернатива» — она не продаёт соседа, а говорит, что он есть.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlaceOffersLine, type PlaceOffersView } from '@/components/tours/PlaceOffersLine';

const GORELY = { id: 'p-gorely', name: 'Вулкан Горелый', slug: 'vulkan-gorelyy', ark_id: null };

describe('PlaceOffersLine', () => {
  it('одно другое предложение — «есть ещё 1 предложение», ссылка на туры места', () => {
    const { container } = render(<PlaceOffersLine offers={{ state: 'ok', place: GORELY, others: 1 }} />);
    expect(container.textContent).toContain('К месту «Вулкан Горелый» есть ещё 1 предложение — посмотреть');
    const link = screen.getByRole('link', { name: 'посмотреть' });
    expect(link.getAttribute('href')).toBe('/places/vulkan-gorelyy#tours');
  });

  it('склонение: 3 предложения, 5 предложений, 21 предложение', () => {
    for (const [n, word] of [[3, 'предложения'], [5, 'предложений'], [21, 'предложение']] as const) {
      const { container, unmount } = render(<PlaceOffersLine offers={{ state: 'ok', place: GORELY, others: n }} />);
      expect(container.textContent).toContain(`есть ещё ${n} ${word} —`);
      unmount();
    }
  });

  it('место без адреса — ссылка по ark_id, затем по id (как карточка места)', () => {
    const { unmount } = render(<PlaceOffersLine offers={{ state: 'ok', place: { ...GORELY, slug: null, ark_id: 'ark-1' }, others: 2 }} />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/places/ark-1#tours');
    unmount();
    render(<PlaceOffersLine offers={{ state: 'ok', place: { ...GORELY, slug: null }, others: 2 }} />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/places/p-gorely#tours');
  });

  it('других нет, связи нет, чтение не удалось — строки нет', () => {
    const cases: Array<PlaceOffersView | null> = [
      { state: 'ok', place: GORELY, others: 0 },
      { state: 'none' },
      { state: 'failed' },
      null,
    ];
    for (const offers of cases) {
      const { container, unmount } = render(<PlaceOffersLine offers={offers} />);
      expect(container.textContent).toBe('');
      unmount();
    }
  });

  it('строка нейтральная: без цен и без сравнений', () => {
    const { container } = render(<PlaceOffersLine offers={{ state: 'ok', place: GORELY, others: 4 }} />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/дешевле|лучше|выгодн|альтернатив/i);
    expect(text).not.toMatch(/₽|руб/);
  });
});

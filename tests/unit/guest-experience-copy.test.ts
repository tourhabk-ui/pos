import { describe, it, expect } from 'vitest';
import { buildReviewRequestMessage } from '@/lib/notifications/guest-experience-copy';

describe('buildReviewRequestMessage', () => {
  const base = {
    touristName: 'Анна',
    tourTitle: 'Сплав по реке Быстрая',
    tourId: 27,
    appUrl: 'https://vedarai.ru',
  };

  it('обращается по имени, если оно есть', () => {
    const text = buildReviewRequestMessage(base);
    expect(text).toContain('Анна, привет!');
  });

  it('падает на нейтральное приветствие без имени', () => {
    const text = buildReviewRequestMessage({ ...base, touristName: null });
    expect(text).toContain('<b>Привет!</b>');
    expect(text).not.toContain('null');
  });

  it('падает на нейтральное приветствие для пустой строки', () => {
    const text = buildReviewRequestMessage({ ...base, touristName: '   ' });
    expect(text).toContain('<b>Привет!</b>');
  });

  it('ссылка ведёт на конкретный тур и якорь отзывов', () => {
    const text = buildReviewRequestMessage(base);
    expect(text).toContain('https://vedarai.ru/catalog/tours/27#reviews');
  });

  it('название тура попадает в текст', () => {
    const text = buildReviewRequestMessage(base);
    expect(text).toContain('Сплав по реке Быстрая');
  });

  it('имя и название экранированы: сообщение уходит с parse_mode HTML', () => {
    const text = buildReviewRequestMessage({ ...base, touristName: 'Анна <b', tourTitle: 'Джип & сплав' });
    expect(text).toContain('Анна &lt;b, привет!');
    expect(text).toContain('Джип &amp; сплав');
    expect(text).not.toContain('Анна <b');
  });

  it('якорь ссылки — тот же, что у блока отзывов на карточке тура', async () => {
    const { TOUR_REVIEWS_ANCHOR } = await import('@/lib/tours/tour-anchors');
    expect(buildReviewRequestMessage(base)).toContain(`/catalog/tours/27#${TOUR_REVIEWS_ANCHOR}"`);
  });
});

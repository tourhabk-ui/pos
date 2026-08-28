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
    expect(text).toContain('https://vedarai.ru/marketplace/tours/27#reviews');
  });

  it('название тура попадает в текст', () => {
    const text = buildReviewRequestMessage(base);
    expect(text).toContain('Сплав по реке Быстрая');
  });
});

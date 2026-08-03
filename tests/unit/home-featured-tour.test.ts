/**
 * Главная показывает РЕАЛЬНЫЙ тур, а не выдуманную историю.
 *
 * Прежний TravelerCard рисовал фейк: несуществующую «Марию, 26 лет», придуманную
 * цитату и «47 лайков» — прямо на витрине платформы, которая обещает не врать
 * (vedar §7). Заменён на FeaturedTour: настоящий опубликованный тур из
 * operator_tours с тем же фильтром видимости, что и каталог, и честной пустотой
 * вместо заглушки. Сторож не даёт фейку вернуться.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const FEATURED = read('components/homepage/FeaturedTour.tsx');
const PAGE = read('app/page.tsx');

describe('главная: реальный тур вместо фейка', () => {
  it('выдуманный TravelerCard удалён из репозитория', () => {
    expect(existsSync(join(process.cwd(), 'components/homepage/TravelerCard.tsx'))).toBe(false);
  });

  it('главная больше не упоминает TravelerCard', () => {
    expect(PAGE).not.toContain('TravelerCard');
  });

  it('главная рендерит FeaturedTour', () => {
    expect(PAGE).toContain('<FeaturedTour');
    expect(PAGE).toContain("from '@/components/homepage/FeaturedTour'");
  });

  it('FeaturedTour берёт тур из operator_tours по фильтру видимости каталога', () => {
    expect(FEATURED).toContain('FROM operator_tours');
    expect(FEATURED).toContain('is_published = true');
    expect(FEATURED).toContain('is_active = true');
    expect(FEATURED).toContain('deleted_at IS NULL');
  });

  it('честная деградация: нет тура → null, а не заглушка', () => {
    expect(FEATURED).toMatch(/if \(!tour\) return null/);
  });

  it('никакого фейкового отзыва на главной (ни имени-заглушки, ни выдуманной цитаты)', () => {
    expect(FEATURED).not.toContain('Мария');
    expect(FEATURED).not.toMatch(/облака разошлись/);
  });

  it('ведёт на реальную страницу тура', () => {
    expect(FEATURED).toContain('/marketplace/tours/${tour.id}');
  });
});

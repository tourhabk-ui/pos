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

  // Переписано осознанно 25.09 (П8, аудит #33/#120): у карточки была своя
  // выборка «самый новый тур с фото», LIMIT 1 — мимо правила сезона, и первым
  // мог стоять тур с кончившимся сезоном, пока телефон уводил его в конец.
  // Теперь тур приходит из витрины fetchPlates (app/_home/data.ts) — той же,
  // что у мобильной главной и сетки туров под карточкой. Фильтр видимости
  // каталога живёт там (LIVE_TOUR_CONDITIONS + JOIN partners), и сторож
  // проверяет его там, а у карточки — что своего SQL у неё больше нет.
  it('FeaturedTour не держит своей выборки — тур приходит из витрины fetchPlates', () => {
    expect(FEATURED).not.toMatch(/FROM operator_tours/);
    expect(FEATURED).not.toMatch(/pool\.query|from '@\/lib\/db-pool'/);
    expect(PAGE).toMatch(/<FeaturedTour tour=\{plates\[0\] \?\? null\}/);
    expect(PAGE).toMatch(/fetchPlates\(\)/);
  });

  it('витрина fetchPlates берёт тур из operator_tours по фильтру видимости каталога', () => {
    const DATA = read('app/_home/data.ts');
    const body = DATA.slice(DATA.indexOf('export async function fetchPlates'));
    expect(body).toContain('FROM operator_tours');
    expect(body).toContain("LIVE_TOUR_CONDITIONS.join(' AND ')");
    expect(body).toContain('JOIN partners p');
    const SEARCH = read('lib/search/tour-search.ts');
    expect(SEARCH).toContain("'ot.is_published = true'");
    expect(SEARCH).toContain("'ot.is_active = true'");
    expect(SEARCH).toContain("'ot.deleted_at IS NULL'");
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

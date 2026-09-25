/**
 * Одна сетка десктопной главной (решение владельца 25.09: «десктопная версия
 * просто говнище»).
 *
 * Было шесть ширин и шесть левых краёв: герой во весь экран, «Истории» у края,
 * туры в 1152, Кузьмич в 1120, «Стихии» в 1488, футер в 1104. Сторож держит:
 * каждая секция десктопного дерева ставит контент в HOME_CONTAINER, своих
 * max-w-6xl/container у них больше нет, мобильные приёмы (кружки «Историй»,
 * бегущая строка цифр) на десктоп не возвращаются, футер — той же ширины.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HOME_CONTAINER } from '@/lib/home/desktop-layout';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const H = 'components/homepage';
const SECTIONS = ['HeroStatus', 'StatsBand', 'FeaturedTour', 'TourGrid', 'MoodEntry', 'SeasonNow', 'LiveOnTrails', 'KuzmichBriefing', 'BentoSection', 'EditorialSection'];

describe('одна сетка', () => {
  it('контейнер один: 1280 и общий боковой отступ', () => {
    expect(HOME_CONTAINER).toMatch(/max-w-\[1280px\]/);
    expect(HOME_CONTAINER).toMatch(/mx-auto/);
  });

  it.each(SECTIONS)('%s ставит контент в HOME_CONTAINER и не заводит своей ширины', (c) => {
    const src = read(`${H}/${c}.tsx`);
    expect(src).toMatch(/HOME_CONTAINER/);
    expect(src).not.toMatch(/max-w-6xl mx-auto|className="container mx-auto/);
  });

  it('каналы Кузьмича и карта на странице — тоже в сетке', () => {
    const page = read('app/page.tsx');
    const desk = page.slice(page.indexOf('Десктоп-дерево'));
    expect(desk).toMatch(/<div className=\{HOME_CONTAINER\}>\s*<MessengerAgentsSection \/>/);
    expect(desk).toMatch(/\$\{HOME_CONTAINER\} \$\{HOME_SECTION\}`\}>\s*<div className="rounded-lg overflow-hidden[^"]*">\s*<HomeMapPreviewLazy/);
  });

  it('футер той же ширины, список «Платформа» — колонками', () => {
    const f = read('components/layout/Footer.tsx');
    expect(f).toMatch(/max-w-\[1280px\]/);
    expect(f).toMatch(/<ul className="columns-2/);
  });
});

describe('мобильные приёмы на десктоп не возвращаются', () => {
  it('кружков «Историй» в десктопном дереве нет', () => {
    const page = read('app/page.tsx');
    expect(page).not.toMatch(/<StoriesRail/);
    expect(existsSync(join(process.cwd(), `${H}/StoriesRail.tsx`))).toBe(false);
  });

  it('цифры — статичной полосой, не бегущей строкой', () => {
    const band = read(`${H}/StatsBand.tsx`);
    expect(band).not.toMatch(/animate-marquee/);
    expect(band).not.toMatch(/сезон открыт/);
  });
});

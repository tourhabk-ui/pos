/**
 * Десктопная главная продаёт все туры, а не один (П8, аудит 24.09).
 *
 *   #33  — на десктопе был ОДИН тур из восьми и ни одной формы заявки;
 *   #45  — в десктопном дереве (его получают и боты) не было ни одного h1;
 *   #123 — «Все туры» вели в четыре разных места;
 *   #124 — цены Playfair старостильными цифрами («13 ooo ₽»);
 *   #125 — смысловой текст токеном-плейсхолдером --text-muted (1.84:1);
 *   #121 — подписи фото путали вулканы;
 *   #126 — к турам рыбалки из «идёт ход лосося» пути не было; красная цифра
 *          гибели токеном --danger, закреплённым за SOS и ошибками.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fishingTourCount } from '@/lib/home/season-fishing';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PAGE = read('app/page.tsx');
const DESKTOP = PAGE.slice(PAGE.indexOf('Десктоп-дерево'));
const HOME = 'components/homepage';
const DESKTOP_COMPONENTS = [
  'HeroStatus', 'StoriesRail', 'FeaturedTour', 'TourGrid', 'LiveOnTrails', 'KuzmichBriefing',
  'StatsBand', 'MoodEntry', 'SeasonNow', 'BentoSection', 'EditorialSection', 'MessengerAgentsSection',
];

describe('витрина: все туры одной выборкой (#33)', () => {
  it('десктопное дерево читает fetchPlates один раз и отдаёт его карточке и сетке', () => {
    expect(DESKTOP.match(/fetchPlates\(\)/g)?.length).toBe(1);
    expect(DESKTOP).toMatch(/<FeaturedTour tour=\{plates\[0\] \?\? null\} total=\{plates\.length\} \/>/);
    expect(DESKTOP).toMatch(/<TourGrid plates=\{plates\.slice\(1\)\} \/>/);
  });

  it('у сетки нет своей выборки', () => {
    const grid = code(`${HOME}/TourGrid.tsx`);
    expect(grid).not.toMatch(/FROM operator_tours|pool\.query|db-pool/);
    expect(grid).toMatch(/plateFacts\(p\)/);
  });

  it('в сетке есть дверь к заявке /request', () => {
    expect(code(`${HOME}/TourGrid.tsx`)).toMatch(/href="\/request"/);
  });
});

describe('«Все туры» — одна витрина /catalog (#123)', () => {
  it('FeaturedTour ведёт на /catalog, а не на /routes?kind=tour', () => {
    const f = code(`${HOME}/FeaturedTour.tsx`);
    expect(f).toMatch(/<Link href="\/catalog"[^>]*>\s*Все туры/);
    expect(f).not.toMatch(/\/routes\?kind=tour/);
  });

  it('герой несёт вторую кнопку «Смотреть туры» → /catalog (#126)', () => {
    expect(code(`${HOME}/HeroStatus.tsx`)).toMatch(/href="\/catalog"[\s\S]{0,400}Смотреть туры/);
  });
});

describe('ровно один h1 в десктопном дереве (#45)', () => {
  it('h1 — заголовок героя', () => {
    expect(code(`${HOME}/HeroStatus.tsx`)).toMatch(/<h1 [^>]*>\s*Соберите безопасную поездку на Камчатку\s*<\/h1>/);
  });

  it('больше ни один компонент десктопного дерева h1 не ставит', () => {
    const count = DESKTOP_COMPONENTS
      .map((c) => (code(`${HOME}/${c}.tsx`).match(/<h1[\s>]/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(count).toBe(1);
    expect(code('app/page.tsx')).not.toMatch(/<h1[\s>]/);
  });
});

describe('цены и счётчики — выравнивающие цифры (#124)', () => {
  it.each([
    ['FeaturedTour', /lining-nums tabular-nums" style=\{\{ fontFamily: 'var\(--font-playfair\)' \}\}>\{price\}/],
    ['TourGrid', /lining-nums tabular-nums">\{f\.price\}/],
    ['StatsBand', /font-playfair font-bold text-\[var\(--text-primary\)\] lining-nums tabular-nums/],
    ['EditorialSection', /text-4xl font-playfair font-bold mb-2 text-\[var\(--text-primary\)\] lining-nums tabular-nums/],
  ])('%s', (c, re) => {
    expect(code(`${HOME}/${c}.tsx`)).toMatch(re);
  });

  it('единица цены — из общего словаря, не литералом «/ чел»', () => {
    const f = code(`${HOME}/FeaturedTour.tsx`);
    expect(f).toMatch(/priceUnitLabel\(tour\.priceUnit, true\)/);
    expect(f).not.toMatch(/> \/ чел</);
  });
});

describe('смысловой текст не набран токеном-плейсхолдером (#125)', () => {
  it.each(['SeasonNow', 'MoodEntry', 'LiveOnTrails', 'StatsBand', 'EditorialSection', 'MessengerAgentsSection', 'KuzmichBriefing', 'TourGrid'])(
    '%s без text-[var(--text-muted)] и подписей мельче 12px',
    (c) => {
      const src = code(`${HOME}/${c}.tsx`);
      expect(src).not.toMatch(/text-\[var\(--text-muted\)\]/);
      expect(src).not.toMatch(/text-\[(9|10|11)px\]/);
    },
  );
});

describe('--danger — только SOS и ошибки (#126)', () => {
  it('факт о гибели в EditorialSection набран цветом текста и не первым', () => {
    const e = code(`${HOME}/EditorialSection.tsx`);
    expect(e).not.toMatch(/--danger/);
    const facts = e.slice(e.indexOf('const FACTS'), e.indexOf('];', e.indexOf('const FACTS')));
    expect(facts.indexOf('погибло')).toBeGreaterThan(facts.indexOf('регистрации в МЧС'));
  });
});

describe('подписи фото (#121)', () => {
  const CONE = '/images/hero/IMG_20260316_133026.jpg';

  it('один кадр — одна подпись: конус с облаком не подписан «Мутновским»', () => {
    const e = code(`${HOME}/EditorialSection.tsx`);
    expect(e).toContain(CONE);
    expect(e).not.toMatch(/Мутновский, Южная Камчатка/);
    expect(e).toMatch(/Ключевская сопка/);
    expect(code(`${HOME}/StoriesRail.tsx`)).toMatch(new RegExp(`label: 'Ключевской',\\s+image: '${CONE}'`));
  });

  it('кадр с рогозом (bento/mutnovsky.jpg) не выдаётся за вулкан', () => {
    for (const c of ['StoriesRail', 'BentoSection']) {
      expect(code(`${HOME}/${c}.tsx`)).not.toContain('/images/bento/mutnovsky.jpg');
    }
  });

  it('«Хели-ски» не стоит на кадре извержения; извержение — у «Огня»', () => {
    const b = code(`${HOME}/BentoSection.tsx`);
    const fire = b.slice(b.indexOf("title: 'ОГОНЬ'"), b.indexOf("title: 'СНЕГ'"));
    const snow = b.slice(b.indexOf("title: 'СНЕГ'"), b.indexOf("title: 'ОКЕАН'"));
    expect(fire).toContain('/images/hero/hero-dark.jpeg');
    expect(snow).not.toContain('/images/hero/hero-dark.jpeg');
  });
});

describe('«Сейчас на Камчатке» ведёт к турам рыбалки (#126)', () => {
  it('ссылка в витрину с фильтром рыбалки, число — из сводки каталога', () => {
    const s = code(`${HOME}/SeasonNow.tsx`);
    expect(s).toMatch(/href="\/catalog\?activity_type=fishing"/);
    expect(s).toMatch(/Туры на рыбалку\{fishing != null \? ` \(\$\{fishing\}\)` : ''\}/);
    expect(s).toMatch(/fishingTourCount\(await queryCatalogSummary\(\)\)/);
    // туров на рыбалку нет — ссылки нет (в пустую витрину не зовём)
    expect(s).toMatch(/\{fishing !== 0 && \(/);
  });

  it('fishingTourCount считает рыбалку из сводки и честно говорит 0', () => {
    expect(fishingTourCount({ byActivity: [{ activity_type: 'rafting', count: 1 }, { activity_type: 'fishing', count: 7 }] })).toBe(7);
    expect(fishingTourCount({ byActivity: [{ activity_type: 'rafting', count: 1 }] })).toBe(0);
  });
});

describe('футер десктопного дерева скрыт на телефонных ширинах (#43)', () => {
  it('Footer обёрнут в hidden md:block', () => {
    expect(DESKTOP).toMatch(/<div className="hidden md:block">\s*<Footer \/>\s*<\/div>/);
  });
});

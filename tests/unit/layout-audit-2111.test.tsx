/**
 * Аудит вёрстки 21.11.2026: шаблонные правки A5–A10, A12.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Footer } from '@/components/layout/Footer';
import { MonthsNav, LandingTours } from '@/components/landings/LandingContent';
import { parseArticleMarkdown, hideDuplicateFaq, faqFromBlocks } from '@/lib/articles/markdown';
import { ArticleMarkdown } from '@/components/articles/ArticleMarkdown';
import { PLATFORM_SECTIONS } from '@/lib/navigation/platform-links';
import { landingBySlug } from '@/lib/landings/landings';

describe('A5 подвал: группы из реестра и высота ссылки 44px', () => {
  it('показывает заголовки секций, а не одну колонку «Платформа»', () => {
    render(<Footer />);
    for (const s of PLATFORM_SECTIONS) {
      expect(screen.getByText(s.title)).toBeTruthy();
    }
    const catalog = screen.getByRole('link', { name: 'Туры' });
    expect(catalog.className).toMatch(/min-h-11/);
    const legal = screen.getByText(/информационная система/);
    expect(legal.className).toMatch(/text-sm/);
    expect(legal.className).toMatch(/max-w-\[70ch\]/);
  });
});

describe('A6 навигация месяцев', () => {
  it('месяцы стоят сеткой, «Когда ехать» не в одной ленте с декабрём', () => {
    const { container } = render(<MonthsNav current="/kamchatka-v-yanvare" />);
    const list = container.querySelector('ul');
    expect(list?.className).toMatch(/grid/);
    expect(list?.className).toMatch(/grid-cols-3/);
    expect(list?.className).toMatch(/md:grid-cols-6/);
    const hub = screen.getByRole('link', { name: /Когда ехать/ });
    expect(hub.className).toMatch(/min-h-11/);
  });
});

describe('A8 ссылка «Все туры в каталоге»', () => {
  it('отстоит от последней карточки и имеет высоту 44px', () => {
    const landing = landingBySlug('kamchatka-v-yanvare');
    render(<LandingTours landing={landing} tours={[{
      id: '1', slug: 'demo', title: 'Демо-тур', base_price: '10000', price_unit: 'per_person',
      duration_hours: '8', difficulty: null, season_start: null, season_end: null,
      activity_type: 'jeep', location_name: null, operator_name: 'Оператор',
      operator_slug: 'op', operator_public: true, next_open_date: null, any_day_open: null,
    }]} />);
    const link = screen.getByRole('link', { name: 'Все туры в каталоге' });
    expect(link.className).toMatch(/mt-4/);
    expect(link.className).toMatch(/min-h-11/);
  });
});

describe('A9 FAQ не повторяет заголовок раздела', () => {
  it('убирает вопрос, дословно совпадающий с H2, и оставляет уникальный', () => {
    const blocks = parseArticleMarkdown([
      '## Какая погода на Камчатке в июле?',
      'В июле тепло.',
      '## Частые вопросы',
      '**Какая погода на Камчатке в июле?**',
      'В июле тепло.',
      '**Можно ли в июле подняться на Авачинский вулкан?**',
      'Да, если маршрут открыт.',
    ].join('\n'));
    const visible = hideDuplicateFaq(blocks);
    expect(visible.filter((b) => b.t === 'qa').map((b) => 'qText' in b ? b.qText : '')).toEqual([
      'Можно ли в июле подняться на Авачинский вулкан?',
    ]);
    expect(faqFromBlocks(blocks).map((x) => x.q)).toEqual([
      'Можно ли в июле подняться на Авачинский вулкан?',
    ]);
  });
});

describe('A10 последний столбец таблицы не переносит «7 дней»', () => {
  it('на последнюю ячейку ставит nowrap', () => {
    const blocks = parseArticleMarkdown([
      '| Тур | Сезон на странице тура |',
      '|---|---|',
      '| Зимний маршрут | 25 декабря — 14 января, 7 дней |',
    ].join('\n'));
    const { container } = render(<ArticleMarkdown blocks={blocks} />);
    const cells = [...container.querySelectorAll('td')];
    expect(cells.at(-1)?.className).toMatch(/whitespace-nowrap/);
    expect(cells[0]?.className).not.toMatch(/whitespace-nowrap/);
  });
});

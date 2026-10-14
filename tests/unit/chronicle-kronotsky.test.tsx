/**
 * Летопись: «Кроноцкий заповедник» — владелец 14.10, «и в летописи сделай
 * красивую страницу» (вслед за местом, миграция 1240).
 *
 * Статья — справка по источникам (lib/chronicle/articles.ts). Здесь держится
 * то, что делает её этой статьёй, и то, что видит человек на странице:
 * лента главных дат над текстом и переходы к карточке места и маршрутам.
 * Страница судится рендером, не строкой исходника (решение владельца 13.10).
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));

import ChronicleArticlePage from '@/app/letopis/[slug]/page';
import { CHRONICLE_BY_SLUG, chronicleForPlace } from '@/lib/chronicle/articles';

afterEach(cleanup);

const SLUG = 'kronotskij-zapovednik';
const PLACE_ID = '4f1217e7-31a4-4d21-bc98-3d46aaba122e';
const article = CHRONICLE_BY_SLUG[SLUG];
const text = article.sections
  .flatMap((s) => s.paragraphs.map((p) => (typeof p === 'string' ? p : p.quote)))
  .join('\n');

describe('статья о Кроноцком заповеднике', () => {
  it('связана с местом каталога — карточка заповедника ведёт на статью', () => {
    expect(chronicleForPlace(PLACE_ID).map((a) => a.slug)).toContain(SLUG);
  });

  it('год основания из источника — 1934, не 1884 прежнего сочинения', () => {
    expect(text).toContain('1 ноября 1934 года');
    expect(text).not.toContain('1884');
  });

  it('источник расходится сам с собой — в тексте оба года возвращения туризма', () => {
    expect(text).toContain('1992');
    expect(text).toContain('1993');
  });

  it('каждая веха ленты стоит в тексте статьи, годы идут по порядку', () => {
    const years = (article.timeline ?? []).map((d) => d.year);
    expect(years.length).toBeGreaterThan(4);
    for (const y of years) expect(text).toContain(y);
    const nums = years.map((y) => Number(y.slice(0, 4)));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
  });

  it('переходы — внутренние адреса по slug', () => {
    for (const l of article.links ?? []) expect(l.href).toMatch(/^\/(places|park)\/[a-z0-9-]+$/);
  });
});

describe('страница статьи', () => {
  it('над текстом — лента «Главные даты» с годами по порядку', async () => {
    render(await ChronicleArticlePage({ params: Promise.resolve({ slug: SLUG }) }));
    const dates = screen.getByRole('region', { name: 'Главные даты' });
    const items = within(dates).getAllByRole('listitem');
    expect(items).toHaveLength(article.timeline!.length);
    expect(items[0].textContent).toContain('1882');
    expect(items[items.length - 1].textContent).toContain('2013');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Кроноцкий заповедник');
  });

  it('переходы к карточке места и маршрутам заповедника', async () => {
    render(await ChronicleArticlePage({ params: Promise.resolve({ slug: SLUG }) }));
    const nav = screen.getByRole('navigation', { name: 'На карте и в маршрутах' });
    const hrefs = within(nav).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/places/kronotskij-zapovednik', '/park/kronotsky']);
  });

  it('над заголовком — главный кадр с подписью: название, автор со ссылкой на файл, лицензия', async () => {
    render(await ChronicleArticlePage({ params: Promise.resolve({ slug: SLUG }) }));
    const img = screen.getByRole('img', { name: article.hero!.alt });
    expect(img.getAttribute('src')).toContain('/api/images/s3/photos/kronotsky/kronotskaya-v-shlyape.jpg');
    const figure = img.closest('figure')!;
    expect(figure.textContent).toContain('Кроноцкая в шляпе');
    expect(within(figure).getByRole('link', { name: 'Malupasic' }).getAttribute('href')).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    expect(within(figure).getByRole('link', { name: 'CC BY-SA 4.0' }).getAttribute('href')).toBe('https://creativecommons.org/licenses/by-sa/4.0');
  });

  it('главный кадр лежит в хранилище: его ключ залит media-to-s3', () => {
    const marker = JSON.parse(readFileSync(join(process.cwd(), '.github/triggers/media-to-s3.json'), 'utf8')) as {
      items: Array<{ key: string }>;
    };
    expect(marker.items.map((i) => i.key)).toContain(article.hero!.key);
  });

  it('у статьи без ленты и переходов этих блоков нет', async () => {
    render(await ChronicleArticlePage({ params: Promise.resolve({ slug: 'bolsheretskiy-mayak' }) }));
    expect(screen.queryByRole('region', { name: 'Главные даты' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'На карте и в маршрутах' })).toBeNull();
  });
});

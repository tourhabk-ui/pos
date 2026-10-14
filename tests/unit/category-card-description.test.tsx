/**
 * Карточка страницы категории и её зонного среза показывает начало описания
 * (14.10) — рендером, как видит человек (правило 13.10).
 *
 * Перепись sitemap 14.10 (прогон 8) нашла тонкими четыре зонных среза:
 * /routes/eco/eastern, /routes/eco/northern, /routes/eco/western,
 * /routes/trekking/avachinsky — меньше 150 слов в серверном HTML. Срез
 * по замыслу без сочинённого текста, а карточка категории показывала одно
 * имя: три-четыре карточки давали список названий. Описание при этом
 * загружалось и до карточки не доходило. Теперь — две строки начала
 * описания, как у карточки маршрута; в HTML до 300 знаков по границе слова.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/hooks/use-wishlist', () => ({
  useWishlist: () => ({ on: false, busy: false, localOnly: false, error: null, toggle: () => {} }),
  wishlistLabel: () => 'В избранное',
  WISHLIST_LOCAL_ONLY_HINT: '',
}));

import CategoryPage from '@/components/routes/CategoryPage';

const LONG = 'Кальдера Узон — древний провал диаметром около десяти километров, '
  + 'где на одном пятачке собраны горячие источники, грязевые котлы, '
  + 'кислые озёра и бактериальные маты. '.repeat(6);

function row(id: string, title: string, description: string | null) {
  return {
    id, title, description, category: 'eco', lat: 54.5, lng: 160.0, kind: 'place',
    url_slug: id, price_from: null, difficulty: null, duration_days: null, source_name: null,
  };
}

const ROWS = [
  row('uzon', 'Кальдера Узон', LONG),
  row('russkaya', 'Бухта Русская',
    'Это Бухта Русская в Камчатском крае. Место, которое стоит посмотреть. Бухта глубоко врезана в берег.'),
  row('empty', 'Мыс Безымянный', null),
];

beforeEach(() => {
  poolQueryMock.mockReset();
  poolQueryMock.mockImplementation((sql: string) => {
    if (sql.includes('LIMIT 24')) return Promise.resolve({ rows: ROWS });
    if (sql.includes('GROUP BY zone')) return Promise.resolve({ rows: [{ zone: 'eastern', count: '3' }] });
    if (sql.includes('GROUP BY category')) return Promise.resolve({ rows: [{ category: 'eco', count: '3' }] });
    if (sql.includes('FROM parks')) return Promise.resolve({ rows: [] });
    if (sql.includes('COUNT(*) AS count')) return Promise.resolve({ rows: [{ count: '3' }] });
    return Promise.resolve({ rows: [] });
  });
});
afterEach(cleanup);

/** Карточка по имени — статья, в которой стоит заголовок. */
function card(title: string): HTMLElement {
  const h = screen.getByRole('heading', { level: 3, name: title });
  const article = h.closest('article');
  if (!article) throw new Error(`карточка «${title}» не найдена`);
  return article as HTMLElement;
}

describe('зонный срез: у карточки — начало описания', () => {
  it('длинное описание — до 300 знаков по границе слова, с многоточием', async () => {
    render(await CategoryPage({ category: 'eco', zone: 'eastern' }));
    const p = within(card('Кальдера Узон')).getByText(/^Кальдера Узон — древний провал/);
    const text = p.textContent ?? '';
    expect(text.length).toBeLessThanOrEqual(301);
    expect(text.endsWith('…')).toBe(true);
    // Слово не рвётся: перед многоточием — конец целого слова из описания.
    const lastWord = text.slice(0, -1).split(' ').pop() ?? '';
    expect(LONG.split(/\s+/).map((w) => w.replace(/[,.]$/, ''))).toContain(lastWord.replace(/[,.]$/, ''));
  });

  it('заглушка «Это … в Камчатском крае. Место, которое стоит посмотреть» снята', async () => {
    render(await CategoryPage({ category: 'eco', zone: 'eastern' }));
    const c = within(card('Бухта Русская'));
    expect(c.getByText('Бухта глубоко врезана в берег.')).toBeTruthy();
    expect(c.queryByText(/стоит посмотреть/)).toBeNull();
  });

  it('описания нет — нет и строки: пустое место не заполняется', async () => {
    render(await CategoryPage({ category: 'eco', zone: 'eastern' }));
    const c = card('Мыс Безымянный');
    expect(c.querySelector('p')).toBeNull();
  });

  it('на странице категории без зоны — то же', async () => {
    render(await CategoryPage({ category: 'eco' }));
    expect(within(card('Бухта Русская')).getByText('Бухта глубоко врезана в берег.')).toBeTruthy();
  });
});

/**
 * Раздел «Места» (/places): SSR-страница фиксирует kind=place, блокирует
 * переключатель у клиента (lockedKind) и строит JSON-LD ссылки на /places/[id].
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';

const queryMock = vi.fn();
vi.mock('@/lib/routes/catalog-query', () => ({
  queryCatalogForPage: (...args: unknown[]) => queryMock(...args),
}));

import PlacesPage from '@/app/places/page';

// Рекурсивно ищет в дереве элементов первый с заданным пропом.
function findByProp(node: unknown, prop: string): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as ReactElement & { props?: Record<string, unknown> };
  if (el.props && prop in el.props) return el.props;
  const children = el.props?.children;
  const arr = Array.isArray(children) ? children : [children];
  for (const c of arr) {
    const found = findByProp(c, prop);
    if (found) return found;
  }
  return null;
}

function collectHtml(node: unknown, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  const el = node as ReactElement & { props?: Record<string, unknown> };
  const html = el.props?.dangerouslySetInnerHTML as { __html?: string } | undefined;
  if (html?.__html) out.push(html.__html);
  const children = el.props?.children;
  const arr = Array.isArray(children) ? children : [children];
  for (const c of arr) collectHtml(c, out);
}

describe('/places SSR page', () => {
  beforeEach(() => queryMock.mockReset());

  it('запрашивает каталог с kind=place и передаёт клиенту lockedKind', async () => {
    queryMock.mockResolvedValue({
      items: [{ id: 'p1', title: 'Вулкан Горелый', kind: 'place' }],
      meta: { total: 1, pages: 1 },
    });

    const tree = await PlacesPage({ searchParams: Promise.resolve({}) });

    // Каталог спрошен именно про места
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toMatchObject({ kind: 'place' });

    // Клиент получил lockedKind='place' (переключатель мест/маршрутов скрыт)
    const clientProps = findByProp(tree, 'lockedKind');
    expect(clientProps?.lockedKind).toBe('place');
    expect(clientProps?.initialItems).toHaveLength(1);

    // JSON-LD ведёт на /places/[id], не на /routes/
    const htmls: string[] = [];
    collectHtml(tree, htmls);
    const jsonld = htmls.join(' ');
    expect(jsonld).toContain('/places/p1');
    expect(jsonld).not.toContain('/routes/p1');
  });

  it('пустой каталог: клиент получает пустой список без ошибки', async () => {
    queryMock.mockResolvedValue({ items: [], meta: { total: 0, pages: 1 } });

    const tree = await PlacesPage({ searchParams: Promise.resolve({}) });
    const clientProps = findByProp(tree, 'lockedKind');
    expect(clientProps?.initialError).toBe(false);
    expect(clientProps?.initialItems).toEqual([]);
    // Пустой каталог → JSON-LD ItemList не рендерится
    const htmls: string[] = [];
    collectHtml(tree, htmls);
    expect(htmls.join(' ')).not.toContain('ItemList');
  });

  it('пробрасывает location_type и page в запрос каталога', async () => {
    queryMock.mockResolvedValue({ items: [], meta: { total: 0, pages: 1 } });

    await PlacesPage({ searchParams: Promise.resolve({ location_type: 'volcano', page: '2' }) });
    expect(queryMock.mock.calls[0][0]).toMatchObject({ kind: 'place', location_type: 'volcano', page: 2 });
  });
});

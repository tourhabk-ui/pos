// @vitest-environment jsdom
/**
 * /hub/fishing при отказе базы (issue #2579): страница открывается, список
 * говорит «не загрузился», разметки туров нет. Три исхода (§4.0) — рендером.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { isValidElement, type ReactNode } from 'react';

const poolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));

function hasJsonLd(node: ReactNode): boolean {
  if (Array.isArray(node)) return node.some(hasJsonLd);
  if (!isValidElement(node)) return false;
  const p = node.props as { type?: string; children?: ReactNode };
  if (node.type === 'script' && p.type === 'application/ld+json') return true;
  return hasJsonLd(p.children);
}

const TOUR = {
  id: 1, slug: 'rybalka', title: 'Рыбалка на Быстрой', short_description: 'Чавыча', description: null,
  base_price: 15000, duration_hours: 8, max_participants: 6, min_participants: 1, difficulty: 'easy',
  photos: [], included: [], season_start: null, season_end: null,
  operator_name: 'Камчатская рыбалка', operator_slug: 'fishingkam', operator_public: true,
};

describe('/hub/fishing: три исхода списка', () => {
  // Без mockReset в beforeEach: сброс мока с отказом в сохранённых результатах vitest 5 выдаёт как упавший тест.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('база не ответила — страница открывается, «не загрузился», без «Туры (0)» и без разметки', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQuery.mockRejectedValue(Object.assign(new Error('timeout exceeded when trying to connect'), { code: undefined }));
    const { default: Page } = await import('@/app/hub/fishing/page');
    const tree = await Page();
    expect(hasJsonLd(tree)).toBe(false);
    render(tree);
    expect(screen.getByRole('status').textContent).toMatch(/не загрузился/);
    expect(screen.getByRole('status').textContent).toMatch(/не значит, что туров нет/);
    expect(screen.queryByText(/Туры \(0\)/)).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[fishing] туры на рыбалку не прочитаны:', 'sqlstate=нет', 'timeout exceeded when trying to connect');
  });

  it('туров нет — «нет на витрине», разметка с нулём есть, отказа нет', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    const { default: Page } = await import('@/app/hub/fishing/page');
    const tree = await Page();
    expect(hasJsonLd(tree)).toBe(true);
    render(tree);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText(/Открытых рыболовных туров на витрине сейчас нет/)).toBeTruthy();
  });

  it('туры есть — карточки и счётчик', async () => {
    poolQuery.mockResolvedValue({ rows: [TOUR] });
    const { default: Page } = await import('@/app/hub/fishing/page');
    render(await Page());
    expect(screen.getByText('Туры (1)')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

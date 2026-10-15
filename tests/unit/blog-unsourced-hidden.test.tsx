/**
 * Блог не показывает статьи, утверждения которых нечем подтвердить (15.10).
 *
 * Аудит SEO 29.09 убрал три зашитых в код текста из sitemap и оставил вычитку
 * владельцу; 15.10 вычитка сделана по его карт-бланшу. «Сезон 2026» (квота
 * Долины гейзеров, открытые и закрытые маршруты, «самый тёплый июнь за 10
 * лет») и «Операторы 2026» (полис, два сезона, «повторная верификация каждый
 * сезон» — ничего из этого платформа не проверяет) сняты с показа, но не
 * удалены. Статья про SOS осталась, её устройство сверено с кодом.
 *
 * Судится тем, что видит человек: список блога, страница статьи и её
 * заголовок для поиска.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));

import BlogPage, { STATIC_ARTICLES } from '@/app/blog/page';
import BlogPostPage, { generateMetadata } from '@/app/blog/[slug]/page';

afterEach(cleanup);

const HIDDEN = ['kamchatka-season-2026', 'operators-2026'];
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe('блог: статьи без источника сняты с показа', () => {
  it('список показывает только статью про SOS', async () => {
    render(await BlogPage());
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/blog/sos-offline-guide');
    for (const slug of HIDDEN) expect(hrefs).not.toContain(`/blog/${slug}`);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/Сезон 2026 на Камчатке/);
    expect(text).not.toMatch(/Верифицированные операторы/);
  });

  it('по прямому адресу снятая статья — 404, а не текст; заголовок для поиска её не называет', async () => {
    for (const slug of HIDDEN) {
      await expect(BlogPostPage(params(slug)), slug).rejects.toThrow('NEXT_NOT_FOUND');
      const meta = await generateMetadata(params(slug));
      expect(meta.title, slug).toBe('Блог Ведара');
      expect(meta.description, slug).toBeUndefined();
    }
  });

  it('тексты не удалены: у каждой снятой — причина, у показываемой её нет', () => {
    for (const slug of HIDDEN) {
      const a = STATIC_ARTICLES.find((x) => x.slug === slug);
      expect(a?.content.length, slug).toBeGreaterThan(300);
      expect(a?.hiddenReason, slug).toMatch(/снято 15\.10/);
    }
    expect(STATIC_ARTICLES.find((x) => x.slug === 'sos-offline-guide')?.hiddenReason).toBeUndefined();
  });

  it('статья про SOS открывается и не называет цифр покрытия, которых нет в источниках', async () => {
    render(await BlogPostPage(params('sos-offline-guide')));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Как работает SOS-кнопка без интернета');
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/В МЧС сигнал сам не передаётся — туда звоните 112/);
    expect(text).not.toMatch(/30 км/);
    expect(text).not.toMatch(/вне зоны 4G/);
    // Кнопка называется так, как на странице маршрута.
    expect(text).toMatch(/«Скачать для похода»/);
  });
});

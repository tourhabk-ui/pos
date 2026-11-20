/**
 * Ссылка rel="ard" в <head> корневого layout (20.11, «Агентный просмотр»
 * Lighthouse 13): второй путь, которым агент находит манифест ARD, — потребитель
 * обязан её учесть (ARD v0.91, §5.1). Судится рендером layout: ссылка есть на
 * сайте Ведара и указывает на /.well-known/ard.json, на домене партнёра её нет —
 * каталог называет агентов Ведара, а не партнёра.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ARD_PATH, ARD_MEDIA_TYPE } from '@/lib/mcp/server-card';

const hdrs = vi.hoisted(() => ({ host: 'vedarai.ru' }));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: hdrs.host }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

async function renderLayout(): Promise<Document> {
  const { default: RootLayout } = await import('@/app/layout');
  const html = renderToStaticMarkup(await RootLayout({ children: null }));
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('rel="ard" в head', () => {
  beforeEach(() => { hdrs.host = 'vedarai.ru'; });

  it('на сайте Ведара — одна ссылка на манифест ARD', async () => {
    const doc = await renderLayout();
    const links = [...doc.querySelectorAll('link[rel="ard"]')];
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe(ARD_PATH);
    expect(links[0].getAttribute('href')).toBe('/.well-known/ard.json');
    expect(links[0].getAttribute('type')).toBe(ARD_MEDIA_TYPE);
  });

  it('на домене партнёра ссылки нет', async () => {
    hdrs.host = 'fishingkam.ru';
    const doc = await renderLayout();
    expect(doc.querySelectorAll('link[rel="ard"]')).toHaveLength(0);
  });
});

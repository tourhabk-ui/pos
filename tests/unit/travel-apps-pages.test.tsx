// @vitest-environment jsdom
/**
 * Страницы сторонних приложений — рендером (решение владельца 07.11).
 *
 * «Приложения в дорогу» (/ai-tools): прежде «AI-арсенал Камчатки» с
 * «48 проверенными инструментами для безопасного путешествия», звёздами без
 * оценок и молнией с числом, похожим на популярность. Теперь страница
 * говорит, чьи это приложения и что место в списке не продаётся, называет
 * порядок, отправляет за безопасностью к Ведару и 112, у определителей по
 * фото — что они не про съедобность; отказ базы — «не загрузился».
 *
 * Админка «Сторонние сервисы» (/hub/admin/taaft): первой строкой — что это
 * не инструменты Ведара и где наши (MCP); колонки — показывается ли и
 * щелчки людей; отказ — «не загрузился», а не «не найдено» и не падение.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import { TravelAppsList } from '@/components/travel-apps/TravelAppsList';
import { NATURE_CAUTION, type ExternalTool } from '@/lib/travel-apps/catalog';

const app = (slug: string, name: string, category: string): ExternalTool =>
  ({ id: slug, slug, name, category, description: `Описание ${name}.`, tags: [], url: `https://${slug}.example`, is_free: true });

const APPS = [
  app('wikiloc', 'Wikiloc', 'maps'),
  app('organic-maps', 'Organic Maps', 'maps'),
  app('inaturalist', 'iNaturalist', 'nature'),
  app('plantnet', 'Pl@ntNet', 'nature'),
];

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('«Приложения в дорогу»', () => {
  it('говорит, чьи это приложения, и называет порядок; ни «проверенных», ни звёзд', () => {
    render(<TravelAppsList apps={APPS} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Приложения в дорогу' })).toBeTruthy();
    expect(screen.getByText(/Их делают другие компании: Ведар за них не отвечает и денег за место в списке не получает\./)).toBeTruthy();
    expect(screen.getByText('Порядок — по задаче, внутри раздела — по алфавиту.')).toBeTruthy();
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/проверенн|AI-арсенал|Популяр|рейтинг|лавин/i);
  });

  it('разделы по задаче, внутри — по алфавиту; у каждого — ссылка на сайт приложения', () => {
    render(<TravelAppsList apps={APPS} />);
    const maps = screen.getByRole('region', { name: 'Карты и треки' });
    const names = within(maps).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(names).toEqual(['Organic Maps', 'Wikiloc']);
    const link = within(maps).getByRole('link', { name: /Открыть сайт Organic Maps/ });
    expect(link.getAttribute('href')).toBe('https://organic-maps.example');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('у определителей по фото — что они не про съедобность; у карт этой строки нет', () => {
    render(<TravelAppsList apps={APPS} />);
    const nature = screen.getByRole('region', { name: 'Растения и животные по фото' });
    expect(within(nature).getByText(NATURE_CAUTION)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Карты и треки' })).queryByText(NATURE_CAUTION)).toBeNull();
  });

  it('за безопасностью — к Ведару и 112', () => {
    render(<TravelAppsList apps={APPS} />);
    const aside = screen.getByRole('complementary', { name: 'Безопасность' });
    expect(within(aside).getByRole('link', { name: '«Обстановка»' }).getAttribute('href')).toBe('/safety');
    expect(aside.textContent).toContain('112');
  });

  it('список не прочитался — «не загрузился», а не «пусто»; пустой — «пуст»', () => {
    render(<TravelAppsList apps={null} />);
    expect(screen.getByRole('alert').textContent).toContain('Список не загрузился');
    cleanup();
    render(<TravelAppsList apps={[]} />);
    expect(screen.getByText('Список пока пуст.')).toBeTruthy();
  });
});

describe('админка «Сторонние сервисы»', () => {
  async function renderAdmin(response: () => Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(response));
    const { default: TaaftClient } = await import('@/app/hub/admin/taaft/_TaaftClient');
    render(<TaaftClient />);
  }

  it('первой строкой — это не инструменты Ведара, и где наши; колонки — показ и щелчки людей', async () => {
    await renderAdmin(async () => new Response(JSON.stringify({ tools: [
      { slug: 'wikiloc', name: 'Wikiloc', description: 'Треки.', url: 'https://wikiloc.example', category: 'maps', is_free: true, verified: true, click_count: 7, updated_at: '2026-11-07' },
      { slug: 'old', name: 'Старое', description: 'Скрыто.', url: 'https://old.example', category: 'other', is_free: false, verified: false, click_count: 0, updated_at: '2026-11-07' },
    ] }), { status: 200 }));
    expect(await screen.findByText('Wikiloc')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Сторонние сервисы' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'MCP' }).getAttribute('href')).toBe('/hub/admin/mcp');
    expect(screen.getByText('показывается 1 из 2')).toBeTruthy();
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Сервис', 'Раздел', 'Бесплатно', 'Показывается', 'Щелчки людей', '']);
    expect(document.body.textContent).not.toMatch(/Использований|Рейтинг/);
    const row = screen.getByText('Wikiloc').closest('tr') as HTMLElement;
    expect(within(row).getByText('Карты и треки')).toBeTruthy();
    expect(within(row).getByText('7')).toBeTruthy();
  });

  it('отказ — «не загрузился» с причиной, а не «не найдено» и не падение', async () => {
    await renderAdmin(async () => new Response(JSON.stringify({ error: 'x' }), { status: 500 }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Список не загрузился (ответ 500)');
    expect(document.body.textContent).not.toMatch(/не найден/);
  });

  it('сеть оборвалась — тоже «не загрузился»', async () => {
    await renderAdmin(async () => { throw new TypeError('Failed to fetch'); });
    expect((await screen.findByRole('alert')).textContent).toContain('Failed to fetch');
  });
});

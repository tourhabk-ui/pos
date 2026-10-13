// @vitest-environment node
/**
 * Пробелы метаданных из разбора SEO 13.10 — проверка вызовом, не текстом.
 *
 * 1. Описание оператора (аудит 29.09, Н14). `short_description ?? description
 *    ?? заглушка` пропускал пустую строку: у /operators/kamchatka-rafting
 *    description не было вовсе. Заглушка к тому же называла любого оператора
 *    «проверенным». Здесь зовётся generateMetadata самой страницы на строке
 *    из «базы» — держится не только правило, но и то, что страница его зовёт.
 * 2. Служебные страницы (форма отзыва о месте — ссылка на неё стоит на каждой
 *    карточке места; скачанное для офлайна; профиль; подтверждение
 *    Travelpayouts) шли в выдачу с заголовком сайта по умолчанию — теперь
 *    noindex.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Metadata } from 'next';

const dbQuery = vi.fn();
const poolQuery = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/app/profile/_ProfilePageClient', () => ({ default: () => null }));
vi.mock('@/app/ai-assistant/_AIAssistantClient', () => ({ default: () => null }));
vi.mock('@/app/calendar/_CalendarClient', () => ({ default: () => null }));
vi.mock('@/app/kuzmich/_KuzmichClient', () => ({ default: () => null }));
vi.mock('@/app/request/_RequestClient', () => ({ default: () => null }));
vi.mock('@/app/trip-group/_NewTripGroupClient', () => ({ NewTripGroupClient: () => null }));
vi.mock('@/app/operators/join/_JoinClient', () => ({ default: () => null }));

const LONG = 'Сплавы по рекам Камчатки с 2009 года. Группы до двенадцати человек, '
  + 'снаряжение выдаём на базе, трансфер из Петропавловска входит в цену. '
  + 'Маршруты от одного дня до двух недель, с рыбалкой и наблюдением за медведями.';

async function operatorDescription(o: { short_description: string | null; description: string | null }): Promise<string> {
  dbQuery.mockReset();
  dbQuery.mockResolvedValue({ rows: [{ id: '1', slug: 'test-op', name: 'Тестовый оператор', category: 'operator', is_verified: false, ...o }] });
  const { generateMetadata } = await import('@/app/operators/[slug]/page');
  const meta = await generateMetadata({ params: Promise.resolve({ slug: 'test-op' }) });
  return String(meta.description ?? '');
}

describe('описание оператора в выдаче (Н14)', () => {
  it('пустые строки не глушат запас, а запас не называет оператора проверенным', async () => {
    const d = await operatorDescription({ short_description: '', description: '' });
    expect(d).toBe('Тестовый оператор — туроператор Камчатки. Профиль и контакты на Ведаре.');
    expect(d).not.toMatch(/проверен/i);
  });

  it('пустое короткое описание — берётся полное, обрезанное по предложению', async () => {
    const d = await operatorDescription({ short_description: '  ', description: LONG });
    expect(d.length).toBeGreaterThan(0);
    expect(d.length).toBeLessThanOrEqual(160);
    expect(LONG.startsWith(d.replace(/…$/, ''))).toBe(true);
    expect(d).toMatch(/[.…]$/);
  });

  it('короткое описание есть — оно и идёт', async () => {
    const d = await operatorDescription({ short_description: 'Сплавы и рыбалка на реках Камчатки.', description: LONG });
    expect(d).toBe('Сплавы и рыбалка на реках Камчатки.');
  });
});

describe('служебные страницы закрыты от выдачи', () => {
  it.each([
    ['форма отзыва о месте', () => import('@/app/places/[id]/review/layout')],
    ['скачанное для офлайна', () => import('@/app/offline/manage/layout')],
    ['профиль', () => import('@/app/profile/page')],
    ['подтверждение Travelpayouts', () => import('@/app/tp-verify/page')],
  ])('%s — noindex и свой заголовок', async (_name, load) => {
    const { metadata } = (await load()) as { metadata: Metadata };
    expect((metadata.robots as { index?: boolean } | undefined)?.index).toBe(false);
    expect(typeof metadata.title === 'string' && metadata.title.length > 0).toBe(true);
  });
});

describe('индексируемые страницы называют свой канон', () => {
  it.each([
    ['/ai-assistant', () => import('@/app/ai-assistant/page')],
    ['/calendar', () => import('@/app/calendar/page')],
    ['/kuzmich', () => import('@/app/kuzmich/page')],
    ['/request', () => import('@/app/request/page')],
    ['/trip-group', () => import('@/app/trip-group/page')],
    ['/operators/join', () => import('@/app/operators/join/page')],
  ])('%s', async (path, load) => {
    const { metadata } = (await load()) as { metadata: Metadata };
    expect(metadata.alternates?.canonical).toBe(path);
    expect((metadata.robots as { index?: boolean } | string | undefined)).not.toEqual(expect.objectContaining({ index: false }));
  });

  it('профиль гида: канон по id, пустое описание не глушит запас, длинное режется по слову', async () => {
    const { generateMetadata } = await import('@/app/guides/[id]/page');
    const guide = (description: string | null) => ({ id: 'g-1', name: 'Гид Тестовый', company_name: null, description, rating: 0, review_count: 0,
      is_verified: false, languages: null, specializations: null, experience_years: null, photo_url: null, phone: null });

    poolQuery.mockReset();
    poolQuery.mockResolvedValueOnce({ rows: [guide('')] }).mockResolvedValue({ rows: [] });
    const empty = await generateMetadata({ params: Promise.resolve({ id: 'g-1' }) });
    expect(empty.alternates?.canonical).toBe('/guides/g-1');
    expect(String(empty.description)).toMatch(/^Гид Тестовый: /);

    poolQuery.mockReset();
    poolQuery.mockResolvedValueOnce({ rows: [guide(LONG)] }).mockResolvedValue({ rows: [] });
    const long = String((await generateMetadata({ params: Promise.resolve({ id: 'g-1' }) })).description);
    expect(long.length).toBeLessThanOrEqual(160);
    expect(LONG.startsWith(long.replace(/…$/, ''))).toBe(true);
    expect(long).toMatch(/[.…]$/);
  });
});

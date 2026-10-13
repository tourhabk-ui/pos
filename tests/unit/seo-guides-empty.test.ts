// @vitest-environment node
/**
 * Пустой реестр гидов не предлагается поиску (перепись sitemap 13.10).
 *
 * /guides без единого одобренного гида — страница «профили на проверке» в 49
 * слов, и стояла она в sitemap с приоритетом 0.75. Правило то же, что у
 * пустого раздела жилья: пусто — нет в sitemap и noindex; есть хоть один —
 * обычная страница; база не ответила — ничего не меняем, «не знаю» не равно
 * «пусто» (§4.0). Проверка вызовом: sitemap и generateMetadata страницы.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Metadata } from 'next';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
// React.cache живёт только в серверной сборке React; в тесте — тождество.
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(fn: T) => fn }));

import { collectSitemapEntriesWithStatus } from '@/lib/seo/sitemap-entries';

type Outcome = 'empty' | 'some' | 'down';
function db(outcome: Outcome) {
  query.mockImplementation((sql: string) => {
    const s = String(sql);
    const guidesSql = s.includes('FROM partners p') && (s.includes('COUNT(*)') || s.includes('guide_certifications'));
    if (!guidesSql) return Promise.resolve({ rows: [] });
    if (outcome === 'down') return Promise.reject(Object.assign(new Error('connection refused'), { code: '08006' }));
    if (s.includes('COUNT(*)')) return Promise.resolve({ rows: [{ n: outcome === 'some' ? 2 : 0 }] });
    return Promise.resolve({ rows: outcome === 'some'
      ? [{ id: 'g1', name: 'Гид', company_name: null, description: null, rating: null, review_count: 0, is_verified: true, certs: null }]
      : [] });
  });
}

beforeEach(() => {
  query.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const hasGuides = async () => (await collectSitemapEntriesWithStatus()).entries.some((e) => e.url === 'https://vedarai.ru/guides');
async function guidesRobots(): Promise<Metadata['robots']> {
  const { generateMetadata } = await import('@/app/guides/(list)/page');
  return (await generateMetadata()).robots;
}

describe('/guides в sitemap и в индексе — по тому, есть ли гиды', () => {
  it('гидов нет — в sitemap нет, страница noindex', async () => {
    db('empty');
    expect(await hasGuides()).toBe(false);
    expect(await guidesRobots()).toEqual({ index: false, follow: true });
  });

  it('гиды есть — в sitemap есть, noindex нет', async () => {
    db('some');
    expect(await hasGuides()).toBe(true);
    expect(await guidesRobots()).toBeUndefined();
  });

  it('база не ответила — ничего не убираем и не закрываем', async () => {
    db('down');
    expect(await hasGuides()).toBe(true);
    expect(await guidesRobots()).toBeUndefined();
  });
});

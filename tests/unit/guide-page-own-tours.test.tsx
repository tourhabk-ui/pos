/**
 * Страница гида /guides/[id]: гид со своими турами (1338 — авторские туры
 * гида Андрея Запорожца) ведёт к ним, а не «Найти через оператора».
 *
 * До этого у гидов своих туров не было (туры продавал оператор), и без
 * телефона кнопка вела в список компаний. Для гида, который продаёт тур сам,
 * это неправда: его туры — на его же странице /operators/<slug>, заявка — на
 * странице тура. Туры не прочитались — кнопки к турам нет, но и «туров нет»
 * страница не утверждает: сбой в лог с SQLSTATE (§4.0).
 *
 * Судится рендером: что видит человек — подпись, адрес ссылки, число туров.
 * Сквозной путь на настоящей базе (карточка и туры из миграции, витрина) —
 * tests/integration/operators-list.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: m.query } }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));

import GuideProfilePage from '@/app/guides/[id]/page';

const ID = '0bbb4f05-0000-4000-8000-0000000000bb';
const GUIDE = {
  id: ID, name: 'Андрей Запорожец', company_name: null, description: 'Авторские туры гида.',
  rating: 0, review_count: 0, is_verified: true, languages: null, specializations: null,
  experience_years: null, photo_url: null, phone: null as string | null, slug: 'andrey-zaporozhets',
};

/** База на подмене: профиль, аттестаты и счёт живых туров гида (или отказ счёта). */
function db(opts: { phone?: string | null; tours: number | Error }) {
  m.query.mockImplementation(async (sql: string) => {
    if (/FROM partners p/.test(sql)) return { rows: [{ ...GUIDE, phone: opts.phone ?? null }] };
    if (/FROM guide_certifications/.test(sql)) return { rows: [] };
    if (/FROM operator_tours ot WHERE ot\.operator_id = \$1/.test(sql)) {
      if (opts.tours instanceof Error) throw opts.tours;
      return { rows: [{ n: opts.tours }] };
    }
    throw new Error(`unexpected SQL: ${String(sql).slice(0, 60)}`);
  });
}

async function page(): Promise<string> {
  return renderToStaticMarkup(await GuideProfilePage({ params: Promise.resolve({ id: ID }) }));
}

/** Кнопки-ссылки контакта, как их видит человек: подпись и адрес. */
function links(html: string): { text: string; href: string }[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll<HTMLAnchorElement>('a.ds-btn')]
    .map((a) => ({ text: (a.textContent ?? '').trim(), href: a.getAttribute('href') ?? '' }));
}

const btnClass = (html: string, text: string): string =>
  [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a.ds-btn')]
    .find((a) => (a.textContent ?? '').trim() === text)?.className ?? '';

beforeEach(() => { m.query.mockReset(); });
afterEach(() => vi.restoreAllMocks());

describe('страница гида: свои туры', () => {
  it('у гида 5 живых туров и нет телефона — «Туры гида · 5» на его страницу туров, без «Найти через оператора»', async () => {
    db({ tours: 5 });
    const html = await page();
    expect(links(html)).toEqual([{ text: 'Туры гида · 5', href: '/operators/andrey-zaporozhets' }]);
    expect(html).toContain('У гида свои туры: цена, программа и заявка — на странице каждого тура.');
    expect(html).not.toContain('Найти через оператора');
    // Счёт — только живые туры гида: тот же шлюз витрины, что у каталога.
    const sql = String(m.query.mock.calls.find(([s]) => /FROM operator_tours/.test(String(s)))![0]);
    expect(sql).toMatch(/is_active = true AND ot\.is_published = true AND ot\.deleted_at IS NULL/);
  });

  it('туры и телефон — обе кнопки; звонок главный', async () => {
    db({ tours: 2, phone: '+70000000000' });
    const html = await page();
    expect(links(html).map((l) => l.text)).toEqual(['Туры гида · 2', 'Связаться']);
    expect(btnClass(html, 'Туры гида · 2')).toContain('ds-btn-secondary');
    expect(btnClass(html, 'Связаться')).toContain('ds-btn-primary');
  });

  it('туров нет — как раньше: «Найти через оператора»', async () => {
    db({ tours: 0 });
    const html = await page();
    expect(links(html)).toEqual([{ text: 'Найти через оператора', href: '/operators' }]);
    expect(html).toContain('Хотите пойти с этим гидом?');
  });

  it('туры не прочитались — кнопки к турам нет, «туров нет» не утверждается, в логе SQLSTATE', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db({ tours: Object.assign(new Error('timeout'), { code: '57014' }) });
    const html = await page();
    expect(html).not.toContain('Туры гида');
    expect(err.mock.calls.flat().join(' ')).toMatch(/туры гида не прочитаны.*sqlstate=57014/);
  });
});

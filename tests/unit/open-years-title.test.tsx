// @vitest-environment jsdom
/**
 * tests/unit/open-years-title.test.tsx
 *
 * Год в заголовке витрины — из данных (владелец 11.11: «туры на Камчатку
 * 2026? там же есть и 2027»). «2026» стоял числом в коде каталога, рыбалки
 * и страницы Кузьмича и в ноябре звал в кончившийся сезон, хотя у туров
 * открыты даты и на 2027.
 *
 * Что держит — вызовом generateMetadata с подменённой базой:
 *  - годы — те, что вернул запрос свободных дат (`loadOpenDateYears`), и
 *    рыбалка спрашивает только рыбалку;
 *  - один год — он, два — «2026–2027»;
 *  - дат нет или база не ответила — заголовок без года, а не с прошлым
 *    (§4.0), отказ — в лог с SQLSTATE;
 *  - запрет: год числом в `export const metadata` страниц и шаблонов app/.
 * Сам SQL судится на настоящем PostgreSQL —
 * tests/integration/public-tour-gate.pg.test.ts (сцена «годы свободных дат»).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const poolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));
vi.mock('@/components/marketplace/MarketplaceClient', () => ({ default: () => null }));
vi.mock('@/components/marketplace/CatalogFooter', () => ({ CatalogFooter: () => null }));
vi.mock('@/components/shared/KuzmichContacts', () => ({ default: () => null }));

import { openYearsLabel } from '@/lib/tours/nearest-free-date';

const YEARS_SQL = /годы|make_date\(yr\.y/;
/** Ответ базы на запрос годов; прочие запросы страницы здесь не зовутся. */
function yearsAnswer(rows: { y: number }[] | Error) {
  poolQuery.mockImplementation(async (sql: string) => {
    if (!YEARS_SQL.test(sql)) throw new Error(`неожиданный запрос: ${sql.slice(0, 80)}`);
    if (rows instanceof Error) throw rows;
    return { rows };
  });
}

async function catalogMeta() {
  const { generateMetadata } = await import('@/app/catalog/(list)/page');
  return generateMetadata();
}
async function fishingMeta() {
  const { generateMetadata } = await import('@/app/hub/fishing/page');
  return generateMetadata();
}

beforeEach(() => { poolQuery.mockReset(); vi.restoreAllMocks(); });

describe('годы словами', () => {
  it('нет — пусто; один — он; два — через тире; порядок не важен', () => {
    expect(openYearsLabel(null)).toBe('');
    expect(openYearsLabel([])).toBe('');
    expect(openYearsLabel([2027])).toBe('2027');
    expect(openYearsLabel([2027, 2026])).toBe('2026–2027');
  });
});

describe('каталог /catalog: год в заголовке — из свободных дат', () => {
  it('даты в 2026 и 2027 — «Туры на Камчатку 2026–2027» в заголовке, описании, соцсетях и словах поиска', async () => {
    yearsAnswer([{ y: 2026 }, { y: 2027 }]);
    const m = await catalogMeta();
    expect(m.title).toBe('Туры на Камчатку 2026–2027 — цены и даты от местных операторов');
    expect(m.description).toMatch(/^Туры на Камчатку 2026–2027:/);
    expect((m.openGraph as { title?: string }).title).toBe(m.title);
    expect((m.twitter as { title?: string }).title).toBe(m.title);
    expect(m.keywords).toEqual(expect.arrayContaining(['туры Камчатка 2026', 'туры Камчатка 2027']));
    // Каталог спрашивает все виды туров.
    expect(poolQuery.mock.calls[0]?.[1]).toEqual([null]);
  });

  it('свободные даты только в 2027 — «2027», без 2026', async () => {
    yearsAnswer([{ y: 2027 }]);
    const m = await catalogMeta();
    expect(m.title).toBe('Туры на Камчатку 2027 — цены и даты от местных операторов');
    expect(JSON.stringify(m)).not.toContain('2026');
  });

  it('свободных дат нет — заголовок без года', async () => {
    yearsAnswer([]);
    const m = await catalogMeta();
    expect(m.title).toBe('Туры на Камчатку — цены и даты от местных операторов');
    expect(JSON.stringify([m.title, m.description, m.keywords])).not.toMatch(/\b20\d\d\b/);
  });

  it('база не ответила — заголовок без года, отказ в логе с SQLSTATE', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    yearsAnswer(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    const m = await catalogMeta();
    expect(m.title).toBe('Туры на Камчатку — цены и даты от местных операторов');
    expect(console.error).toHaveBeenCalledWith(
      '[nearest-free-date] годы свободных дат не прочитаны:', 'SQLSTATE=57014', 'canceling statement due to statement timeout',
    );
  });
});

describe('рыбалка /hub/fishing: годы — свободных дат рыбалки', () => {
  it('спрашивает только рыбалку; годы — в заголовке и описании', async () => {
    yearsAnswer([{ y: 2026 }, { y: 2027 }]);
    const m = await fishingMeta();
    expect(poolQuery.mock.calls[0]?.[1]).toEqual(['fishing']);
    expect(m.title).toBe('Рыбалка на Камчатке 2026–2027 — туры, цены, сезоны');
    expect(m.description).toMatch(/^Рыболовные туры на Камчатке 2026–2027:/);
    expect((m.openGraph as { title?: string }).title).toBe(m.title);
    expect(m.robots).toEqual({ index: true, follow: true });
  });

  it('дат нет — без года', async () => {
    yearsAnswer([]);
    const m = await fishingMeta();
    expect(m.title).toBe('Рыбалка на Камчатке — туры, цены, сезоны');
    expect(m.description).toMatch(/^Рыболовные туры на Камчатке: /);
  });
});

describe('запрет: год числом в метаданных страниц', () => {
  const ROOT = process.cwd();
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/^(page|layout)\.tsx?$/.test(name)) files.push(p);
    }
  };
  walk(join(ROOT, 'app'));

  /** Тело `export const metadata = { … }` — до первой строки `};` в начале строки. */
  function metadataBlock(source: string): string {
    const at = source.search(/export const metadata\b/);
    if (at < 0) return '';
    const end = source.indexOf('\n};', at);
    return source.slice(at, end < 0 ? undefined : end);
  }

  it('в `export const metadata` нет года: он устаревает через год, а сезон — раньше', () => {
    const stale = files
      .filter((f) => /\b20[2-3]\d\b/.test(metadataBlock(readFileSync(f, 'utf8')).replace(/\/\/.*$/gm, '')))
      .map((f) => relative(ROOT, f));
    expect(stale).toEqual([]);
  });
});

// @vitest-environment node
/**
 * Заголовок страницы помещается в выдачу: вместе с « | Ведар» — не длиннее
 * TITLE_LIMIT (перепись 13.10).
 *
 * Предел 65 записан в lib/seo/title-fit с аудита 01.10, но звали его пять
 * страниц: перепись 13.10 нашла заголовки по 66–91 знаку. Самые длинные —
 * карточки туров: к имени приклеивался « | Реальные туры Камчатки», а шаблон
 * layout добавлял « | Ведар» — 33 знака хвоста и две черты подряд. Карточки
 * оператора и перевозчика ставили хвост без примерки; у категорий маршрутов в
 * заголовке стоял год — «2026», а у снегоходов «2025–2026», прошедший сезон.
 *
 * Литералы в `export const metadata` — запретом по тексту исходника (правило
 * 13.10: регулярка — только для «этого быть не должно»); заголовки из данных —
 * вызовом generateMetadata на длинном и коротком имени.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TITLE_LIMIT, BRAND_SUFFIX } from '@/lib/seo/title-fit';
import { CATEGORY_PAGES } from '@/lib/routes/category-meta';

const dbQuery = vi.fn();
const poolQuery = vi.fn();
const loadTourCard = vi.fn();
const loadCarrierBySlug = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/lib/tours/tour-detail-query', () => ({
  loadTourCard: (...a: unknown[]) => loadTourCard(...a),
  getTourReviews: async () => [],
}));
vi.mock('@/lib/transfers/charter', () => ({ loadCarrierBySlug: (...a: unknown[]) => loadCarrierBySlug(...a) }));
vi.mock('@/lib/transfers/carrier-view', () => ({ minCharterPrice: () => null, carrierJsonLd: () => ({}) }));

const ROOT = process.cwd();
/** Что увидит поиск: шаблон layout дописывает бренд к строковому title. */
const shown = (title: unknown) => `${String(title)}${BRAND_SUFFIX}`;

beforeEach(() => {
  dbQuery.mockReset();
  poolQuery.mockReset();
  loadTourCard.mockReset();
  loadCarrierBySlug.mockReset();
});

/** Публичные page.tsx и layout.tsx (кабинет и API — мимо; посадочная рыбалки — публичная). */
function publicMetaFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) {
        if (rel === join('app', 'api')) continue;
        if (rel === join('app', 'hub')) { out.push(join('app', 'hub', 'fishing', 'page.tsx')); continue; }
        walk(rel);
      } else if (e.name === 'page.tsx' || e.name === 'layout.tsx') out.push(rel);
    }
  };
  walk('app');
  return out;
}

/** `title:` верхнего уровня в `export const metadata` — строка без подстановок. */
function staticTitle(src: string): string | null {
  const start = src.indexOf('export const metadata');
  if (start < 0) return null;
  const end = src.indexOf('\n};', start);
  const block = src.slice(start, end < 0 ? undefined : end);
  const m = block.match(/^ {2}title:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`$]*`)\s*,/m);
  return m ? m[1].slice(1, -1) : null;
}

describe('статичные заголовки', () => {
  it('ни один не длиннее предела вместе с « | Ведар»', () => {
    const long: string[] = [];
    let seen = 0;
    for (const f of publicMetaFiles()) {
      const t = staticTitle(readFileSync(join(ROOT, f), 'utf-8'));
      if (t === null) continue;
      seen += 1;
      if (shown(t).length > TITLE_LIMIT) long.push(`${f}: ${shown(t).length} зн. «${t}»`);
    }
    // Ноль найденных при непустом входе — отказ сторожа, а не «нарушений нет» (§4.0).
    expect(seen).toBeGreaterThan(60);
    expect(long).toEqual([]);
  });

  it('категории маршрутов: в пределе и без года', () => {
    const slugs = Object.keys(CATEGORY_PAGES);
    expect(slugs.length).toBeGreaterThan(10);
    for (const slug of slugs) {
      const t = CATEGORY_PAGES[slug].title;
      expect(shown(t).length, t).toBeLessThanOrEqual(TITLE_LIMIT);
      expect(t, slug).not.toMatch(/\b(?:19|20)\d\d\b/);
    }
  });
});

const LONG_TOUR = 'Курильское озеро, Долина гейзеров, вулкан Горелый и Авачинский перевал';

function tourRow(title: string) {
  return {
    tour: {
      id: 7, slug: 'test-tour', title, activity_type: 'helicopter',
      short_description: 'Облёт вулканов и посадка у Курильского озера: медведи, нерка, кальдера.',
      description: null, photos: [], tour_image: null,
      operator_name: 'Край Вулканов', operator_verified: false,
    },
    byId: false,
  };
}

async function tourTitle(title: string): Promise<string> {
  loadTourCard.mockResolvedValue(tourRow(title));
  const { generateMetadata } = await import('@/app/catalog/tours/[id]/page');
  return String((await generateMetadata({ params: Promise.resolve({ id: 'test-tour' }) })).title);
}

describe('карточка тура', () => {
  it('короткое имя — с полным хвостом, без второй черты и в пределе', async () => {
    const t = await tourTitle('Мыс Маячный');
    expect(t).toBe('Мыс Маячный — тур на Камчатке');
    expect(t).not.toContain('|');
    expect(shown(t).length).toBeLessThanOrEqual(TITLE_LIMIT);
  });

  it('имя средней длины — хвост короче, заголовок в пределе', async () => {
    const name = 'Курильское озеро и Долина гейзеров за один день';
    const t = await tourTitle(name);
    expect(t).toBe(`${name} — тур`);
    expect(shown(t).length).toBeLessThanOrEqual(TITLE_LIMIT);
  });

  it('длинное имя не режется, а « — тур» остаётся: тур не выходит в выдачу под именем места', async () => {
    const t = await tourTitle(LONG_TOUR);
    expect(t).toBe(`${LONG_TOUR} — тур`);
  });
});

describe('карточка оператора', () => {
  async function operatorTitle(name: string): Promise<string> {
    dbQuery.mockResolvedValue({ rows: [{ id: '1', slug: 'op', name, category: 'operator', is_verified: false, short_description: null, description: null }] });
    const { generateMetadata } = await import('@/app/operators/[slug]/page');
    return String((await generateMetadata({ params: Promise.resolve({ slug: 'op' }) })).title);
  }

  it('тире, а не дефис; короткое имя — с полным хвостом', async () => {
    expect(await operatorTitle('Местечко')).toBe('Местечко — туроператор Камчатки');
  });

  it('имя средней длины — короткий хвост в пределе; длинное — короткий хвост сверх него', async () => {
    const mid = 'Камчатская компания «Вулканы и океан»';
    const tMid = await operatorTitle(mid);
    expect(tMid).toBe(`${mid} — туроператор`);
    expect(shown(tMid).length).toBeLessThanOrEqual(TITLE_LIMIT);
    const long = 'Камчатская туристическая компания «Вулканы и океан»';
    expect(await operatorTitle(long)).toBe(`${long} — туроператор`);
  });
});

describe('карточка перевозчика', () => {
  async function carrierTitle(name: string): Promise<string> {
    loadCarrierBySlug.mockResolvedValue({ name, slug: 'shatun', shortDescription: null, photos: [] });
    const { generateMetadata } = await import('@/app/transfers/[slug]/page');
    return String((await generateMetadata({ params: Promise.resolve({ slug: 'shatun' }) })).title);
  }

  it('короткое имя — с полным хвостом в пределе', async () => {
    const t = await carrierTitle('Шатун');
    expect(t).toBe('Шатун — машина под заказ на Камчатке');
    expect(shown(t).length).toBeLessThanOrEqual(TITLE_LIMIT);
  });

  it('длинное имя — короткий хвост: «машина под заказ» не теряется и сверх предела', async () => {
    const name = 'Транспортная компания «Вахтовки Камчатки»';
    const t = await carrierTitle(name);
    expect(t).toBe(`${name} — машина под заказ`);
  });
});

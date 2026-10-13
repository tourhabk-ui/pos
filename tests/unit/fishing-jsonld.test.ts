// @vitest-environment node
/**
 * Разметка посадочной «Рыбалка» (/hub/fishing) — вызовом страницы на строках
 * «из базы» (перепись 13.10, прогон 6: «JSON-LD с ошибкой — относительный
 * адрес в image»).
 *
 * Что было не так в одном блоке:
 *  - `image: t.photos[0]` — путь от корня сайта; в разметке поисковик
 *    относительных адресов не разрешает;
 *  - оператор — `TouristInformationCenter`: аудит 01.10 заменил его на
 *    организацию оператора в карточке тура, а копия здесь осталась;
 *  - «Продолжительность: N дн.» — часы, округлённые до суток: у выезда на
 *    8 часов выходило «0 дн.».
 *
 * Судья — тот же, что у переписи: jsonld_problems из scripts/site-audit.py.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { isValidElement, type ReactNode } from 'react';

const poolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));
vi.mock('@/app/hub/fishing/_FishingPageClient', () => ({ FishingPageClient: () => null }));

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';
const SCRIPT = join(process.cwd(), 'scripts/site-audit.py');

const ROW = {
  short_description: 'Чавыча и кижуч на реке, снасти выдаём.', description: null,
  max_participants: 6, min_participants: 1, difficulty: 'easy', included: [],
  season_start: null, season_end: null,
};

beforeEach(() => {
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [
    { ...ROW, id: 1, slug: 'rybalka-na-bystroj', title: 'Рыбалка на Быстрой', base_price: 15000, duration_hours: 8,
      photos: ['/images/activities/fishing.jpg'], operator_name: 'Камчатская рыбалка', operator_slug: 'fishingkam', operator_public: true },
    { ...ROW, id: 2, slug: 'splav-s-rybalkoj', title: 'Сплав с рыбалкой', base_price: 42000, duration_hours: 72,
      photos: ['https://cdn.example.org/splav.jpg'], operator_name: 'Оператор без страницы', operator_slug: 'skrytyj', operator_public: false },
  ] });
});

/** JSON-LD из дерева, которое вернула серверная страница. */
function jsonLd(node: ReactNode): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const n of node) { const r = jsonLd(n); if (r) return r; }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as { type?: string; dangerouslySetInnerHTML?: { __html: string }; children?: ReactNode };
  if (node.type === 'script' && props.type === 'application/ld+json' && props.dangerouslySetInnerHTML) {
    return JSON.parse(props.dangerouslySetInnerHTML.__html) as Record<string, unknown>;
  }
  return jsonLd(props.children);
}

async function render(): Promise<{ ld: Record<string, unknown>; items: Record<string, unknown>[] }> {
  const { default: FishingPage } = await import('@/app/hub/fishing/page');
  const ld = jsonLd(await FishingPage());
  expect(ld).not.toBeNull();
  const items = (ld!.itemListElement as { item: Record<string, unknown> }[]).map((e) => e.item);
  return { ld: ld!, items };
}

describe('/hub/fishing: разметка туров', () => {
  it('снимок — абсолютным адресом; уже абсолютный не трогается', async () => {
    const { items } = await render();
    expect(items[0].image).toBe(`${SITE}/images/activities/fishing.jpg`);
    expect(items[1].image).toBe('https://cdn.example.org/splav.jpg');
  });

  it('оператор — организация; адрес и @id — только у открытой страницы', async () => {
    const { items } = await render();
    expect(items[0].provider).toEqual({
      '@type': 'Organization', '@id': `${SITE}/operators/fishingkam#organization`,
      name: 'Камчатская рыбалка', url: `${SITE}/operators/fishingkam`,
    });
    expect(items[1].provider).toEqual({ '@type': 'Organization', name: 'Оператор без страницы' });
  });

  it('нет «0 дн.» и «справочного бюро» вместо оператора', async () => {
    const { ld } = await render();
    const text = JSON.stringify(ld);
    expect(text).not.toMatch(/\b0 дн/);
    expect(text).not.toMatch(/TouristInformationCenter/);
  });

  it('судья переписи (jsonld_problems) ошибок не находит', async () => {
    const { ld } = await render();
    const problems = JSON.parse(execFileSync('python3', ['-c',
      'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("sa", sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.jsonld_problems(json.loads(sys.argv[2]))))',
      SCRIPT, JSON.stringify([JSON.stringify(ld)])], { encoding: 'utf-8' })) as string[];
    expect(problems).toEqual([]);
  });
});

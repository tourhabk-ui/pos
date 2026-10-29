/**
 * Структурные находки SEO-аудита 29.09 (docs/seo/audit-2026-09-29.md) не
 * возвращаются: 404 и 308 карточек — настоящие HTTP-ответы, canonical — в
 * <head> и для Google, карточки мест и маршрутов несут текст в HTML.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { metaDescription } from '@/lib/seo/meta-description';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

/** loading.tsx в папке страницы или выше до app/ — граница, под которой статус уже 200. */
function loadingAbove(pageDir: string): string[] {
  const out: string[] = [];
  let d = pageDir;
  while (d.startsWith('app')) {
    if (existsSync(join(ROOT, d, 'loading.tsx'))) out.push(join(d, 'loading.tsx'));
    if (d === 'app') break;
    d = dirname(d);
  }
  return out;
}

/**
 * Публичные динамические страницы, которые отвечают «нет» или «переехало»:
 * зовут notFound() или permanentRedirect(). Список не руками — перепись
 * 13.10 нашла /guides/<нет> и /accommodations/<нет> с ответом 200: у их
 * разделов loading.tsx лежал над [id], а в ручном списке стояли только три
 * карточки. Кабинеты (/hub) закрыты от индекса и сюда не входят.
 */
function publicStatusPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) {
        if (rel === join('app', 'hub') || rel === join('app', 'api')) continue;
        walk(rel);
      } else if (e.name === 'page.tsx' && /\[[^/]+\]/.test(dir) && /\b(notFound|permanentRedirect)\(/.test(code(rel))) {
        out.push(dir);
      }
    }
  };
  walk('app');
  return out.sort();
}

describe('Н2: над карточками нет loading.tsx — иначе 404 и 308 уходят как 200', () => {
  const pages = publicStatusPages();
  it('карточки нашлись (перепись не пуста)', () => {
    for (const dir of ['app/routes/[id]', 'app/catalog/tours/[id]', 'app/places/[id]', 'app/guides/[id]', 'app/accommodations/[id]']) {
      expect(pages).toContain(dir);
    }
  });
  for (const dir of pages) {
    it(dir, () => {
      expect(loadingAbove(dir), `${dir}: под файлом загрузки notFound()/permanentRedirect() не меняют статус`).toEqual([]);
    });
  }
  it('скелеты списков сохранены в группе (list)', () => {
    for (const p of ['app/routes/(list)/loading.tsx', 'app/catalog/(list)/loading.tsx', 'app/guides/(list)/loading.tsx', 'app/accommodations/(list)/loading.tsx']) {
      expect(existsSync(join(ROOT, p)), p).toBe(true);
    }
  });
  it('«не найдено» объявляет noindex, а корневой layout не ставит index/follow рядом', () => {
    expect(code('app/routes/[id]/page.tsx')).toMatch(/'Маршрут не найден', robots: \{ index: false/);
    expect(code('app/catalog/tours/[id]/page.tsx')).toMatch(/'Тур не найден[^']*', robots: \{ index: false/);
    const layout = code('app/layout.tsx');
    const robots = layout.slice(layout.indexOf('robots: {'), layout.indexOf('manifest:'));
    expect(robots).not.toMatch(/\bindex:\s*true/);
  });
});

describe('Двойники мест под /routes/ — 308 на карточку места (решение владельца 29.09)', () => {
  it('страница маршрута уводит двойника на /places/', () => {
    const src = code('app/routes/[id]/page.tsx');
    expect(src).toMatch(/async function findPlaceTwin/);
    expect(src).toMatch(/permanentRedirect\(`\/places\/\$\{twinOf\}`\)/);
  });
  it('ни sitemap, ни карточка места не ссылаются на двойников', () => {
    const twin = /NOT EXISTS \(SELECT 1 FROM places tp WHERE tp\.slug = kr\.slug AND tp\.is_visible = TRUE\)/;
    expect(code('lib/seo/sitemap-entries.ts')).toMatch(twin);
    // Отбор маршрутов места — общий модуль (03.10), карточка берёт его оттуда.
    expect(code('lib/places/place-routes.ts')).toMatch(twin);
    expect(code('lib/places/place-detail.ts')).toContain('PLACE_ROUTES_SQL');
  });
});

describe('Н4: canonical', () => {
  it('Googlebot получает метаданные в <head>: он в htmlLimitedBots вместе со списком Next по умолчанию', () => {
    const cfg = require(join(ROOT, 'next.config.js')) as { htmlLimitedBots?: RegExp };
    const re = cfg.htmlLimitedBots;
    expect(re).toBeInstanceOf(RegExp);
    expect(re!.test('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
    // Список Next по умолчанию не потерян: наша строка — его надмножество.
    const nextDefault = read('node_modules/next/dist/shared/lib/router/utils/html-bots.js')
      .match(/HTML_LIMITED_BOT_UA_RE = \/(.+)\/i;/)?.[1] ?? '';
    expect(nextDefault.length).toBeGreaterThan(20);
    for (const alt of nextDefault.split('|')) expect(re!.source.split('|')).toContain(alt);
    expect(re!.test('Mozilla/5.0 Chrome/141 Safari/537.36')).toBe(false);
  });
  it('карточка места объявляет canonical по ЧПУ', async () => {
    // Вызовом, а не регуляркой по исходнику (CLAUDE.md §4): с 15.10 рядом с
    // canonical может стоять пара языков китайского конспекта (CN-pages), и
    // литерал «alternates: { canonical }» перестал бы совпадать при верном
    // поведении. Открыли по ark_id — canonical всё равно по ЧПУ.
    const ARK = '0c0aa41c-fd40-4f97-ac35-56f10bf94b69';
    vi.resetModules();
    vi.doMock('@/lib/database', () => ({
      query: async (sql: string) => ({
        rows: String(sql).includes('FROM places p')
          ? [{ place_pk: 'p-1', name: 'Вулкан Горелый', description: null, slug: 'vulkan-gorelyj', ark_id: ARK, lat: 52.5, lng: 158.0, location_type: 'volcano', hazard_types: [], images: [] }]
          : [],
      }),
    }));
    vi.doMock('@/lib/db-pool', () => ({ pool: { query: async () => ({ rows: [] }) } }));
    vi.doMock('@/app/places/[id]/_PlaceDetailClient', () => ({ default: () => null }));
    vi.doMock('@/components/places/PlaceSOS', () => ({ default: () => null }));
    try {
      const { generateMetadata } = await import('@/app/places/[id]/page');
      const meta = await generateMetadata({ params: Promise.resolve({ id: ARK }) });
      expect(meta.alternates?.canonical).toBe('/places/vulkan-gorelyj');
    } finally {
      for (const m of ['@/lib/database', '@/lib/db-pool', '@/app/places/[id]/_PlaceDetailClient', '@/components/places/PlaceSOS']) vi.doUnmock(m);
      vi.resetModules();
    }
  });
});

describe('Н1: карточки несут текст в HTML', () => {
  it('место: данные с сервера, без счётчика просмотров от ботов', () => {
    const page = code('app/places/[id]/page.tsx');
    expect(page).toMatch(/loadPlaceDetail\(arkId, \{ countView: false \}\)/);
    expect(page).toMatch(/<PlaceDetailClient id=\{arkId\} initialPlace=\{initialPlace\} \/>/);
    const client = code('app/places/[id]/_PlaceDetailClient.tsx');
    for (const c of ['PlaceHero', 'PlaceDescription', 'PlaceFacts', 'PlaceRoutes']) {
      expect(client, `${c} снова только на клиенте`).not.toMatch(new RegExp(`const ${c}\\s+= dynamic\\([^\\n]*ssr: false`));
    }
    expect(code('app/api/places/[id]/route.ts')).toMatch(/loadPlaceDetail\(id, \{ countView: true \}\)/);
  });
  it('маршрут: сводка с сервера вместо скелета и вместо «не найден»', () => {
    expect(code('app/routes/[id]/page.tsx')).toMatch(/summary=\{\{/);
    const client = code('app/routes/[id]/_RouteDetailClient.tsx');
    expect(client).toMatch(/if \(loading && summary\)/);
    expect(client).toMatch(/if \(\(notFound \|\| !route\) && summary\)/);
    expect(code('components/routes/RouteServerSummary.tsx')).toMatch(/<h1/);
  });
});

describe('Н7: расчёт готового плана кэшируется', () => {
  it('/plans/[slug] зовёт движок через unstable_cache', () => {
    const src = code('app/plans/[slug]/page.tsx');
    expect(src).toMatch(/unstable_cache\(/);
    expect(src).toMatch(/await loadPresetPlan\(slug, arrival, departure, offerOrderDay\(\)\)/);
  });
});

describe('Н11: описание страницы режется по предложению или слову', () => {
  it('короткий текст — как есть', () => {
    expect(metaDescription('Вулкан на юге Камчатки.')).toBe('Вулкан на юге Камчатки.');
  });
  it('длинный — по концу предложения', () => {
    const t = `${'Первое предложение описания места у вулкана. '.repeat(2)}Третье очень длинное предложение, которое никак не помещается в лимит сниппета и обрывалось бы посреди слова.`;
    const d = metaDescription(t);
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d.endsWith('.')).toBe(true);
  });
  it('без конца предложения — по слову, с многоточием', () => {
    const d = metaDescription('слово '.repeat(60));
    expect(d.endsWith('…')).toBe(true);
    expect(d).not.toMatch(/сло…$/);
  });
  it('теги снимаются, пустой вход — пустая строка, не заглушка', () => {
    expect(metaDescription('<p>Озеро <b>Курильское</b></p>')).toBe('Озеро Курильское');
    expect(metaDescription(null)).toBe('');
  });
});

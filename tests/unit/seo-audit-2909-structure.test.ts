/**
 * Структурные находки SEO-аудита 29.09 (docs/seo/audit-2026-09-29.md) не
 * возвращаются: 404 и 308 карточек — настоящие HTTP-ответы, canonical — в
 * <head> и для Google, карточки мест и маршрутов несут текст в HTML.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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

describe('Н2: над карточками нет loading.tsx — иначе 404 и 308 уходят как 200', () => {
  for (const dir of ['app/routes/[id]', 'app/catalog/tours/[id]', 'app/places/[id]']) {
    it(dir, () => {
      expect(loadingAbove(dir), `${dir}: под файлом загрузки notFound()/permanentRedirect() не меняют статус`).toEqual([]);
    });
  }
  it('скелеты списков сохранены в группе (list)', () => {
    expect(existsSync(join(ROOT, 'app/routes/(list)/loading.tsx'))).toBe(true);
    expect(existsSync(join(ROOT, 'app/catalog/(list)/loading.tsx'))).toBe(true);
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
  it('карточка места объявляет canonical по ЧПУ', () => {
    expect(code('app/places/[id]/page.tsx')).toMatch(/alternates: \{ canonical \}/);
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
    expect(src).toMatch(/await loadPresetPlan\(slug, arrival, departure\)/);
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

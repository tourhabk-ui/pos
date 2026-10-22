// @vitest-environment node
/**
 * Домен партнёра → его сайт на приложении Ведара (слово владельца 22.10:
 * fishingkam.ru «под нашим управлением», DNS на REG.RU).
 *
 * Правила next.config.js исполняются тем же сопоставителем, что у Next
 * (getPathMatch + matchHas), на настоящих заголовках запроса:
 *  - fishingkam.ru/ — страница партнёра, и по Host, и по X-Forwarded-Host
 *    (за прокси Timeweb Host подменяется — урок tourhab.ru 17.08);
 *  - его robots.txt и sitemap.xml — свои, не Ведара;
 *  - www — на голый домен; документы прежнего сайта на Tilda — на политику
 *    Ведара; POST /api/leads формы — мимо всех правил;
 *  - на vedarai.ru ни одно правило домена партнёра не срабатывает: главная,
 *    robots и sitemap Ведара остаются его.
 * И список доменов в next.config.js совпадает с lib/partner-sites/registry.ts:
 * CommonJS TypeScript не читает, два списка разойтись не должны.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { PARTNER_SITES, partnerSiteByKey, partnerSiteForHost, normalizeHost } from '@/lib/partner-sites/registry';

const { getPathMatch } = require('next/dist/shared/lib/router/utils/path-match') as {
  getPathMatch: (source: string, opts: Record<string, unknown>) => (path: string) => false | Record<string, unknown>;
};
const { matchHas } = require('next/dist/shared/lib/router/utils/prepare-destination') as {
  matchHas: (req: { headers: Record<string, string> }, query: Record<string, unknown>, has?: unknown[], missing?: unknown[]) => false | Record<string, unknown>;
};
const config = require(join(process.cwd(), 'next.config.js')) as {
  redirects: () => Promise<Rule[]>;
  rewrites: () => Promise<{ beforeFiles: Rule[]; afterFiles: Rule[] }>;
};

interface Rule { source: string; destination: string; has?: unknown[]; missing?: unknown[]; permanent?: boolean }

function first(rules: Rule[], path: string, headers: Record<string, string>): Rule | null {
  for (const r of rules) {
    const params = getPathMatch(r.source, { strict: true, removeUnnamedParams: true })(path);
    if (params === false) continue;
    if (matchHas({ headers }, {}, r.has, r.missing) === false) continue;
    return r;
  }
  return null;
}

/** Что сделает Next с запросом: redirect, rewrite перед файлами — или ничего (отдаст приложение как есть). */
async function route(path: string, headers: Record<string, string>): Promise<string> {
  const redirect = first(await config.redirects(), path, headers);
  if (redirect) return `redirect ${redirect.destination}`;
  const rewrite = first((await config.rewrites()).beforeFiles, path, headers);
  if (rewrite) return `rewrite ${rewrite.destination}`;
  return 'app';
}

const FK = { host: 'fishingkam.ru' };
const FK_PROXIED = { host: 'tourhab-198048.timeweb.internal', 'x-forwarded-host': 'fishingkam.ru' };
const VEDAR = { host: 'vedarai.ru' };

describe('fishingkam.ru отдаёт сайт партнёра', () => {
  it('главная — страница партнёра, по Host и по X-Forwarded-Host', async () => {
    expect(await route('/', FK)).toBe('rewrite /partner-site/fishingkam');
    expect(await route('/', FK_PROXIED)).toBe('rewrite /partner-site/fishingkam');
  });

  it('robots.txt и sitemap.xml — свои', async () => {
    expect(await route('/robots.txt', FK)).toBe('rewrite /partner-site/fishingkam/robots.txt');
    expect(await route('/sitemap.xml', FK_PROXIED)).toBe('rewrite /partner-site/fishingkam/sitemap.xml');
  });

  it('www — на голый домен одним хопом', async () => {
    expect(await route('/', { host: 'www.fishingkam.ru' })).toBe('redirect https://fishingkam.ru/');
    expect(await route('/pol', { host: 'www.fishingkam.ru' })).toBe('redirect https://fishingkam.ru/:path');
  });

  it('документы прежнего сайта — на политику Ведара, ссылка согласия — на vedarai.ru', async () => {
    for (const p of ['/pol', '/soglasie', '/reklama', '/cookie']) {
      expect(await route(p, FK), p).toBe('redirect https://vedarai.ru/legal/privacy');
    }
    expect(await route('/legal/privacy', FK_PROXIED)).toBe('redirect https://vedarai.ru/legal/:path*');
    expect(await route('/tproduct/123-letnyaya', FK)).toBe('redirect /');
  });

  it('заявка с формы (POST /api/leads) и файлы страницы правилами не трогаются', async () => {
    expect(await route('/api/leads', FK)).toBe('app');
    expect(await route('/api/leads', { host: 'www.fishingkam.ru' })).toBe('app');
    expect(await route('/_next/static/chunks/main.js', FK)).toBe('app');
    expect(await route('/images/fishingkam/2025-01-27_142814.jpg', FK)).toBe('app');
  });
});

describe('на vedarai.ru правила домена партнёра не срабатывают', () => {
  it('главная, robots и sitemap Ведара — его', async () => {
    expect(await route('/', VEDAR)).toBe('app');
    expect(await route('/robots.txt', VEDAR)).toBe('app');
    expect(await route('/sitemap.xml', { host: 'internal', 'x-forwarded-host': 'vedarai.ru' })).toBe('app');
    expect(await route('/pol', VEDAR)).toBe('app');
  });

  it('похожий домен — не партнёр', async () => {
    expect(await route('/', { host: 'fishingkam.ru.example.com' })).toBe('app');
    expect(await route('/', { host: 'notfishingkam.ru' })).toBe('app');
  });
});

describe('список доменов один', () => {
  it('next.config.js и lib/partner-sites/registry.ts называют те же домены и тех же партнёров', async () => {
    const { beforeFiles } = await config.rewrites();
    const fromConfig = new Set(beforeFiles
      .filter((r) => r.source === '/' && (r.has as Array<{ type: string }>)[0]?.type === 'host')
      .map((r) => {
        const value = (r.has as Array<{ value: string }>)[0].value;
        const host = value.replace('(www\\.)?', '').replace(/\\\./g, '.');
        return `${host} → ${r.destination.replace('/partner-site/', '')}`;
      }));
    const fromRegistry = new Set(PARTNER_SITES.map((s) => `${s.host} → ${s.key}`));
    expect(fromConfig).toEqual(fromRegistry);
  });

  it('домен запроса узнаётся без www, порта и регистра', () => {
    expect(normalizeHost('WWW.FishingKam.ru:443')).toBe('fishingkam.ru');
    expect(partnerSiteForHost('fishingkam.ru, proxy.internal')?.key).toBe('fishingkam');
    expect(partnerSiteForHost('vedarai.ru')).toBeNull();
    expect(partnerSiteForHost('')).toBeNull();
  });

  it('партнёр сайта назван id, а не slug, и ключи пути не повторяются', () => {
    // slug партнёра меняется, и у одного партнёра их бывало несколько:
    // 22.10 реестр по slug искал kamchatskaya-rybalka, на проде был другой,
    // и предпросмотр отвечал 404.
    for (const s of PARTNER_SITES) {
      expect(s.partnerId, s.host).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(partnerSiteByKey(s.key)).toBe(s);
    }
    expect(new Set(PARTNER_SITES.map((s) => s.key)).size).toBe(PARTNER_SITES.length);
  });
});

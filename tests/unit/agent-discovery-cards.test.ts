/**
 * Карточка MCP-сервера, AI Catalog домена и реестр A2A (решение владельца
 * 12.10: «сделай нас видимыми для всех агентов и A2A»).
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * 1. Карточка сервера (расширение MCP Server Card, SEP-2127) собирается из
 *    server.json: обязательные поля, имя с одним слэшем, описание до 100
 *    знаков, remotes со Streamable HTTP и версиями протокола; инструментов и
 *    пакетов в ней нет по спецификации. Роут отдаёт её по суффиксу
 *    `<url>/server-card`, не под /.well-known, с медиатипом, часом кэша,
 *    ETag и 304, CORS только на чтение.
 * 2. AI Catalog на /.well-known/ai-catalog.json: specVersion 1.0, записи на
 *    карточку MCP и визитки A2A обеих версий, URN-идентификаторы, пара
 *    identifier+version уникальна, артефакты по ссылке, не inline.
 *    Тот же документ — на /.well-known/ard.json (ARD, преемник), и каждая
 *    запись проходит правила ARD, которыми его судит Lighthouse 13 (аудит
 *    ard-schema): displayName обязателен (20.11 PageSpeed назвал схему
 *    недействительной без него), 2–5 representativeQueries.
 * 3. Реестр A2A: запись с id, адресом страницы, датой и статусом НА МОМЕНТ
 *    регистрации — не «сегодня», чтобы не врать после проверки реестром.
 * 4. Манифест MCP и llms.txt называют все три; оба новых входа считаются
 *    переписью краулеров.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '@/server.json';
import { getPublicBaseUrl } from '@/lib/config';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@/lib/mcp/protocol-version';
import {
  buildServerCard, buildAiCatalog, weakEtag,
  SERVER_CARD_SCHEMA, SERVER_CARD_MEDIA_TYPE, AI_CATALOG_MEDIA_TYPE, A2A_CARD_MEDIA_TYPE,
  SERVER_CARD_PATH, AI_CATALOG_PATH, AI_CATALOG_SPEC_VERSION,
  ARD_PATH, ARD_MEDIA_TYPE, ARD_CONTEXT,
} from '@/lib/mcp/server-card';
import { A2A_CATALOGS, A2A_REGISTRY_AGENT_ID, A2A_DASH_REGISTRY_AGENT_ID, publicCatalogEntry, catalogLine } from '@/lib/a2a/catalogs';
import { AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH, A2A_PROTOCOL_VERSION, A2A_AGENT_NAME } from '@/lib/a2a/agent-card';
import { AGENT_ENTRY_PATHS } from '@/lib/analytics/agent-entry-paths';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

const BASE = 'https://vedarai.ru';
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('карточка MCP-сервера', () => {
  it('форма по схеме расширения: обязательные поля, имя с одним слэшем, описание до 100 знаков, remotes с версиями', () => {
    const card = buildServerCard(BASE);
    expect(card.$schema).toBe(SERVER_CARD_SCHEMA);
    expect(card.$schema).toMatch(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/v1\/server-card\.schema\.json$/);
    expect(card.name).toBe(manifest.name);
    expect(card.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(card.version).toBe(manifest.version);
    expect(card.description).toBe(manifest.description);
    expect(card.description.length).toBeGreaterThan(0);
    expect(card.description.length).toBeLessThanOrEqual(100);
    expect(card.title.length).toBeLessThanOrEqual(100);
    expect(card.websiteUrl).toBe(manifest.websiteUrl);
    expect(card.repository).toEqual({ source: 'github', url: 'https://github.com/tourhabk-ui/pos' });
    expect(card.remotes).toEqual([
      { type: 'streamable-http', url: `${BASE}/api/mcp`, supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] },
    ]);
    // Инструментов и пакетов в карточке нет по спецификации: клиент верит серверу.
    expect(card).not.toHaveProperty('tools');
    expect(card).not.toHaveProperty('packages');
    expect(JSON.stringify(card)).not.toMatch(/TourHab|Tourhab|KamchatourHub/);
  });

  it('адрес — суффикс к Streamable HTTP URL, не /.well-known', () => {
    expect(SERVER_CARD_PATH).toBe('/api/mcp/server-card');
    expect(SERVER_CARD_PATH.startsWith('/.well-known')).toBe(false);
    expect(AI_CATALOG_PATH).toBe('/.well-known/ai-catalog.json');
  });

  it('роут: медиатип, час кэша, ETag и 304, CORS только на чтение, OPTIONS 204', async () => {
    const { GET, OPTIONS } = await import('@/app/api/mcp/server-card/route');
    const res = await GET(new Request(`${BASE}${SERVER_CARD_PATH}`, { headers: { accept: SERVER_CARD_MEDIA_TYPE } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(`${SERVER_CARD_MEDIA_TYPE}; charset=utf-8`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(res.headers.get('access-control-expose-headers')).toBe('ETag');
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^W\/"[0-9a-f]+-\d+"$/);
    const body = await res.text();
    expect(etag).toBe(weakEtag(body));
    expect(JSON.parse(body)).toEqual(buildServerCard(getPublicBaseUrl()));

    const again = await GET(new Request(`${BASE}${SERVER_CARD_PATH}`, { headers: { 'if-none-match': etag! } }));
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect((await OPTIONS()).status).toBe(204);
    // Без запроса (как зовут тесты других роутов) — тоже отвечает.
    expect((await GET()).status).toBe(200);
  });
});

describe('AI Catalog домена', () => {
  it('specVersion, хост, две записи по ссылке с медиатипами, URN, identifier уникален', () => {
    const cat = buildAiCatalog(BASE);
    expect(cat.specVersion).toBe(AI_CATALOG_SPEC_VERSION);
    expect(cat.specVersion).toMatch(/^\d+\.\d+$/);
    expect(cat.host.displayName.length).toBeGreaterThan(0);
    expect(cat.host.url).toBe(BASE);
    expect(cat.entries).toHaveLength(2);
    for (const e of cat.entries) {
      expect(e.identifier).toMatch(/^urn:air:vedarai\.ru:(mcp|a2a):[a-z0-9-]+$/);
      expect(e.url.startsWith(`${BASE}/`)).toBe(true);
      expect(e).not.toHaveProperty('data');
      // Описание — в самом артефакте, не дублируется (дрейф); название ARD
      // требует, и оно берётся из артефакта (проверка ниже).
      expect(e).not.toHaveProperty('description');
    }
    expect(cat.entries[0]).toMatchObject({ type: SERVER_CARD_MEDIA_TYPE, url: `${BASE}${SERVER_CARD_PATH}`, version: manifest.version });
    const a2a = cat.entries.filter((e) => e.type === A2A_CARD_MEDIA_TYPE);
    // Одна запись A2A — визитка 1.0. Визитка 0.3 в каталог не входит: запись
    // с тем же identifier нарушила бы уникальность (ARD §4.2), а она сама
    // отдаётся по своему адресу и названа в mcp.json.
    expect(a2a).toHaveLength(1);
    expect(a2a[0]).toMatchObject({ url: `${BASE}${AGENT_CARD_PATH}`, version: A2A_PROTOCOL_VERSION });
    expect(cat.entries.some((e) => e.url === `${BASE}${LEGACY_AGENT_CARD_PATH}`)).toBe(false);
    expect(a2a[0].identifier).toBe('urn:air:vedarai.ru:a2a:kuzmich');
    expect(cat.entries[0].identifier).toBe('urn:air:vedarai.ru:mcp:vedar');
    const ids = cat.entries.map((e) => e.identifier);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of cat.entries) expect(e['@context']).toBe(ARD_CONTEXT);
  });

  /**
   * Правила ARD (agenticresourcediscovery.org/spec, схема ard-entry.schema.json
   * и conformance-test), которыми Lighthouse 13.6 судит манифест: ошибка — у
   * записи нет identifier по шаблону URN, displayName, type или ровно одного
   * из url/data; предупреждение — representativeQueries нет или их не 2–5.
   */
  it('каждая запись проходит правила ARD: URN, displayName, type, ровно один из url/data, 2–5 запросов', () => {
    const cat = buildAiCatalog(BASE) as unknown as { entries: Array<Record<string, unknown>> };
    expect(Array.isArray(cat.entries)).toBe(true);
    const URN = /^urn:air:([a-zA-Z0-9.-]+)(?::([a-zA-Z0-9._:-]+))?:([a-zA-Z0-9._-]+)$/;
    for (const e of cat.entries) {
      expect(String(e.identifier)).toMatch(URN);
      expect(String(e.identifier)).toMatch(/^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$/);
      expect(typeof e.displayName).toBe('string');
      expect(String(e.displayName).trim().length).toBeGreaterThan(0);
      expect(typeof e.type).toBe('string');
      expect('url' in e !== 'data' in e).toBe(true);
      expect(() => new URL(String(e.url))).not.toThrow();
      const q = e.representativeQueries as unknown[];
      expect(Array.isArray(q)).toBe(true);
      expect(q.length).toBeGreaterThanOrEqual(2);
      expect(q.length).toBeLessThanOrEqual(5);
      for (const x of q) expect(typeof x === 'string' && x.trim().length > 0).toBe(true);
      expect(e).not.toHaveProperty('collections');
    }
    // Название — из самого артефакта, второй копии нет.
    const byType = (t: string) => cat.entries.filter((e) => e.type === t);
    expect(byType(SERVER_CARD_MEDIA_TYPE).map((e) => e.displayName)).toEqual([manifest.title]);
    expect(byType(A2A_CARD_MEDIA_TYPE).map((e) => e.displayName)).toEqual([A2A_AGENT_NAME]);
  });

  it('ard.json отдаёт тот же документ, что ai-catalog.json: свой медиатип, ETag и 304, CORS', async () => {
    expect(ARD_PATH).toBe('/.well-known/ard.json');
    const ard = await import('@/app/.well-known/ard.json/route');
    const old = await import('@/app/.well-known/ai-catalog.json/route');
    const res = await ard.GET(new Request(`${BASE}${ARD_PATH}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(`${ARD_MEDIA_TYPE}; charset=utf-8`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.text();
    const oldBody = await (await old.GET(new Request(`${BASE}${AI_CATALOG_PATH}`))).text();
    expect(body).toBe(oldBody);
    expect(JSON.parse(body)).toEqual(buildAiCatalog(getPublicBaseUrl()));
    const etag = res.headers.get('etag');
    const again = await ard.GET(new Request(`${BASE}${ARD_PATH}`, { headers: { 'if-none-match': etag! } }));
    expect(again.status).toBe(304);
    expect((await ard.OPTIONS()).status).toBe(204);
  });

  it('роут: медиатип каталога, ETag и 304, CORS на чтение', async () => {
    const { GET, OPTIONS } = await import('@/app/.well-known/ai-catalog.json/route');
    const res = await GET(new Request(`${BASE}${AI_CATALOG_PATH}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(`${AI_CATALOG_MEDIA_TYPE}; charset=utf-8`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^W\/"[0-9a-f]+-\d+"$/);
    expect(await res.json()).toEqual(buildAiCatalog(getPublicBaseUrl()));
    const again = await GET(new Request(`${BASE}${AI_CATALOG_PATH}`, { headers: { 'if-none-match': etag! } }));
    expect(again.status).toBe(304);
    expect((await OPTIONS()).status).toBe(204);
  });

  it('weakEtag детерминирован и меняется с телом', () => {
    expect(weakEtag('a')).toBe(weakEtag('a'));
    expect(weakEtag('a')).not.toBe(weakEtag('b'));
    expect(weakEtag('{"x":1}')).toMatch(/^W\/"[0-9a-f]+-7"$/);
  });
});

describe('реестр A2A', () => {
  it('запись с id, адресом страницы, датой и статусом на момент регистрации', () => {
    expect(A2A_REGISTRY_AGENT_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const pending = A2A_CATALOGS.find((c) => c.id === A2A_REGISTRY_AGENT_ID);
    expect(pending).toMatchObject({
      catalog: expect.stringContaining('a2aregistry.org'),
      url: `https://a2aregistry.org/agents/${A2A_REGISTRY_AGENT_ID}`,
      registered_at: '2026-10-12',
      status_at_registration: 'under_review',
      listing: 'pending_review',
    });
    // Статус — поле «на момент регистрации», не «сейчас»: сегодняшний знает только реестр.
    for (const c of A2A_CATALOGS) expect(Object.keys(c)).not.toContain('status');
  });

  /**
   * Слово владельца 14.11 «только где проверена»: называем запись, страницу
   * которой прочитали открытой, со ссылкой и датой проверки; заявку без
   * увиденной записи — без ссылки. Каталог с непроверенным владением
   * (AgentPeering) не называется вовсе.
   */
  it('проверенная запись — со ссылкой и датой проверки, заявка — без ссылки', () => {
    const listed = A2A_CATALOGS.filter((c) => c.listing === 'listed');
    expect(listed.map((c) => c.url)).toEqual([`https://www.a2a-registry.org/agent/${A2A_DASH_REGISTRY_AGENT_ID}`]);
    expect(listed[0]!.checked).toMatch(/^2026-11-14: /);
    expect(publicCatalogEntry(listed[0]!).url).toBe(listed[0]!.url);
    for (const c of A2A_CATALOGS.filter((x) => x.listing !== 'listed')) {
      expect(publicCatalogEntry(c)).not.toHaveProperty('url');
      expect(catalogLine(c)).not.toContain(c.url);
      expect(catalogLine(c)).toContain('заявка подана');
    }
    expect(JSON.stringify(A2A_CATALOGS).toLowerCase()).not.toContain('agentpeering');
  });
});

describe('поверхности называют карточку, каталог и реестр', () => {
  it('манифест MCP: serverCard, aiCatalog, a2a.catalogs', async () => {
    const { GET } = await import('@/app/.well-known/mcp.json/route');
    const json = await (await GET()).json();
    expect(json.serverCard).toMatch(/\/api\/mcp\/server-card$/);
    expect(json.aiCatalog).toMatch(/\/\.well-known\/ai-catalog\.json$/);
    expect(json.a2a.catalogs).toEqual(A2A_CATALOGS.map(publicCatalogEntry));
    const text = JSON.stringify(json);
    for (const c of A2A_CATALOGS) {
      if (c.listing === 'listed') expect(text).toContain(c.url);
      else expect(text).not.toContain(c.url);
    }
  });

  it('llms.txt: карточка, каталог и реестр', async () => {
    const { GET } = await import('@/app/llms.txt/route');
    const text = await (await GET()).text();
    expect(text).toContain(`${BASE}/api/mcp/server-card`);
    expect(text).toContain(`${BASE}/.well-known/ai-catalog.json`);
    for (const c of A2A_CATALOGS) {
      expect(text).toContain(c.id);
      // Ссылка — только у записи, прочитанной открытой; у заявки страницы нет (404).
      if (c.listing === 'listed') expect(text).toContain(c.url);
      else expect(text).not.toContain(c.url);
    }
    expect(text).toMatch(/MCP Server Card/);
  });

  it('оба новых входа считаются переписью краулеров и зовут счётчик', () => {
    expect(AGENT_ENTRY_PATHS).toContain('/api/mcp/server-card');
    expect(AGENT_ENTRY_PATHS).toContain('/.well-known/ai-catalog.json');
    expect(AGENT_ENTRY_PATHS).toContain('/.well-known/ard.json');
    expect(read('app/.well-known/ard.json/route.ts')).toContain('recordAgentEntryHit(ARD_PATH');
    expect(read('app/api/mcp/server-card/route.ts')).toContain('recordAgentEntryHit(SERVER_CARD_PATH');
    expect(read('app/.well-known/ai-catalog.json/route.ts')).toContain('recordAgentEntryHit(AI_CATALOG_PATH');
  });

  it('карточка и каталог — без базы: их читает агент до рукопожатия, а собирается всё из server.json', () => {
    const src = read('lib/mcp/server-card.ts');
    expect(src).not.toMatch(/db-pool|from 'pg'/);
    expect(src).toMatch(/from '@\/server\.json'/);
  });

  it('подтверждение домена для каталога ChatGPT: токен только из переменной, без неё — 404 с объяснением', async () => {
    const { GET, OPENAI_APPS_CHALLENGE_ENV } = await import('@/app/.well-known/openai-apps-challenge/route');
    const prev = process.env[OPENAI_APPS_CHALLENGE_ENV];
    delete process.env[OPENAI_APPS_CHALLENGE_ENV];
    const missing = await GET();
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await missing.text()).toContain(OPENAI_APPS_CHALLENGE_ENV);
    process.env[OPENAI_APPS_CHALLENGE_ENV] = ' token-from-portal ';
    const ok = await GET();
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.text()).toBe('token-from-portal');
    if (prev === undefined) delete process.env[OPENAI_APPS_CHALLENGE_ENV]; else process.env[OPENAI_APPS_CHALLENGE_ENV] = prev;
  });
});

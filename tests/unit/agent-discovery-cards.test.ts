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
} from '@/lib/mcp/server-card';
import { A2A_CATALOGS, A2A_REGISTRY_AGENT_ID } from '@/lib/a2a/catalogs';
import { AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH, A2A_PROTOCOL_VERSION, A2A_LEGACY_PROTOCOL_VERSION } from '@/lib/a2a/agent-card';
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
  it('specVersion, хост, три записи по ссылке с медиатипами, URN, пара identifier+version уникальна', () => {
    const cat = buildAiCatalog(BASE);
    expect(cat.specVersion).toBe(AI_CATALOG_SPEC_VERSION);
    expect(cat.specVersion).toMatch(/^\d+\.\d+$/);
    expect(cat.host.displayName.length).toBeGreaterThan(0);
    expect(cat.host.url).toBe(BASE);
    expect(cat.entries).toHaveLength(3);
    for (const e of cat.entries) {
      expect(e.identifier).toMatch(/^urn:air:vedarai\.ru:(mcp|a2a):[a-z0-9-]+$/);
      expect(e.url.startsWith(`${BASE}/`)).toBe(true);
      expect(e).not.toHaveProperty('data');
      // Название и описание — в самом артефакте, не дублируются (дрейф).
      expect(e).not.toHaveProperty('displayName');
      expect(e).not.toHaveProperty('description');
    }
    expect(cat.entries[0]).toMatchObject({ type: SERVER_CARD_MEDIA_TYPE, url: `${BASE}${SERVER_CARD_PATH}`, version: manifest.version });
    const a2a = cat.entries.filter((e) => e.type === A2A_CARD_MEDIA_TYPE);
    expect(a2a.map((e) => e.url).sort()).toEqual([`${BASE}${AGENT_CARD_PATH}`, `${BASE}${LEGACY_AGENT_CARD_PATH}`].sort());
    expect(a2a.map((e) => e.version).sort()).toEqual([A2A_PROTOCOL_VERSION, A2A_LEGACY_PROTOCOL_VERSION].sort());
    // Один агент — один идентификатор на обе версии протокола; сервер MCP — свой.
    expect(new Set(a2a.map((e) => e.identifier)).size).toBe(1);
    expect(a2a[0].identifier).toBe('urn:air:vedarai.ru:a2a:kuzmich');
    expect(cat.entries[0].identifier).toBe('urn:air:vedarai.ru:mcp:vedar');
    const pairs = cat.entries.map((e) => `${e.identifier}@${e.version}`);
    expect(new Set(pairs).size).toBe(pairs.length);
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
    expect(A2A_CATALOGS).toHaveLength(1);
    expect(A2A_CATALOGS[0]).toMatchObject({
      catalog: expect.stringContaining('a2aregistry.org'),
      id: A2A_REGISTRY_AGENT_ID,
      url: `https://a2aregistry.org/agents/${A2A_REGISTRY_AGENT_ID}`,
      registered_at: '2026-10-12',
      status_at_registration: 'under_review',
    });
    // Статус — поле «на момент регистрации», не «сейчас»: сегодняшний знает только реестр.
    expect(Object.keys(A2A_CATALOGS[0])).not.toContain('status');
  });
});

describe('поверхности называют карточку, каталог и реестр', () => {
  it('манифест MCP: serverCard, aiCatalog, a2a.catalogs', async () => {
    const { GET } = await import('@/app/.well-known/mcp.json/route');
    const json = await (await GET()).json();
    expect(json.serverCard).toMatch(/\/api\/mcp\/server-card$/);
    expect(json.aiCatalog).toMatch(/\/\.well-known\/ai-catalog\.json$/);
    expect(json.a2a.catalogs).toEqual(
      A2A_CATALOGS.map(({ url: _url, ...c }) => ({ ...c, listing: 'pending_review' })),
    );
    expect(JSON.stringify(json)).not.toContain(A2A_CATALOGS[0].url);
  });

  it('llms.txt: карточка, каталог и реестр', async () => {
    const { GET } = await import('@/app/llms.txt/route');
    const text = await (await GET()).text();
    expect(text).toContain(`${BASE}/api/mcp/server-card`);
    expect(text).toContain(`${BASE}/.well-known/ai-catalog.json`);
    expect(text).toContain(A2A_CATALOGS[0].id);
    // Пока запись на проверке, страницы реестра нет (404) — ссылку не публикуем.
    expect(text).not.toContain(A2A_CATALOGS[0].url);
    expect(text).toMatch(/MCP Server Card/);
  });

  it('оба новых входа считаются переписью краулеров и зовут счётчик', () => {
    expect(AGENT_ENTRY_PATHS).toContain('/api/mcp/server-card');
    expect(AGENT_ENTRY_PATHS).toContain('/.well-known/ai-catalog.json');
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

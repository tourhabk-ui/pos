/**
 * OpenAPI 3.1 для агентов и каталог API по RFC 9727 — ступень 3 агентного
 * контура (решение владельца 12.10 «го, делай ступень 3»).
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * 1. Документ проходит валидатор OpenAPI 3.1 (swagger-parser): $ref, формы,
 *    уникальные operationId, параметры пути; заголовок — из server.json.
 * 2. Каждый описанный путь и метод существует в приложении: сегменты
 *    документа сопоставляются с каталогами app/ ([id], [[...path]]), метод —
 *    с экспортом роута. Описание пути, которого нет, — обещание без
 *    источника (§10.09).
 * 3. Каждый описанный /api/* путь открыт Edge анониму тем же методом
 *    (isPublicApiPath): документ для анонимных агентов не описывает того,
 *    что они позвать не могут — прежний /api/docs отвечал анониму 401.
 * 4. Инструменты DataPart — из реестра: oneOf равен PUBLIC_MCP_TOOLS, схема
 *    аргументов равна inputSchema инструмента; второго списка нет.
 * 5. Параметры /api/routes — ключи CatalogQuerySchema плюс brief, который
 *    роут читает сам; новый ключ схемы без описания — красный.
 * 6. Ни прежнего имени платформы, ни почты, ни телефона, ни secret/token.
 * 7. Роуты: application/json по умолчанию и зарегистрированный медиатип по
 *    Accept, linkset — свой; час кэша, ETag и 304, CORS только на чтение;
 *    общий no-store из next.config документы для агентов не перебивает, а у
 *    главной стоит Link rel="api-catalog".
 * 8. Каталог RFC 9727: linkset с anchor, отношения service-desc/-doc/-meta,
 *    абсолютные href с типом, каждая цель — существующий роут или страница.
 * 9. Оба входа считаются переписью краулеров; манифест MCP, llms.txt, /mcp,
 *    README и набор для каталогов их называют; /api/docs удалён вместе с
 *    swagger-jsdoc, валидатор — dev-зависимость.
 * 10. Модуль без базы: агент читает документ до рукопожатия.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import SwaggerParser from '@apidevtools/swagger-parser';
import manifest from '@/server.json';
import { getPublicBaseUrl } from '@/lib/config';
import {
  buildOpenApiDocument, buildApiCatalog,
  OPENAPI_PATH, API_CATALOG_PATH, OPENAPI_VERSION, OPENAPI_MEDIA_TYPE, LINKSET_MEDIA_TYPE,
} from '@/lib/api/openapi';
import { PUBLIC_MCP_TOOLS } from '@/lib/mcp/public-tools';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';
import { AGENT_ENTRY_PATHS } from '@/lib/analytics/agent-entry-paths';
import { CatalogQuerySchema } from '@/lib/routes/catalog-query';
import {
  SERVER_CARD_PATH, AI_CATALOG_PATH, SERVER_CARD_MEDIA_TYPE, A2A_CARD_MEDIA_TYPE, AI_CATALOG_MEDIA_TYPE,
} from '@/lib/mcp/server-card';
import { AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH, A2A_JSONRPC_PATH, A2A_REST_PATH } from '@/lib/a2a/agent-card';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/lib/database', () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));
vi.mock('@/lib/analytics/agent-entry-hits', () => ({ recordAgentEntryHit: vi.fn() }));
import { recordAgentEntryHit } from '@/lib/analytics/agent-entry-hits';

const ROOT = process.cwd();
const BASE = 'https://vedarai.ru';
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

type Json = Record<string, unknown>;
type Parameter = { name: string; in: string; required?: boolean; schema?: Json };
type Operation = { operationId?: string; parameters?: Parameter[]; responses: Record<string, Json>; requestBody?: Json; tags?: string[] };
type OpenApiDoc = {
  openapi: string;
  info: { title: string; version: string; description: string; termsOfService: string };
  servers: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Json> };
};
type Target = { href: string; type: string };
type Context = { anchor: string } & Record<string, Target[] | string>;

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
const doc = buildOpenApiDocument(BASE) as unknown as OpenApiDoc;
const catalog = buildApiCatalog(BASE) as unknown as { linkset: Context[] };

/** Операции документа: путь, метод, операция. */
function operations(): Array<{ path: string; method: string; op: Operation }> {
  const out: Array<{ path: string; method: string; op: Operation }> = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (METHODS.includes(method)) out.push({ path, method, op: op as Operation });
    }
  }
  return out;
}

const dirs = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory()) : []);

/**
 * Файл роута Next для пути документа: сегменты сопоставляются с каталогами
 * app/ — точное имя, [x] для параметра {x}, [...x] и [[...x]] для хвоста
 * (необязательный catch-all отвечает и на пустой хвост — так `/api/a2a/v1`
 * и `/api/a2a/v1/message:send` ведут в один [[...path]]).
 */
function routeFile(dir: string, segments: string[]): string | null {
  const entries = dirs(dir);
  if (segments.length === 0) {
    if (existsSync(join(dir, 'route.ts'))) return join(dir, 'route.ts');
    for (const e of entries) if (/^\[\[\.\.\.[^\]]+\]\]$/.test(e) && existsSync(join(dir, e, 'route.ts'))) return join(dir, e, 'route.ts');
    return null;
  }
  const [head, ...rest] = segments;
  if (entries.includes(head)) {
    const r = routeFile(join(dir, head), rest);
    if (r) return r;
  }
  if (/^\{[^}]+\}$/.test(head)) {
    for (const e of entries) {
      if (!/^\[[^.[\]]+\]$/.test(e)) continue;
      const r = routeFile(join(dir, e), rest);
      if (r) return r;
    }
  }
  for (const e of entries) if (/^\[\[?\.\.\.[^\]]+\]\]?$/.test(e) && existsSync(join(dir, e, 'route.ts'))) return join(dir, e, 'route.ts');
  return null;
}

const segmentsOf = (path: string) => path.split('/').filter(Boolean);
const routeFor = (path: string) => routeFile(join(ROOT, 'app'), segmentsOf(path));
const pageFor = (path: string) => {
  const f = join(ROOT, 'app', ...segmentsOf(path), 'page.tsx');
  return existsSync(f) ? f : null;
};
const exportsMethod = (file: string, method: string) =>
  new RegExp(`export (?:async )?function ${method}\\b|export const ${method}\\b|export \\{[^}]*\\b${method}\\b`).test(readFileSync(file, 'utf-8'));

// ── Заголовки next.config — поведением, как в seo-audit-2909-evening ───────
type HeaderRule = { source: string; headers: { key: string; value: string }[] };
type Matcher = (path: string) => false | Record<string, unknown>;
const req = createRequire(join(ROOT, 'package.json'));
const { getPathMatch } = req('next/dist/shared/lib/router/utils/path-match') as {
  getPathMatch: (source: string, opts: Record<string, unknown>) => Matcher;
};
const { modifyRouteRegex } = req('next/dist/lib/redirect-status') as {
  modifyRouteRegex: (regex: string, restricted?: string[]) => string;
};
async function effective(path: string, key: string): Promise<string | null> {
  const cfg = req(join(ROOT, 'next.config.js')) as { headers: () => Promise<HeaderRule[]> };
  let value: string | null = null;
  for (const rule of await cfg.headers()) {
    const match = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true, regexModifier: (r: string) => modifyRouteRegex(r) });
    if (match(path) === false) continue;
    for (const h of rule.headers) if (h.key.toLowerCase() === key.toLowerCase()) value = h.value;
  }
  return value;
}

describe('документ OpenAPI 3.1', () => {
  it('проходит валидатор; версия, заголовок и сервер — из констант и server.json', async () => {
    expect(doc.openapi).toBe(OPENAPI_VERSION);
    expect(OPENAPI_VERSION).toBe('3.1.0');
    expect(doc.info.title).toBe(manifest.title);
    expect(doc.info.version).toBe(manifest.version);
    expect(doc.servers).toEqual([{ url: BASE }]);
    expect(doc.info.termsOfService).toBe(`${BASE}/legal/terms`);
    // Валидатор меняет вход на месте — ему копия.
    await expect(SwaggerParser.validate(JSON.parse(JSON.stringify(doc)))).resolves.toBeTruthy();
    // Хвост слэша у базы не раздваивает адреса.
    expect(JSON.stringify(buildOpenApiDocument(`${BASE}/`))).toBe(JSON.stringify(doc));
  });

  it('operationId уникальны, у каждой операции есть тег и ответы', () => {
    const ops = operations();
    expect(ops.length).toBeGreaterThanOrEqual(24);
    const ids = ops.map((o) => o.op.operationId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { path, method, op } of ops) {
      expect(op.tags?.length, `${method} ${path}`).toBeGreaterThan(0);
      expect(Object.keys(op.responses).length, `${method} ${path}`).toBeGreaterThan(0);
    }
  });

  it('каждый описанный путь ведёт в существующий роут, и роут экспортирует метод', () => {
    for (const { path, method } of operations()) {
      const file = routeFor(path);
      expect(file, `${method} ${path}: роута нет`).not.toBeNull();
      expect(exportsMethod(file!, method.toUpperCase()), `${method} ${path}: ${file} не экспортирует ${method.toUpperCase()}`).toBe(true);
    }
    // Сопоставление различает параметр и буквальный сегмент, и видит optional catch-all.
    expect(routeFor('/api/tours/{id}/slots')).toBe(join(ROOT, 'app/api/tours/[id]/slots/route.ts'));
    expect(routeFor(`${A2A_REST_PATH}/message:send`)).toBe(join(ROOT, 'app/api/a2a/v1/[[...path]]/route.ts'));
    expect(routeFor(A2A_REST_PATH)).toBe(join(ROOT, 'app/api/a2a/v1/[[...path]]/route.ts'));
    expect(routeFor('/api/tours/{id}/nothing-here')).toBeNull();
    expect(routeFor('/api/nothing-here')).toBeNull();
  });

  it('каждый описанный /api-путь открыт Edge анониму тем же методом', () => {
    const apiOps = operations().filter((o) => o.path.startsWith('/api'));
    expect(apiOps.length).toBeGreaterThanOrEqual(15);
    for (const { path, method } of apiOps) {
      const sample = path.replace(/\{[^}]+\}/g, 'x');
      expect(isPublicApiPath(sample, method.toUpperCase()), `${method} ${path}`).toBe(true);
    }
    // Сам предикат различает метод: POST туда, где открыт только GET, — не публичный.
    expect(isPublicApiPath('/api/tours', 'POST')).toBe(false);
    // Вне /api документ описывает только свои входы обнаружения — они не под Edge.
    for (const { path } of operations().filter((o) => !o.path.startsWith('/api'))) {
      expect(path.startsWith('/.well-known/') || ['/llms.txt', OPENAPI_PATH].includes(path), path).toBe(true);
    }
  });

  it('инструменты DataPart — из реестра: имена, схемы аргументов, ни одной лишней', () => {
    const names = PUBLIC_MCP_TOOLS.map((t) => t.name);
    expect(names.length).toBeGreaterThanOrEqual(19);
    const data = doc.components.schemas.ToolCallData as { oneOf: { $ref: string }[] };
    expect(data.oneOf.map((r) => r.$ref)).toEqual(names.map((n) => `#/components/schemas/ToolCall_${n}`));
    for (const t of PUBLIC_MCP_TOOLS) {
      const s = doc.components.schemas[`ToolCall_${t.name}`] as { required: string[]; properties: { tool: Json; arguments: unknown } };
      expect(s.required, t.name).toEqual(['tool', 'arguments']);
      expect(s.properties.tool, t.name).toEqual({ const: t.name });
      expect(s.properties.arguments, t.name).toEqual(JSON.parse(JSON.stringify(t.inputSchema)));
    }
    const extra = Object.keys(doc.components.schemas).filter((k) => k.startsWith('ToolCall_')).map((k) => k.slice('ToolCall_'.length));
    expect(extra.sort()).toEqual([...names].sort());
    // Четыре заявки названы в описании документа — и 112.
    for (const w of ['create_lead', 'create_booking_request', 'create_stay_request', 'request_charter']) {
      expect(names).toContain(w);
      expect(doc.info.description).toContain(w);
    }
    expect(doc.info.description).toContain('112');
  });

  it('параметры /api/routes — ключи CatalogQuerySchema плюс brief, который роут читает сам', () => {
    const op = doc.paths['/api/routes'].get as Operation;
    const documented = (op.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name).sort();
    const declared = Object.keys(CatalogQuerySchema.shape);
    expect(declared.length).toBeGreaterThanOrEqual(16);
    expect(documented).toEqual([...declared, 'brief'].sort());
    expect(code('app/api/routes/route.ts')).toMatch(/searchParams\.get\('brief'\) === '1'/);
  });

  it('формы ответов названы по коду роутов: degraded у списка туров, unavailable у статуса дня', () => {
    expect(JSON.stringify(doc.components.schemas.ToursResponse)).toMatch(/degraded/);
    expect(code('app/api/tours/route.ts')).toMatch(/degraded: true/);
    expect(JSON.stringify(doc.components.schemas.SafetyStatusResponse)).toMatch(/unavailable/);
    expect(code('app/api/public/safety-status/route.ts')).toMatch(/unavailable: true/);
    // У списка туров нет ответов 4xx/5xx — так и описано.
    expect(Object.keys((doc.paths['/api/tours'].get as Operation).responses)).toEqual(['200']);
    // Отмена задачи A2A — всегда отказ, 200 не обещается.
    expect(Object.keys((doc.paths[`${A2A_REST_PATH}/tasks/{id}:cancel`].post as Operation).responses).sort()).toEqual(['400', '404']);
  });

  it('без прежнего имени платформы, почты, телефона и секретов', () => {
    const text = JSON.stringify(doc) + JSON.stringify(catalog);
    expect(text).not.toMatch(/tour-?hab/i);
    expect(text).not.toMatch(/@[\w.-]+\.(?:ru|com)/);
    expect(text).not.toMatch(/\+7 ?\d{3}|8 ?\(?\d{3}\)? ?\d{3}/);
    expect(text).not.toMatch(/secret|token|password/i);
  });
});

describe('роуты /openapi.json и /.well-known/api-catalog', () => {
  it('OpenAPI: application/json по умолчанию, зарегистрированный медиатип по Accept, час кэша, ETag и 304, CORS, счётчик', async () => {
    const { GET, OPTIONS } = await import('@/app/openapi.json/route');
    vi.mocked(recordAgentEntryHit).mockClear();
    const res = await GET(new Request(`${BASE}${OPENAPI_PATH}`, { headers: { 'user-agent': 'curl/8.5' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^W\/"[0-9a-f]+-\d+"$/);
    expect(await res.json()).toEqual(buildOpenApiDocument(getPublicBaseUrl()));
    expect(recordAgentEntryHit).toHaveBeenCalledWith(OPENAPI_PATH, 'curl/8.5');
    const oas = await GET(new Request(`${BASE}${OPENAPI_PATH}`, { headers: { accept: `${OPENAPI_MEDIA_TYPE}, application/json` } }));
    expect(oas.headers.get('content-type')).toBe(`${OPENAPI_MEDIA_TYPE}; charset=utf-8`);
    const again = await GET(new Request(`${BASE}${OPENAPI_PATH}`, { headers: { 'if-none-match': etag! } }));
    expect(again.status).toBe(304);
    expect((await OPTIONS()).status).toBe(204);
  });

  it('каталог: application/linkset+json, час кэша, ETag и 304, CORS, счётчик', async () => {
    const { GET, OPTIONS } = await import('@/app/.well-known/api-catalog/route');
    vi.mocked(recordAgentEntryHit).mockClear();
    const res = await GET(new Request(`${BASE}${API_CATALOG_PATH}`, { headers: { 'user-agent': 'GPTBot/1.2' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(`${LINKSET_MEDIA_TYPE}; charset=utf-8`);
    expect(LINKSET_MEDIA_TYPE).toBe('application/linkset+json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^W\/"[0-9a-f]+-\d+"$/);
    expect(await res.json()).toEqual(buildApiCatalog(getPublicBaseUrl()));
    expect(recordAgentEntryHit).toHaveBeenCalledWith(API_CATALOG_PATH, 'GPTBot/1.2');
    const again = await GET(new Request(`${BASE}${API_CATALOG_PATH}`, { headers: { 'if-none-match': etag! } }));
    expect(again.status).toBe(304);
    expect((await OPTIONS()).status).toBe(204);
  });

  it('общий no-store из next.config не перебивает документы для агентов; HTML и похожие адреса — по-прежнему no-store', async () => {
    const agentDocs = [OPENAPI_PATH, API_CATALOG_PATH, '/.well-known/mcp.json', AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH, AI_CATALOG_PATH, SERVER_CARD_PATH];
    for (const p of agentDocs) {
      expect(await effective(p, 'Cache-Control'), p).toBeNull();
      // Исключение заслужено: роут ставит час кэша сам.
      const file = routeFor(p);
      expect(file, p).not.toBeNull();
      expect(readFileSync(file!, 'utf-8'), p).toMatch(/'Cache-Control': 'public, max-age=3600'/);
    }
    for (const p of ['/', '/mcp', '/openapi.json.bak', '/.well-known/api-catalogue', '/.well-known/openai-apps-challenge', '/api/mcp', `${A2A_REST_PATH}/message:send`, '/api/tours']) {
      expect(await effective(p, 'Cache-Control'), p).toMatch(/no-store/);
    }
  });

  it('главная несёт Link rel="api-catalog" на каталог (RFC 9727)', async () => {
    expect(await effective('/', 'Link')).toBe(`<${API_CATALOG_PATH}>; rel="api-catalog"`);
    expect(API_CATALOG_PATH).toBe('/.well-known/api-catalog');
  });
});

describe('каталог API по RFC 9727', () => {
  it('linkset: три контекста, отношения service-desc/-doc/-meta, абсолютные href с типом, каждая цель существует', () => {
    expect(catalog.linkset.map((c) => c.anchor)).toEqual([`${BASE}/api/`, `${BASE}/api/mcp`, `${BASE}${A2A_JSONRPC_PATH}`]);
    for (const ctx of catalog.linkset) {
      const rels = Object.keys(ctx).filter((k) => k !== 'anchor');
      expect(rels.length, ctx.anchor).toBeGreaterThan(0);
      for (const rel of rels) {
        expect(['service-desc', 'service-doc', 'service-meta'], rel).toContain(rel);
        const targets = ctx[rel] as Target[];
        expect(targets.length, `${ctx.anchor} ${rel}`).toBeGreaterThan(0);
        for (const t of targets) {
          expect(t.href.startsWith(`${BASE}/`), t.href).toBe(true);
          expect(t.type, t.href).toMatch(/^[a-z]+\/[\w.+-]+$/);
          const path = t.href.slice(BASE.length);
          expect(routeFor(path) ?? pageFor(path), `${t.href}: ни роута, ни страницы`).not.toBeNull();
        }
      }
    }
    expect(catalog.linkset[0]['service-desc']).toEqual([{ href: `${BASE}${OPENAPI_PATH}`, type: OPENAPI_MEDIA_TYPE }]);
    expect(OPENAPI_MEDIA_TYPE).toBe('application/vnd.oai.openapi+json');
    expect((catalog.linkset[0]['service-meta'] as Target[]).map((t) => t.href)).toEqual([`${BASE}/legal/terms`]);
    expect((catalog.linkset[1]['service-desc'] as Target[]).map((t) => [t.href, t.type])).toEqual([
      [`${BASE}${SERVER_CARD_PATH}`, SERVER_CARD_MEDIA_TYPE],
      [`${BASE}/.well-known/mcp.json`, 'application/json'],
    ]);
    expect((catalog.linkset[2]['service-desc'] as Target[]).map((t) => [t.href, t.type])).toEqual([
      [`${BASE}${AGENT_CARD_PATH}`, A2A_CARD_MEDIA_TYPE],
      [`${BASE}${LEGACY_AGENT_CARD_PATH}`, A2A_CARD_MEDIA_TYPE],
      [`${BASE}${AI_CATALOG_PATH}`, AI_CATALOG_MEDIA_TYPE],
    ]);
  });
});

describe('поверхности и зависимости', () => {
  it('оба входа считаются переписью краулеров', () => {
    expect(AGENT_ENTRY_PATHS).toContain(OPENAPI_PATH);
    expect(AGENT_ENTRY_PATHS).toContain(API_CATALOG_PATH);
  });

  it('манифест MCP, llms.txt, страница /mcp, README и набор для каталогов называют оба входа', async () => {
    const { GET } = await import('@/app/.well-known/mcp.json/route');
    const json = await (await GET()).json();
    expect(json.openapi).toMatch(/\/openapi\.json$/);
    expect(json.apiCatalog).toMatch(/\/\.well-known\/api-catalog$/);
    const llms = await (await (await import('@/app/llms.txt/route')).GET()).text();
    expect(llms).toContain(`${BASE}${OPENAPI_PATH}`);
    expect(llms).toContain(`${BASE}${API_CATALOG_PATH}`);
    expect(llms).toMatch(/^## Для AI-агентов: REST и OpenAPI/m);
    expect(llms).toMatch(/RFC 9727/);
    expect(llms).toMatch(/GPT Actions/);
    for (const f of ['app/mcp/page.tsx', 'README.md', 'docs/agents/CATALOGS.md']) {
      expect(read(f), f).toContain('/openapi.json');
      expect(read(f), f).toContain('/.well-known/api-catalog');
    }
    expect(read('docs/agents/CATALOGS.md')).toMatch(/GPT Actions/);
  });

  it('прежний /api/docs удалён вместе с swagger-jsdoc; валидатор — dev-зависимость, не прод', () => {
    expect(existsSync(join(ROOT, 'app/api/docs'))).toBe(false);
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.dependencies['swagger-jsdoc']).toBeUndefined();
    expect(pkg.devDependencies['swagger-jsdoc']).toBeUndefined();
    expect(pkg.devDependencies['@types/swagger-jsdoc']).toBeUndefined();
    expect(pkg.devDependencies['@apidevtools/swagger-parser']).toBeDefined();
    expect(pkg.dependencies['@apidevtools/swagger-parser']).toBeUndefined();
    expect(read('tests/unit/route-inventory.test.ts')).not.toMatch(/^\s*'\/api\/docs',/m);
  });

  it('модуль документа без базы и из тех же источников, что карточки: server.json и реестр инструментов', () => {
    const src = read('lib/api/openapi.ts');
    expect(src).not.toMatch(/db-pool|lib\/database|from 'pg'/);
    expect(src).toMatch(/from '@\/server\.json'/);
    expect(src).toMatch(/from '@\/lib\/mcp\/public-tools'/);
    // Роуты зовут счётчик константами пути — не второй строкой.
    expect(read('app/openapi.json/route.ts')).toContain('recordAgentEntryHit(OPENAPI_PATH');
    expect(read('app/.well-known/api-catalog/route.ts')).toContain('recordAgentEntryHit(API_CATALOG_PATH');
  });
});

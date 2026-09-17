/**
 * Сторож: сервер готов к публикации в официальном реестре MCP и в каталогах.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * 16.09 владелец принёс слова чужих агентов: «к vedarai.ru/api/mcp не
 * обращаемся — его нет в каталоге». Разбор показал, что каталог не один, а
 * четыре, и главный из них — официальный реестр (registry.modelcontextprotocol.io),
 * из которого раз в час тянут агрегаторы. Туда можно добавиться самим, но
 * перед этим у сервера нашлись три пробела, которые любое ревью увидит:
 *
 *   · `initialize` отвечал константой `2024-11-05` — ревизией эпохи HTTP+SSE,
 *     при том что сервер живёт на Streamable HTTP (ревизия 2025-03-26);
 *   · ни у одного из тринадцати инструментов не было аннотаций — хост не мог
 *     отличить «посмотреть погоду» от «оставить телефон менеджеру»;
 *   · на уведомление `notifications/initialized` уходил JSON-ответ с `id: null`
 *     — ответ на вопрос, которого не задавали.
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * Не «файл server.json есть», а связка: манифест реестра совпадает с тем, что
 * сервер говорит о себе; аннотации есть у КАЖДОГО инструмента и пишущие
 * определяются ими же, а не вторым списком; версия протокола договаривается,
 * а не диктуется; доказательство владения доменом отдаётся только при
 * настоящем ключе.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { PUBLIC_MCP_TOOLS, WRITE_TOOL_NAMES, TOOL_ANNOTATIONS, MCP_SERVER_INFO } from '@/lib/mcp/public-tools';
import { CANONICAL_BASE_URL } from '@/lib/config';
import {
  SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION, negotiateProtocolVersion,
} from '@/lib/mcp/protocol-version';
import { registryAuthState, MCP_REGISTRY_AUTH_ENV, registryAuthLine } from '@/lib/mcp/registry-auth';

vi.mock('@/lib/kuzmich/core', () => ({
  executeKuzmichTool: vi.fn(async (name: string) => `executed:${name}`),
}));

import { POST } from '@/app/api/mcp/route';
import { GET as authGet } from '@/app/.well-known/mcp-registry-auth/route';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/** Требования схемы реестра (server.schema.json 2025-12-11), проверенные 16.09. */
const REGISTRY_NAME = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const REGISTRY_DESCRIPTION_MAX = 100;

describe('server.json — манифест для официального реестра', () => {
  const manifest = JSON.parse(read('server.json')) as {
    name: string; description: string; version: string; websiteUrl?: string;
    remotes: { type: string; url: string }[];
  };

  it('имя — наш домен в обратной записи, по правилу реестра', () => {
    expect(manifest.name).toBe('ru.vedarai/mcp');
    expect(manifest.name).toMatch(REGISTRY_NAME);
  });

  it('описание влезает в лимит реестра', () => {
    // Карточка для каталогов из #1915 — ~200 знаков; реестр режет на 100.
    // Здесь лежит ужатая, и она не должна снова разрастись.
    expect(manifest.description.length).toBeLessThanOrEqual(REGISTRY_DESCRIPTION_MAX);
    expect(manifest.description.length).toBeGreaterThan(20);
  });

  it('версия — та же, что сервер называет на рукопожатии', () => {
    // Две версии в двух файлах разъедутся на первом же релизе.
    expect(manifest.version).toBe(MCP_SERVER_INFO.version);
  });

  it('удалённый эндпоинт — наш живой сервер по Streamable HTTP', () => {
    expect(manifest.remotes).toHaveLength(1);
    expect(manifest.remotes[0]).toEqual({ type: 'streamable-http', url: `${CANONICAL_BASE_URL}/api/mcp` });
    expect(manifest.websiteUrl).toBe(`${CANONICAL_BASE_URL}/mcp`);
  });
});

describe('доказательство владения доменом — только при настоящем ключе', () => {
  afterEach(() => vi.unstubAllEnvs());

  // 32 нулевых байта в base64 — форма верная, значение тестовое.
  const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

  it('переменной нет — not_configured, снаружи 404, никакой заглушки', async () => {
    vi.stubEnv(MCP_REGISTRY_AUTH_ENV, '');
    expect(registryAuthState()).toEqual({ state: 'not_configured' });
    const res = await authGet();
    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(/MCPv1/);
  });

  it('битый ключ — malformed с именем переменной, снаружи 500', async () => {
    vi.stubEnv(MCP_REGISTRY_AUTH_ENV, 'not-a-key');
    const s = registryAuthState();
    expect(s.state).toBe('malformed');
    if (s.state === 'malformed') expect(s.reason).toContain(MCP_REGISTRY_AUTH_ENV);
    const res = await authGet();
    expect(res.status).toBe(500);
    expect(await res.text()).toContain(MCP_REGISTRY_AUTH_ENV);
  });

  it('настоящий ключ — одна строка формата реестра', async () => {
    vi.stubEnv(MCP_REGISTRY_AUTH_ENV, KEY);
    const res = await authGet();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`v=MCPv1; k=ed25519; p=${KEY}`);
    expect(registryAuthLine(KEY)).toBe(`v=MCPv1; k=ed25519; p=${KEY}`);
  });

  it('переменная описана в .env.example, приватный ключ — нигде', () => {
    const env = read('.env.example');
    expect(env).toContain(`${MCP_REGISTRY_AUTH_ENV}=`);
    expect(env).not.toMatch(/PRIVATE_KEY|key\.pem=/);
  });
});

describe('аннотации — у каждого инструмента, и пишущие определяются ими', () => {
  it('ни одного инструмента без аннотаций и заголовка', () => {
    for (const t of PUBLIC_MCP_TOOLS) {
      expect(t.annotations, `${t.name}: нет аннотаций — хост не поймёт, спрашивать ли человека`).toBeDefined();
      expect(t.title, `${t.name}: нет заголовка`).toBeTruthy();
    }
  });

  it('записи в TOOL_ANNOTATIONS нет для инструмента, которого нет наружу', () => {
    // Иначе список пухнет мёртвыми именами и перестаёт быть переписью.
    const live = new Set(PUBLIC_MCP_TOOLS.map((t) => t.name));
    for (const name of Object.keys(TOOL_ANNOTATIONS)) {
      expect(live.has(name), `${name}: аннотация есть, инструмента нет`).toBe(true);
    }
  });

  it('пишущих ровно два, и это заявки; всё остальное только читает', () => {
    expect([...WRITE_TOOL_NAMES].sort()).toEqual(['create_booking_request', 'create_lead']);
    for (const t of PUBLIC_MCP_TOOLS) {
      const a = t.annotations!;
      if (WRITE_TOOL_NAMES.has(t.name)) {
        expect(a.readOnlyHint).toBe(false);
        // Заявка создаёт запись, чужие не трогает.
        expect(a.destructiveHint).toBe(false);
      } else {
        expect(a.readOnlyHint, `${t.name} читает, а помечен пишущим`).toBe(true);
        expect(a.idempotentHint).toBe(true);
      }
    }
  });

  it('роут берёт пишущие из аннотаций, а не из своего списка', () => {
    const src = read('app/api/mcp/route.ts');
    expect(src).toMatch(/WRITE_TOOL_NAMES/);
    expect(src).not.toMatch(/new Set<string>\(\[CREATE_LEAD_TOOL\.name/);
  });
});

describe('версия протокола договаривается, а не диктуется', () => {
  it('новейшая — первая в списке; список не пуст', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS.length).toBeGreaterThanOrEqual(3);
    expect(LATEST_PROTOCOL_VERSION).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    // Streamable HTTP появился в 2025-03-26: сервер на нём обязан называть
    // хотя бы эту ревизию, иначе называет то, чем не является.
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-03-26');
  });

  it('запрошенную поддерживаемую — возвращает ту же; незнакомую — новейшую нашу', () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) expect(negotiateProtocolVersion(v)).toBe(v);
    expect(negotiateProtocolVersion('2099-01-01')).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(42)).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('роут зовёт переговоры и не держит версию константой', () => {
    const src = read('app/api/mcp/route.ts');
    expect(src).toMatch(/negotiateProtocolVersion\(/);
    expect(src).not.toMatch(/protocolVersion: '\d{4}-\d{2}-\d{2}'/);
  });

  it('живое рукопожатие: клиент просит 2025-03-26 — получает её', async () => {
    const res = await POST(new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
    }));
    const json = await res.json();
    expect(json.result.protocolVersion).toBe('2025-03-26');
    expect(json.result.serverInfo.version).toBe(MCP_SERVER_INFO.version);
  });
});

describe('уведомление — без ответа', () => {
  it('notifications/initialized принимается пустым 202', async () => {
    const res = await POST(new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });
});

/**
 * Сторож сборки Ведара на Glama (integrations/glama, «3 да» владельца 20.11).
 *
 * Glama собирает сервер из репозитория и мост к vedarai.ru не принимает.
 * Образ запускает integrations/glama/server/server.mjs: stdio, без
 * зависимостей, без базы. Сторож держит:
 *  - снимок определений = то, что отдаёт живой сервер сейчас (иначе Glama
 *    оценивала бы не те инструменты);
 *  - поведение сервера, запущенного настоящим node: рукопожатие, список,
 *    честный отказ вызова с адресом живого сервера;
 *  - шаг сборки и CMD формы исполняются (а не только записаны);
 *  - README и Dockerfile повторяют форму;
 *  - в сборке нет моста и запросов наружу (запрет — регуляркой).
 *
 * Сборка у самой Glama и её оценка отсюда не видны: докера в CI нет.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildGlamaSnapshot } from '@/lib/mcp/glama-snapshot';
import { PUBLIC_MCP_TOOLS, MCP_SERVER_INFO } from '@/lib/mcp/public-tools';
import { LEGACY_PROTOCOL_VERSIONS } from '@/lib/mcp/protocol-version';
import { MCP_ENDPOINT } from '@/lib/mcp/connect';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const DIR = 'integrations/glama';

interface GlamaBuild {
  server: string;
  buildSteps: string[];
  cmdArguments: string[];
  mcpProxyVersion: string;
}

const build = JSON.parse(read(`${DIR}/glama-build.json`)) as GlamaBuild;
const dockerfile = read(`${DIR}/Dockerfile`);
const readme = read(`${DIR}/README.md`);
const serverSource = read(build.server);

interface RpcReply {
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Запускает сервер командой формы, шлёт строки JSON-RPC, читает ответы. */
function talk(lines: unknown[]): RpcReply[] {
  const [cmd, ...args] = build.cmdArguments;
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    input: lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RpcReply);
}

const init = (id: number, protocolVersion: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'guard', version: '1' } },
});

describe('снимок определений', () => {
  it('tools.json — ровно то, что отдаёт живой сервер (снять заново: npx tsx scripts/glama-tools-snapshot.ts)', () => {
    const snapshot = JSON.parse(read(`${DIR}/server/tools.json`));
    expect(snapshot).toEqual(buildGlamaSnapshot());
  });

  it('снимок несёт все инструменты, serverInfo и адрес живого сервера', () => {
    const s = buildGlamaSnapshot();
    expect((s.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(PUBLIC_MCP_TOOLS.map((t) => t.name));
    expect(s.serverInfo.name).toBe(MCP_SERVER_INFO.name);
    expect(s.serverInfo.version).toBe(MCP_SERVER_INFO.version);
    expect(s.protocolVersions).toEqual([...LEGACY_PROTOCOL_VERSIONS]);
    expect(s.liveEndpoint).toBe(MCP_ENDPOINT);
  });
});

describe('сервер — поведение (настоящий node, команда формы)', () => {
  let replies: RpcReply[] = [];
  let byId = new Map<number | null, RpcReply>();
  beforeAll(() => {
    replies = talk([
    init(1, '2025-06-18'),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_weather', arguments: { location: 'Елизово' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_lead', arguments: { name: 'А', phone: '+79990000000', consent: true } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'no_such_tool' } },
    { jsonrpc: '2.0', id: 6, method: 'resources/list' },
    { jsonrpc: '2.0', id: 7, method: 'ping' },
    init(8, '2099-01-01'),
    'not json',
    ]);
    byId = new Map(replies.map((r) => [r.id, r]));
  });

  it('уведомление без ответа; на каждый запрос — один ответ', () => {
    // 9 запросов с id + ошибка разбора (id null); notifications/initialized — без ответа
    expect(replies).toHaveLength(9);
  });

  it('initialize: запрошенная знакомая версия, serverInfo Ведара, инструкции называют живой сервер', () => {
    const r = byId.get(1)!.result!;
    expect(r.protocolVersion).toBe('2025-06-18');
    expect((r.serverInfo as { name: string }).name).toBe(MCP_SERVER_INFO.name);
    expect(r.capabilities).toEqual({ tools: { listChanged: false } });
    expect(String(r.instructions)).toContain(MCP_ENDPOINT);
    expect(String(r.instructions)).toMatch(/no Kamchatka database/);
  });

  it('initialize с незнакомой версией — новейшая legacy, не выдуманная', () => {
    expect(byId.get(8)!.result!.protocolVersion).toBe(LEGACY_PROTOCOL_VERSIONS[0]);
  });

  it('tools/list — все инструменты живого сервера', () => {
    const tools = byId.get(2)!.result!.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(PUBLIC_MCP_TOOLS.map((t) => t.name));
  });

  it('вызов читающего и пишущего инструмента — ошибка инструмента «данных нет» с адресом живого сервера', () => {
    for (const id of [3, 4]) {
      const r = byId.get(id)!.result!;
      expect(r.isError).toBe(true);
      const text = (r.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/No data/);
      expect(text).toMatch(/nothing was sent/);
      expect(text).toContain(MCP_ENDPOINT);
    }
  });

  it('неизвестный инструмент — -32602, неизвестный метод — -32601, ping — пустой ответ, мусор — -32700', () => {
    expect(byId.get(5)!.error!.code).toBe(-32602);
    expect(byId.get(6)!.error!.code).toBe(-32601);
    expect(byId.get(7)!.result).toEqual({});
    expect(byId.get(null)!.error!.code).toBe(-32700);
  });
});

describe('форма Glama', () => {
  it('шаг сборки исполняется из корня репозитория и проходит', () => {
    for (const step of build.buildSteps) {
      const r = spawnSync('sh', ['-c', step], { cwd: ROOT, encoding: 'utf8', timeout: 15_000 });
      expect(r.status, `${step}: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain(`${PUBLIC_MCP_TOOLS.length} tools`);
    }
  });

  it('CMD формы запускает файл сервера, без «mcp-proxy --»: Glama ставит их сама', () => {
    expect(build.cmdArguments).toEqual(['node', build.server]);
    expect(build.cmdArguments).not.toContain('mcp-proxy');
    expect(/^\d+\.\d+\.\d+$/.test(build.mcpProxyVersion)).toBe(true);
  });

  it('README даёт оба поля одной строкой, ровно как в glama-build.json', () => {
    const blocks = [...readme.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
    expect(blocks).toContain(JSON.stringify(build.buildSteps));
    expect(blocks).toContain(JSON.stringify(build.cmdArguments));
    for (const b of blocks) expect(b.includes('\n'), `многострочный блок: ${b}`).toBe(false);
  });

  it('Dockerfile: основа Glama, mcp-proxy той же версии, шаг сборки и CMD = «mcp-proxy --» + CMD формы', () => {
    const lines = dockerfile
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
      .replace(/\\\n/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines.find((l) => l.startsWith('FROM '))).toBe('FROM debian:trixie-slim');
    expect(dockerfile).toContain('setup_24.x');
    const runs = lines.filter((l) => l.startsWith('RUN '));
    expect(runs.some((r) => r.includes(`npm install -g mcp-proxy@${build.mcpProxyVersion}`))).toBe(true);
    for (const step of build.buildSteps) expect(runs.some((r) => r.includes(step)), step).toBe(true);
    const cmd = JSON.parse(lines.find((l) => l.startsWith('CMD '))!.slice(4)) as string[];
    expect(cmd).toEqual(['mcp-proxy', '--', ...build.cmdArguments]);
  });

  it('glama.json называет аккаунт владельца записи', () => {
    const g = JSON.parse(read('glama.json')) as { maintainers: string[] };
    expect(g.maintainers).toContain('tourhabk-ui');
  });
});

describe('запреты: ни моста, ни запросов наружу', () => {
  it('в форме, Dockerfile и сервере нет mcp-remote', () => {
    expect(JSON.stringify(build)).not.toMatch(/mcp-remote/);
    expect(dockerfile).not.toMatch(/mcp-remote/);
    expect(serverSource).not.toMatch(/mcp-remote/);
  });

  // Белый список, а не перечень сетевых модулей: чёрный список пропускал
  // node:http2, node:tls, node:dns, child_process, импорт ради побочного
  // эффекта и require через createRequire (ревью безопасности PR 3612).
  const ALLOWED_MODULES = ['node:fs', 'node:path', 'node:readline', 'node:url'];

  it('сервер импортирует только модули из белого списка — ни сети, ни процессов, ни зависимостей', () => {
    const specifiers = [...serverSource.matchAll(/(?:^|[\s;])import\s*(?:[^'"`;()]*?\bfrom\s*)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(ALLOWED_MODULES, `модуль вне белого списка: ${s}`).toContain(s);
  });

  it('в сервере нет обходов белого списка: fetch, globalThis, require, import(), eval, getBuiltinModule', () => {
    expect(serverSource).not.toMatch(
      /\bfetch\b|\bglobalThis\b|\brequire\b|createRequire|\bimport\s*\(|\beval\s*\(|new\s+Function|process\.binding|WebSocket|XMLHttpRequest|EventSource|\bmodule\b\.|process\.dlopen|getBuiltinModule|\bprocess\s*\[/,
    );
  });

  it('белый список сторожа ловит то, что пропускал прежний (проверка самого сторожа)', () => {
    const bad = [
      "import { request } from 'node:http2';",
      "import tls from 'node:tls';",
      "import 'node:dns';",
      "import 'some-package';",
      "import { execSync } from 'node:child_process';",
    ];
    for (const line of bad) {
      const [spec] = [...line.matchAll(/(?:^|[\s;])import\s*(?:[^'"`;()]*?\bfrom\s*)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
      expect(spec, line).toBeDefined();
      expect(ALLOWED_MODULES.includes(spec), line).toBe(false);
    }
  });
});

#!/usr/bin/env node
/**
 * Сервер MCP Ведара для проверки на Glama — stdio, без зависимостей, без базы.
 *
 * Зачем он есть. Главный список MCP-серверов (punkpeye/awesome-mcp-servers,
 * заявка #18155) берёт строку только с записью сервера на Glama, а Glama
 * собирает сервер из репозитория и мост к vedarai.ru не принимает: «The
 * Dockerfile must build and run the server locally, not proxy to an external
 * endpoint» (20.11). Всё приложение Ведара с PostgreSQL в образ не собрать.
 * Владелец выбрал короткую сборку («3 да», 20.11).
 *
 * Что он делает. Отвечает на рукопожатие и отдаёт настоящие определения всех
 * инструментов Ведара — снимок tools.json, снятый с кода
 * (scripts/glama-tools-snapshot.ts). Данных Камчатки в нём нет, поэтому вызов
 * любого инструмента честно отвечает ошибкой инструмента (isError) и называет
 * живой сервер с данными. Запросов наружу сервер не делает вовсе: ни прокси,
 * ни подмены ответа.
 *
 * Запуск из корня репозитория: node integrations/glama/server/server.mjs
 * Самопроверка снимка (шаг сборки): node integrations/glama/server/server.mjs --self-check
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = JSON.parse(readFileSync(join(HERE, 'tools.json'), 'utf8'));

const TOOLS = SNAPSHOT.tools;
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const VERSIONS = SNAPSHOT.protocolVersions;
const LIVE = SNAPSHOT.liveEndpoint;

export const INSTRUCTIONS =
  `This is a build of the Vedar (Kamchatka) MCP server for inspection: it lists the real tool definitions, ` +
  `but it has no Kamchatka database, so every tool call returns an error saying so. ` +
  `The live server with data is ${LIVE} (Streamable HTTP, no key). ` +
  `Сборка для проверки: определения инструментов настоящие, данных Камчатки в ней нет; ` +
  `живой сервер с данными — ${LIVE}.`;

export function noDataText(name) {
  return (
    `No data: this build of the Vedar MCP server has no Kamchatka database, so "${name}" cannot answer here. ` +
    `Nothing was looked up and nothing was sent. Call the same tool on the live server: ${LIVE} (Streamable HTTP, no key). ` +
    `Данных нет: в этой сборке нет базы Ведара, инструмент «${name}» здесь ответить не может. ` +
    `Ничего не найдено и никуда не отправлено. Тот же инструмент на живом сервере: ${LIVE}.`
  );
}

/** Версия для ответа на initialize: запрошенная, если знакома, иначе новейшая. */
function negotiate(requested) {
  if (typeof requested === 'string' && VERSIONS.includes(requested.trim())) return requested.trim();
  return VERSIONS[0];
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Ответ на одно сообщение JSON-RPC; null — ответа не положено (уведомление). */
export function handle(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return fail(msg && typeof msg === 'object' && 'id' in msg ? msg.id : null, -32600, 'Invalid Request');
  }
  const isNotification = !('id' in msg);
  if (isNotification) return null;
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: negotiate(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SNAPSHOT.serverInfo,
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!TOOL_NAMES.has(name)) return fail(id, -32602, `Unknown tool: ${name.slice(0, 80)}`);
      return ok(id, { content: [{ type: 'text', text: noDataText(name) }], isError: true });
    }
    default:
      return fail(id, -32601, `Method not found: ${method.slice(0, 80)}`);
  }
}

function selfCheck() {
  const problems = [];
  if (!Array.isArray(TOOLS) || TOOLS.length === 0) problems.push('no tools in snapshot');
  for (const t of TOOLS) {
    if (typeof t.name !== 'string' || typeof t.description !== 'string' || !t.inputSchema) {
      problems.push(`bad tool: ${JSON.stringify(t.name)}`);
    }
  }
  if (!Array.isArray(VERSIONS) || VERSIONS.length === 0) problems.push('no protocol versions');
  if (typeof LIVE !== 'string' || !LIVE.startsWith('https://')) problems.push('no live endpoint');
  if (problems.length) {
    process.stderr.write(`self-check failed: ${problems.join('; ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`self-check ok: ${TOOLS.length} tools, ${SNAPSHOT.serverInfo.name} ${SNAPSHOT.serverInfo.version}\n`);
}

function serve() {
  const rl = createInterface({ input: process.stdin });
  const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send(fail(null, -32700, 'Parse error'));
      return;
    }
    if (Array.isArray(msg)) {
      const replies = msg.map(handle).filter((r) => r !== null);
      if (replies.length) send(replies);
      return;
    }
    const reply = handle(msg);
    if (reply) send(reply);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--self-check')) selfCheck();
  else serve();
}

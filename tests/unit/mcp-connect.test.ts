/**
 * Сторож: «добавить Vedar» — одним касанием, и все касания ведут на один адрес.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * Разбор 18.09: агент выбирает инструмент внутри набора, который дал host;
 * каталоги лишь помогают попасть в набор. Два самых сильных рычага — человек
 * добавил сервер и строка системного промпта. Оба переводятся из теории в
 * один клик: ссылка, команда, JSON и готовая строка на /mcp, в llms.txt и в
 * манифесте.
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * Каждая ссылка, команда и JSON содержат канонический эндпоинт (deeplink'и —
 * после раскодирования); форматы ссылок — схемы клиентов; строка промпта
 * называет Vedar, Kamchatka и human-confirmed; страница, llms.txt и манифест
 * читают один модуль, а не держат свои адреса.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MCP_CONNECT_OPTIONS, MCP_ENDPOINT, MCP_JSON_CONFIG, MCP_SERVER_KEY,
  MCP_SYSTEM_PROMPT_LINE_EN, MCP_SYSTEM_PROMPT_LINE_RU,
} from '@/lib/mcp/connect';
import { CANONICAL_BASE_URL } from '@/lib/config';
import { GET as manifestGet } from '@/app/.well-known/mcp.json/route';
import { SERVER_INSTRUCTIONS } from '@/lib/mcp/server-instructions';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('варианты подключения — все на один адрес', () => {
  it('эндпоинт — канонический', () => {
    expect(MCP_ENDPOINT).toBe(`${CANONICAL_BASE_URL}/api/mcp`);
  });

  it('двадцать шесть вариантов: пять ссылок, пять команд, шесть чатов шагами, JSON и YAML конфигов', () => {
    expect(MCP_CONNECT_OPTIONS.map((o) => o.id).sort()).toEqual([
      'chatbox', 'chatgpt', 'cherry_studio', 'claude_ai', 'claude_code', 'cline', 'codebuddy', 'coze', 'cursor',
      'deepseek_harness', 'devin_desktop', 'gemini_app', 'gemini_cli', 'gemini_settings', 'goose', 'grok', 'json', 'kilo', 'kimi', 'mistral',
      'qwen_chat', 'qwen_code', 'trae', 'trae_cn', 'vscode', 'zed', 'zhipu_glm',
    ]);
    expect(MCP_CONNECT_OPTIONS.filter((o) => o.kind === 'command').map((o) => o.id).sort())
      .toEqual(['claude_code', 'codebuddy', 'devin_desktop', 'gemini_cli', 'qwen_code']);
    expect(MCP_CONNECT_OPTIONS.filter((o) => o.kind === 'link').map((o) => o.id).sort()).toEqual(['chatbox', 'cursor', 'trae', 'trae_cn', 'vscode']);
    expect(MCP_CONNECT_OPTIONS.filter((o) => o.kind === 'steps').map((o) => o.id).sort()).toEqual(['chatgpt', 'claude_ai', 'coze', 'gemini_app', 'grok', 'kimi', 'mistral']);
    expect(new Set(MCP_CONNECT_OPTIONS.map((o) => o.id)).size).toBe(MCP_CONNECT_OPTIONS.length);
  });

  // Сверка клиентов 16.10 (документация и исходники): у каждого своё написание
  // Streamable HTTP, чужое уводит в старый SSE — а у нас на GET-поток 405.
  it('Chatbox: chatbox://mcp/install, server — base64 имени и нашего адреса', () => {
    const cb = MCP_CONNECT_OPTIONS.find((o) => o.id === 'chatbox')!;
    const url = new URL(cb.value);
    expect(url.protocol).toBe('chatbox:');
    expect(url.host + url.pathname).toBe('mcp/install');
    expect(JSON.parse(Buffer.from(url.searchParams.get('server')!, 'base64').toString('utf-8'))).toEqual({ name: MCP_SERVER_KEY, url: MCP_ENDPOINT });
  });

  it('конфиги: Cline — streamableHttp, Cherry — streamableHttp, Kilo — mcp/remote, Zed — context_servers', () => {
    const json = (id: string) => JSON.parse(MCP_CONNECT_OPTIONS.find((o) => o.id === id)!.value);
    expect(json('cline').mcpServers[MCP_SERVER_KEY]).toMatchObject({ type: 'streamableHttp', url: MCP_ENDPOINT });
    expect(json('cherry_studio').mcpServers[MCP_SERVER_KEY]).toEqual({ type: 'streamableHttp', url: MCP_ENDPOINT });
    expect(json('kilo').mcp[MCP_SERVER_KEY]).toEqual({ type: 'remote', url: MCP_ENDPOINT, enabled: true });
    expect(json('zed').context_servers[MCP_SERVER_KEY]).toEqual({ url: MCP_ENDPOINT });
  });

  it('Goose: streamable_http и поле uri, не url', () => {
    const g = MCP_CONNECT_OPTIONS.find((o) => o.id === 'goose')!;
    expect(g.kind).toBe('yaml');
    expect(g.value).toContain('type: streamable_http');
    expect(g.value).toContain(`uri: ${MCP_ENDPOINT}`);
    expect(g.value).not.toMatch(/^\s*url:/m);
  });

  it('команды Gemini CLI, CodeBuddy и Devin — HTTP-транспорт и scope пользователя', () => {
    const v = (id: string) => MCP_CONNECT_OPTIONS.find((o) => o.id === id)!.value;
    expect(v('gemini_cli')).toBe(`gemini mcp add --transport http -s user ${MCP_SERVER_KEY} ${MCP_ENDPOINT}`);
    expect(v('codebuddy')).toBe(`codebuddy mcp add --scope user --transport http ${MCP_SERVER_KEY} ${MCP_ENDPOINT}`);
    expect(v('devin_desktop')).toBe(`devin mcp add -s user ${MCP_SERVER_KEY} ${MCP_ENDPOINT}`);
  });

  it('непроверенное названо: Devin, Trae и ChatGPT несут оговорку', () => {
    for (const id of ['devin_desktop', 'trae', 'trae_cn', 'chatgpt', 'gemini_app']) {
      const o = MCP_CONNECT_OPTIONS.find((x) => x.id === id)!;
      expect(o.note, id).toMatch(/не проверен|не полностью|не говорит/);
    }
  });

  // Аудит 15.10, CN-zh: схема из документации Trae (docs.trae.cn и docs.trae.ai,
  // снято 15.10) — `<схема>://trae.ai-ide/mcp-import?type=&name=&config=<base64>`.
  it.each([
    ['trae_cn', 'trae-cn:'],
    ['trae', 'trae:'],
  ])('Trae (%s): схема %s, host trae.ai-ide, путь /mcp-import, type=http, config раскодируется в наш адрес', (id, protocol) => {
    const trae = MCP_CONNECT_OPTIONS.find((o) => o.id === id)!;
    expect(trae.kind).toBe('link');
    const url = new URL(trae.value);
    expect(url.protocol).toBe(protocol);
    expect(url.host).toBe('trae.ai-ide');
    expect(url.pathname).toBe('/mcp-import');
    expect(url.searchParams.get('type')).toBe('http');
    expect(url.searchParams.get('name')).toBe(MCP_SERVER_KEY);
    const cfg = JSON.parse(Buffer.from(url.searchParams.get('config')!, 'base64').toString('utf-8'));
    expect(cfg).toEqual({ url: MCP_ENDPOINT });
  });

  it('Cursor: схема deeplink, имя и конфиг раскодируются в наш адрес', () => {
    const cursor = MCP_CONNECT_OPTIONS.find((o) => o.id === 'cursor')!;
    const url = new URL(cursor.value);
    expect(url.protocol).toBe('cursor:');
    expect(url.pathname).toBe('/mcp/install');
    expect(url.searchParams.get('name')).toBe(MCP_SERVER_KEY);
    const cfg = JSON.parse(Buffer.from(url.searchParams.get('config')!, 'base64').toString('utf-8'));
    expect(cfg).toEqual({ url: MCP_ENDPOINT });
  });

  it('VS Code: схема vscode:mcp/install с http-конфигом на наш адрес', () => {
    const vscode = MCP_CONNECT_OPTIONS.find((o) => o.id === 'vscode')!;
    expect(vscode.value.startsWith('vscode:mcp/install?')).toBe(true);
    const cfg = JSON.parse(decodeURIComponent(vscode.value.slice('vscode:mcp/install?'.length)));
    expect(cfg).toEqual({ name: MCP_SERVER_KEY, type: 'http', url: MCP_ENDPOINT });
  });

  it('Claude Code: команда добавления по HTTP-транспорту', () => {
    const cc = MCP_CONNECT_OPTIONS.find((o) => o.id === 'claude_code')!;
    expect(cc.value).toBe(`claude mcp add --transport http ${MCP_SERVER_KEY} ${MCP_ENDPOINT}`);
  });

  it('Qwen Code: та же команда с транспортом http (поле httpUrl в settings.json, не url — это SSE)', () => {
    const qc = MCP_CONNECT_OPTIONS.find((o) => o.id === 'qwen_code')!;
    expect(qc.value).toBe(`qwen mcp add --transport http ${MCP_SERVER_KEY} ${MCP_ENDPOINT}`);
    expect(qc.kind).toBe('command');
  });

  it('DeepSeek Harness: YAML для cordis.patch.yml с плагином dsh-mcp-client на наш адрес', () => {
    const dsh = MCP_CONNECT_OPTIONS.find((o) => o.id === 'deepseek_harness')!;
    expect(dsh.kind).toBe('yaml');
    expect(dsh.value).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(dsh.value).toContain('transport: streamable-http');
    expect(dsh.value).toContain(`url: ${MCP_ENDPOINT}`);
    expect(dsh.value).toContain(`serverName: ${MCP_SERVER_KEY}`);
    expect(dsh.value).toMatch(/cordis\.patch\.yml/);
  });

  it('JSON: общая форма mcpServers, streamable-http, наш адрес; парсится', () => {
    const json = MCP_CONNECT_OPTIONS.find((o) => o.id === 'json')!;
    expect(json.value).toBe(MCP_JSON_CONFIG);
    const parsed = JSON.parse(json.value);
    expect(parsed.mcpServers[MCP_SERVER_KEY]).toEqual({ type: 'streamable-http', url: MCP_ENDPOINT });
  });

  it('шаги для Claude.ai: Customize → Connectors, адрес и «без авторизации»', () => {
    const steps = MCP_CONNECT_OPTIONS.find((o) => o.id === 'claude_ai')!;
    expect(steps.value).toContain(MCP_ENDPOINT);
    expect(steps.value).toMatch(/без авторизации/);
    expect(steps.value).toMatch(/^Customize → Connectors/);
  });

  it('ни один вариант не содержит другого адреса', () => {
    for (const o of MCP_CONNECT_OPTIONS) {
      // Ссылки с конфигом в base64 (Cursor, Trae — config, Chatbox — server)
      // судятся по раскодированному конфигу.
      const params = o.kind === 'link' ? new URL(o.value).searchParams : null;
      const b64 = params ? (params.get('config') ?? params.get('server')) : null;
      const decoded = b64
        ? Buffer.from(b64, 'base64').toString('utf-8')
        : decodeURIComponent(o.value);
      expect(decoded, `${o.id}: адреса нет`).toContain(MCP_ENDPOINT);
      const hosts = decoded.match(/https?:\/\/[^/"\s)]+/g) ?? [];
      for (const h of hosts) expect(h, `${o.id}: чужой адрес`).toBe(CANONICAL_BASE_URL);
    }
  });
});

describe('строка системного промпта', () => {
  it('английская называет Vedar, Kamchatka и human-confirmed; русская — Vedar и Камчатку', () => {
    expect(MCP_SYSTEM_PROMPT_LINE_EN).toMatch(/\bVedar\b/);
    expect(MCP_SYSTEM_PROMPT_LINE_EN).toMatch(/\bKamchatka\b/);
    expect(MCP_SYSTEM_PROMPT_LINE_EN).toMatch(/\bhuman-confirmed\b/);
    expect(MCP_SYSTEM_PROMPT_LINE_EN).not.toMatch(/[А-Яа-я]/);
    expect(MCP_SYSTEM_PROMPT_LINE_RU).toMatch(/Vedar/);
    expect(MCP_SYSTEM_PROMPT_LINE_RU).toMatch(/Камчатк/);
    expect(MCP_SYSTEM_PROMPT_LINE_RU).toMatch(/подтверждает человек/);
  });

  it('об оплате обе говорят «не мгновенно» — не зависят от выключателя оплаты (29.10)', () => {
    // Строку хост вставляет один раз; что сейчас с оплатой, говорит
    // инструкция сервера (lib/mcp/server-instructions.ts) по выключателю.
    expect(MCP_SYSTEM_PROMPT_LINE_EN).toMatch(/nothing is booked or paid instantly/);
    expect(MCP_SYSTEM_PROMPT_LINE_RU).toMatch(/ничего не бронируется и не оплачивается мгновенно/);
    expect(MCP_SYSTEM_PROMPT_LINE_RU).not.toMatch(/оплаты через платформу нет|не принимает|напрямую/);
    expect(MCP_SYSTEM_PROMPT_LINE_EN).not.toMatch(/no payment|does not accept|directly/i);
  });
});

describe('первоисточники читают модуль, а не держат свои адреса', () => {
  it('манифест отдаёт connect, systemPromptHint и instructions рукопожатия', async () => {
    const res = await manifestGet();
    const body = await res.json() as { connect: Record<string, string>; systemPromptHint: string; instructions: string };
    expect(Object.keys(body.connect).sort()).toEqual(MCP_CONNECT_OPTIONS.map((o) => o.id).sort());
    expect(body.systemPromptHint).toBe(MCP_SYSTEM_PROMPT_LINE_EN);
    // Тот же текст, что сервер отдаёт в initialize: агент видит правила до
    // подключения, и второго источника у них нет.
    expect(body.instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it('/mcp и llms.txt импортируют модуль; deeplink-схемы в разметке не захардкожены', () => {
    for (const f of ['app/mcp/page.tsx', 'app/llms.txt/route.ts', 'app/.well-known/mcp.json/route.ts']) {
      const src = read(f);
      expect(src, f).toMatch(/from '@\/lib\/mcp\/connect'/);
      expect(src, `${f}: схема deeplink захардкожена`).not.toMatch(/cursor:\/\/|vscode:mcp/);
    }
    const page = read('app/mcp/page.tsx');
    expect(page).toMatch(/id="deepseek"/);
    expect(page).toMatch(/DeepSeek Harness за 4 шага/);
    expect(page).toMatch(/mcp__vedar__get_tours/);
    expect(page).toMatch(/Какие туры на Камчатку сейчас доступны/);
    expect(page).not.toMatch(/deepseek-reasoner/);
    expect(page).toMatch(/Подключить одним касанием/);
    expect(page).toMatch(/Строка для системного промпта/);
    expect(page).toMatch(/MCP_CONNECT_OPTIONS\.filter\(\(o\) => o\.kind === 'link'\)/);
    const llms = read('app/llms.txt/route.ts');
    expect(llms).toMatch(/System prompt line for hosts: \$\{MCP_SYSTEM_PROMPT_LINE_EN\}/);
  });

  it('ChatGPT — текущий путь через Plugins и legacy Apps → Create, с источником OpenAI', () => {
    const c = MCP_CONNECT_OPTIONS.find((o) => o.id === 'chatgpt')!;
    expect(c.value).toContain('Add custom MCP server');
    expect(c.value).toContain('Apps → Create');
    expect(c.note).toContain('help.openai.com/en/articles/12584461');
    expect(c.note).toMatch(/Business, Enterprise и Edu/);
  });

  it('Gemini Connected Apps — URL вручную, вызов через @, ограничения и источник Google', () => {
    const g = MCP_CONNECT_OPTIONS.find((o) => o.id === 'gemini_app')!;
    expect(g.value).toContain(MCP_ENDPOINT);
    expect(g.value).toContain('@');
    expect(g.note).toContain('support.google.com/gemini/answer/17209137');
    expect(g.note).toMatch(/США/);
  });
});

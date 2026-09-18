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

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('варианты подключения — все на один адрес', () => {
  it('эндпоинт — канонический', () => {
    expect(MCP_ENDPOINT).toBe(`${CANONICAL_BASE_URL}/api/mcp`);
  });

  it('пять вариантов: два deeplink, команда, шаги, JSON', () => {
    expect(MCP_CONNECT_OPTIONS.map((o) => o.id).sort()).toEqual(['claude_ai', 'claude_code', 'cursor', 'json', 'vscode']);
    expect(MCP_CONNECT_OPTIONS.filter((o) => o.kind === 'link').length).toBe(2);
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

  it('JSON: общая форма mcpServers, streamable-http, наш адрес; парсится', () => {
    const json = MCP_CONNECT_OPTIONS.find((o) => o.id === 'json')!;
    expect(json.value).toBe(MCP_JSON_CONFIG);
    const parsed = JSON.parse(json.value);
    expect(parsed.mcpServers[MCP_SERVER_KEY]).toEqual({ type: 'streamable-http', url: MCP_ENDPOINT });
  });

  it('шаги для Claude.ai называют адрес и «без авторизации»', () => {
    const steps = MCP_CONNECT_OPTIONS.find((o) => o.id === 'claude_ai')!;
    expect(steps.value).toContain(MCP_ENDPOINT);
    expect(steps.value).toMatch(/без авторизации/);
  });

  it('ни один вариант не содержит другого адреса', () => {
    for (const o of MCP_CONNECT_OPTIONS) {
      const decoded = o.id === 'cursor'
        ? Buffer.from(new URL(o.value).searchParams.get('config')!, 'base64').toString('utf-8')
        : decodeURIComponent(o.value);
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
});

describe('первоисточники читают модуль, а не держат свои адреса', () => {
  it('манифест отдаёт connect и systemPromptHint', async () => {
    const res = await manifestGet();
    const body = await res.json() as { connect: Record<string, string>; systemPromptHint: string };
    expect(Object.keys(body.connect).sort()).toEqual(MCP_CONNECT_OPTIONS.map((o) => o.id).sort());
    expect(body.systemPromptHint).toBe(MCP_SYSTEM_PROMPT_LINE_EN);
  });

  it('/mcp и llms.txt импортируют модуль; deeplink-схемы в разметке не захардкожены', () => {
    for (const f of ['app/mcp/page.tsx', 'app/llms.txt/route.ts', 'app/.well-known/mcp.json/route.ts']) {
      const src = read(f);
      expect(src, f).toMatch(/from '@\/lib\/mcp\/connect'/);
      expect(src, `${f}: схема deeplink захардкожена`).not.toMatch(/cursor:\/\/|vscode:mcp/);
    }
    const page = read('app/mcp/page.tsx');
    expect(page).toMatch(/Подключить одним касанием/);
    expect(page).toMatch(/Строка для системного промпта/);
    expect(page).toMatch(/MCP_CONNECT_OPTIONS\.filter\(\(o\) => o\.kind === 'link'\)/);
    const llms = read('app/llms.txt/route.ts');
    expect(llms).toMatch(/System prompt line for hosts: \$\{MCP_SYSTEM_PROMPT_LINE_EN\}/);
  });
});

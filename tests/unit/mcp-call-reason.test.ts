/**
 * Сторож: у ошибки MCP есть причина, у вызова — имя аргумента, и ПД туда не
 * попадает (решение владельца 02.10, миграция 1143). Плюс ответ на
 * несуществующий инструмент — списком живых имён, и перепись mcp-census
 * только читает.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { primaryArg, safeArgValue, classifyExecutionError, HIDDEN_VALUE } from '@/lib/mcp/call-reason';
import { nearestToolName, unknownToolResponse } from '@/lib/mcp/unknown-tool';
import { McpUserError } from '@/lib/mcp/jsonrpc';
import { PUBLIC_MCP_TOOL_NAMES, WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const ROUTE = read('app/api/mcp/route.ts');

describe('главный аргумент: имя всегда, значение — только у читающих и без ПД', () => {
  it('у читающего инструмента значение пишется, обрезается до 40', () => {
    expect(primaryArg({ name: 'Долина гейзеров' }, false)).toEqual({ key: 'name', value: 'Долина гейзеров' });
    expect(primaryArg({ place: 'x'.repeat(80) }, false).value).toHaveLength(40);
    expect(primaryArg({ limit: 5, activity_type: 'fishing' }, false)).toEqual({ key: 'activity_type', value: 'fishing' });
    expect(primaryArg({}, false)).toEqual({ key: null, value: null });
  });

  it('у пишущего инструмента значение не пишется никогда', () => {
    expect(primaryArg({ name: 'Иван Петров', phone: '+79001234567', consent: true }, true)).toEqual({ key: 'name', value: null });
    expect(primaryArg({ tour: 'Сплав', date: '2026-10-10' }, true).value).toBeNull();
  });

  it('значение, похожее на телефон или почту, скрывается и у читающих', () => {
    expect(safeArgValue('+79001234567')).toBe(HIDDEN_VALUE);
    expect(safeArgValue('8 (914) 782-22-22')).toBe(HIDDEN_VALUE);
    expect(safeArgValue('ivan@example.com')).toBe(HIDDEN_VALUE);
    expect(safeArgValue('Вулкан 3456 м')).toBe('Вулкан 3456 м');
    expect(safeArgValue('  a\u0000b  ')).toBe('a b');
    expect(safeArgValue('')).toBeNull();
  });

  it('код исполнения: SQLSTATE, сеть, таймаут, иначе класс ошибки', () => {
    expect(classifyExecutionError(Object.assign(new Error('x'), { code: '42P08' }))).toBe('pg:42P08');
    expect(classifyExecutionError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('net:ECONNREFUSED');
    expect(classifyExecutionError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout');
    expect(classifyExecutionError(new TypeError('x'))).toBe('exc:TypeError');
    expect(classifyExecutionError('строка')).toBe('exc:unknown');
  });

  it('каждый отказ по входу в роуте несёт код, а не только текст', () => {
    const throws = ROUTE.split('\n').filter(l => l.includes('new McpUserError('));
    expect(throws.length).toBeGreaterThanOrEqual(12);
    // Многострочный throw (refuseSilentLead) проверяется отдельно ниже.
    const oneLine = throws.filter(l => l.trimEnd().endsWith(');'));
    for (const l of oneLine) expect(l, l.trim()).toMatch(/, (?:'[a-z_]+'|`[a-z_]+:?\$\{[^`]*\}`|`[a-z_]+_\$\{reason\}`|refusal\.code)\);$/);
    // refusal.code — только из argsRefusal (lib/mcp/tool-arguments): код есть
    // у каждого её исхода, это держит tests/unit/mcp-tool-arguments.test.ts.
    expect(ROUTE).toContain('const refusal = argsRefusal(read, validation.error);');
    expect(ROUTE).toContain("'silent_lead',\n    );");
    expect(new McpUserError('x').code).toBe('refused');
    expect(new McpUserError('x', 'no_consent').code).toBe('no_consent');
  });

  it('роут пишет причину и аргумент в каждый исход журнала, значение — не из toolArgs напрямую', () => {
    expect(ROUTE).toContain('const arg = primaryArg(toolArgs, isWrite)');
    expect(ROUTE).toContain("errorCode: userFacing ? toolErr.code : classifyExecutionError(toolErr)");
    expect(ROUTE).toContain("errorCode: 'tool_failed'");
    const calls = ROUTE.match(/logMcpToolCall\(\{[^}]+\}\)/gs) ?? [];
    for (const c of calls) {
      expect(c, c).toMatch(/argKey: arg\.key/);
      expect(c, c).not.toMatch(/argValue: toolArgs/);
    }
    // На MCP исполнитель Кузьмича отдаёт причину роуту исключением, а не глушит её текстом.
    expect(read('lib/kuzmich/core.ts')).toContain("if (opts.surface === 'mcp') throw err;");
  });
});

describe('несуществующий инструмент — списком живых имён', () => {
  it('ближайшее имя: подстрока, опечатка; мусор — без подсказки', () => {
    expect(nearestToolName('get_tour')).toBe('get_tours');
    expect(nearestToolName('get_tourz')).toBe('get_tours');
    expect(nearestToolName('weather')).toBe('get_weather');
    expect(nearestToolName('book_tour')).toBeNull();
    expect(nearestToolName('')).toBeNull();
  });

  it('ответ несёт все живые имена и в тексте, и в data', () => {
    const r = unknownToolResponse('get_tour');
    expect(r.data.available).toEqual([...PUBLIC_MCP_TOOL_NAMES].sort());
    expect(r.data.suggestion).toBe('get_tours');
    for (const n of PUBLIC_MCP_TOOL_NAMES) expect(r.message).toContain(n);
    expect(r.message).toContain('Did you mean: get_tours?');
    // Запрошенное имя обрезается: мусор из ответа не растёт.
    expect(unknownToolResponse('x'.repeat(500)).message.length).toBeLessThan(1200);
    expect(ROUTE).toContain('jsonrpcError(id, -32602, unknown.message, unknown.data)');
  });
});

describe('перепись mcp-census только читает', () => {
  const census = read('app/api/cron/mcp-census/route.ts');
  it('ни INSERT, ни UPDATE, ни DELETE; секрет обязателен; разделение — тем же реестром', () => {
    expect(census).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER)\b/);
    expect(census).toContain('timingSafeCompare(secret');
    expect(census).toContain("from '@/lib/mcp/probe-clients'");
    expect(census).toContain('error_code_since');
    expect(census).toContain('errors_without_code');
    // Пишущие инструменты берутся из реестра, не перечисляются руками.
    expect(census).toContain('WRITE_TOOL_NAMES');
    expect(WRITE_TOOL_NAMES.size).toBeGreaterThanOrEqual(2);
  });
});

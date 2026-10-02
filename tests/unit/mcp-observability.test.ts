/**
 * Рост-6: наблюдаемость MCP-канала (оценка 14.08 — vedar-mcp как четвёртый
 * измеряемый канал: свежесть, атрибуция, наблюдаемость вызовов).
 *
 * Сторож держит три опасности:
 *  1. ПД в журнале: аргументы create_lead/create_booking_request несут имя и
 *     телефон туриста — журнал пишет только ФАКТ вызова (152-ФЗ).
 *  2. Слепые зоны: залогирован только успех — падения и rate-limit невидимы.
 *  3. Мусорная кардинальность: произвольное имя инструмента от внешнего
 *     клиента прямо в БД.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeToolName, safeRequestedName } from '@/lib/mcp/call-log';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const ROUTE = read('app/api/mcp/route.ts');
const LOG = read('lib/mcp/call-log.ts');
const SLICE = read('app/api/admin/analytics/mcp/route.ts');
const MIGRATION = read('migrations/861_mcp_tool_calls.sql');

describe('журнал вызовов без ПД', () => {
  it('в INSERT журнала нет аргументов инструмента', () => {
    // Колонки фиксированы: tool, ok, error_kind, duration_ms, caller_hash.
    // requested_tool (1141) — имя несуществующего инструмента, только при unknown_tool.
    // is_self (1142) — метка владельца из адреса коннектора; свои вызовы отделяются, не прячутся.
    // error_code, arg_key, arg_value (1143) — причина и ИМЯ аргумента; значение только у читающих (lib/mcp/call-reason).
    expect(LOG).toMatch(/INSERT INTO mcp_tool_calls \(tool, ok, error_kind, duration_ms, caller_hash, requested_tool, is_self, error_code, arg_key, arg_value\)/);
    expect(LOG).not.toMatch(/args|arguments|params/i);
  });

  it('роут не передаёт toolArgs в журнал', () => {
    // Каждый вызов logMcpToolCall собирается без toolArgs.
    const calls = ROUTE.match(/logMcpToolCall\(\{[^}]+\}\)/gs) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) expect(c).not.toMatch(/toolArgs/);
  });

  it('caller_hash — суточный visitorHash с солью, не сырой IP', () => {
    // Проверяется СМЫСЛ, а не написание вызова. 18.08 вычисление hash вынесено
    // в общую mcpCallerHash: его должны считать одинаково журнал вызовов и
    // запись рукопожатия, иначе таблицы не соединятся. Прежняя редакция
    // сторожа требовала дословного `visitorHash(entry.ip, ...)` и покраснела
    // на выделении общей функции — то есть держала форму, а не свойство.
    expect(LOG).toMatch(/visitorHash\(ip, userAgent, currentDay\(\)/);
    expect(LOG).toMatch(/process\.env\.CRON_SECRET/);
    // В INSERT уходит hash, а не сырые ip/userAgent.
    const insert = LOG.slice(LOG.indexOf('INSERT INTO mcp_tool_calls'));
    expect(insert).not.toMatch(/entry\.ip|entry\.userAgent/);
    expect(MIGRATION).toMatch(/caller_hash/);
  });
});

describe('все исходы вызова видны', () => {
  it('логируются успех, падение и rate-limit', () => {
    expect(ROUTE).toMatch(/ok: true, durationMs/);
    expect(ROUTE).toMatch(/errorKind: 'rate_limited'/);
    expect(ROUTE).toMatch(/errorKind: 'unknown_tool'/);
    expect(ROUTE).toMatch(/errorKind: userFacing \? 'refused' : 'execution'/);
    expect(ROUTE).toMatch(/errorKind: 'execution'/);
  });

  it('журнал fire-and-forget — сбой БД не ломает ответ агенту', () => {
    expect(LOG).toMatch(/void pool/);
    // Не ломает ответ — но называется в логе (29.09): молчащий журнал сторож
    // молчания MCP читал бы как «никто не звал».
    expect((LOG.match(/\.catch\(\(err: unknown\) => logMcpFailure\(/g) ?? []).length).toBe(2);
    expect(LOG).not.toMatch(/\.catch\(\(\) =>/);
  });
});

describe('имя инструмента — только из реестра', () => {
  it('safeToolName пропускает реестровые и клеймит прочие', () => {
    expect(safeToolName('create_lead')).toBe('create_lead');
    // Запрошенное имя — отдельно и только если похоже на идентификатор.
    expect(safeRequestedName('getTours')).toBe('getTours');
    expect(safeRequestedName('get-weather.v2')).toBe('get-weather.v2');
    expect(safeRequestedName('<script>alert(1)</script>')).toBe('не-идентификатор');
    expect(safeRequestedName('x'.repeat(41))).toBe('не-идентификатор');
    expect(ROUTE).toMatch(/errorKind: 'unknown_tool', errorCode: 'unknown_tool', requestedTool: toolName/);
    expect(read('migrations/1141_mcp_tool_calls_requested_tool.sql')).toMatch(/ADD COLUMN IF NOT EXISTS requested_tool VARCHAR\(40\)/);
    expect(safeToolName('nonexistent_evil_tool_'.repeat(10))).toBe('unknown');
    expect(safeToolName('')).toBe('unknown');
  });
});

describe('срез /api/admin/analytics/mcp', () => {
  it('только для админа, честная сноска о человеко-днях', () => {
    expect(SLICE).toMatch(/requireAdmin\(request\)/);
    expect(SLICE).toMatch(/window_note/);
    expect(SLICE).toMatch(/человеко-дни/);
  });

  it('ошибки в срезе видны: разрез по инструментам и по причинам', () => {
    expect(SLICE).toMatch(/errors_30d/);
    expect(SLICE).toMatch(/errors_by_kind_30d/);
  });

  it('миграция 861 идемпотентна', () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS mcp_tool_calls/);
    expect(MIGRATION).toMatch(/CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_tool/);
  });
});

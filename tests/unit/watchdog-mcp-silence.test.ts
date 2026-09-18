/**
 * Сторож: Watchdog спрашивает журнал MCP сам, и говорит один раз.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * 18.09 сервер опубликован в реестре, Smithery и Glama. Единственная честная
 * проверка «нас нашли?» — чужие вызовы в `mcp_tool_calls`; владелец записал:
 * «через 1–2 недели смотреть журнал: ноль = узкое место не в API». Смотреть
 * глазами — значит забыть. Проверка в Watchdog отвечает сама, но только в
 * окне, где ответ что-то значит: до 7 суток тишина ещё ничего не говорит,
 * после 14 — вопрос отвечен, и повтор дважды в день (дебаунс 12 ч) не несёт
 * факта.
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * Чистая функция с тремя исходами по окну и по счётчику; проверка включена в
 * прогон (иначе «сторож есть» было бы объявлением без производителя, §10.09);
 * дата публикации — настоящая, не в будущем; текст тревоги не меняется день
 * ото дня, иначе ключ дебаунса меняется вместе с ним.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mcpSilenceIssue } from '@/lib/agents/watchdog';
import {
  MCP_CATALOG_LAUNCH_DATE, MCP_SILENCE_ALERT_FROM_DAYS, MCP_SILENCE_ALERT_UNTIL_DAYS,
} from '@/lib/mcp/catalogs';

const ROOT = process.cwd();
const WD = readFileSync(join(ROOT, 'lib/agents/watchdog.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

describe('mcpSilenceIssue — окно и счётчик', () => {
  const silent = { callsSinceLaunch: 0, distinctCallers: 0 };

  it('раньше окна — молчит: тишина ещё ничего не значит', () => {
    expect(mcpSilenceIssue({ ...silent, daysSinceLaunch: 0 })).toBeNull();
    expect(mcpSilenceIssue({ ...silent, daysSinceLaunch: MCP_SILENCE_ALERT_FROM_DAYS - 0.01 })).toBeNull();
  });

  it('в окне и ноль вызовов — ВНИМАНИЕ, не КРИТ', () => {
    const a = mcpSilenceIssue({ ...silent, daysSinceLaunch: MCP_SILENCE_ALERT_FROM_DAYS });
    expect(a).not.toBeNull();
    expect(a!.type).toBe('mcp_silent');
    expect(a!.critical).toBe(false);
    expect(a!.details).toContain(MCP_CATALOG_LAUNCH_DATE);
    expect(a!.details).toContain('/hub/admin/mcp');
  });

  it('текст тревоги одинаков в любой день окна — ключ дебаунса не дрейфует', () => {
    const d7 = mcpSilenceIssue({ ...silent, daysSinceLaunch: 7 })!.details;
    const d13 = mcpSilenceIssue({ ...silent, daysSinceLaunch: 13.9 })!.details;
    expect(d7).toBe(d13);
  });

  it('после окна — молчит: вопрос отвечен, долбёжка не факт', () => {
    expect(mcpSilenceIssue({ ...silent, daysSinceLaunch: MCP_SILENCE_ALERT_UNTIL_DAYS })).toBeNull();
    expect(mcpSilenceIssue({ ...silent, daysSinceLaunch: 40 })).toBeNull();
  });

  it('хоть один вызов — молчит; чей он, решает панель, не сторож', () => {
    expect(mcpSilenceIssue({ callsSinceLaunch: 1, distinctCallers: 1, daysSinceLaunch: 10 })).toBeNull();
  });

  it('окно осмысленно: от меньше до, обе границы положительные', () => {
    expect(MCP_SILENCE_ALERT_FROM_DAYS).toBeGreaterThan(0);
    expect(MCP_SILENCE_ALERT_UNTIL_DAYS).toBeGreaterThan(MCP_SILENCE_ALERT_FROM_DAYS);
  });
});

describe('дата публикации — факт, не задел', () => {
  it('ISO-дата и не в будущем', () => {
    expect(MCP_CATALOG_LAUNCH_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${MCP_CATALOG_LAUNCH_DATE}T00:00:00Z`).getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('проверка включена в прогон и честна в отказе', () => {
  it('checkMcpSilent объявлена, читает mcp_tool_calls от даты публикации и стоит в CHECKS', () => {
    expect(WD).toMatch(/async function checkMcpSilent\(/);
    expect(WD).toMatch(/FROM mcp_tool_calls\s*\n\s*WHERE created_at >= \$1::date/);
    expect(WD).toMatch(/\[MCP_CATALOG_LAUNCH_DATE\]/);
    const block = /const CHECKS\b[^[]*?=\s*\[([\s\S]*?)\n\s*\];/.exec(WD);
    expect(block, 'список CHECKS не найден').not.toBeNull();
    expect(block![1]).toMatch(/\bcheckMcpSilent\b/);
  });

  it('тип тревоги объявлен в союзе WatchdogAlert', () => {
    expect(WD).toMatch(/'mcp_silent'/);
  });
});

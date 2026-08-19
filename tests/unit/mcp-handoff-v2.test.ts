/**
 * MCP handoff v2 (задача #60): больше инструментов со ссылкой «Продолжить
 * в Ведаре» + атрибуция всех серверных действий исполнения.
 *
 * Сторож держит два правила v2:
 *  1. Сущность для ссылки резолвится ТЕМИ ЖЕ функциями, какими её находит
 *     сам инструмент (resolveTourByQuery, resolvePlaceForLink) — свой ILIKE
 *     в handoff-targets запрещён: второй, чуть другой поиск ведёт ссылку
 *     не на то, о чём инструмент ответил.
 *  2. Каждое серверное действие исполнения после перехода фиксируется
 *     attachMcpAttribution с честным именем; идентификатор — только из
 *     проверенной cookie, никогда из body.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const TARGETS = read('lib/mcp/handoff-targets.ts');
const MCP_ROUTE = read('app/api/mcp/route.ts');
const CORE = read('lib/kuzmich/core.ts');
const GUARDIAN = read('lib/kuzmich/guardian-context.ts');
const HANDOFF = read('lib/mcp/handoff.ts');
const TRIPS = read('app/api/trips/route.ts');
const SHARE = read('app/api/trips/[id]/share/route.ts');
const GPX = read('app/api/trips/share/[token]/gpx/route.ts');

describe('цели v2: резолв — той же функцией, что у инструмента', () => {
  it('туры — через resolveTourByQuery, своего ILIKE в targets нет', () => {
    expect(TARGETS).toMatch(/resolveTourByQuery/);
    expect(TARGETS).toMatch(/\/catalog\/tours\/\$\{tour\.id\}/);
    expect(TARGETS).not.toMatch(/ILIKE/);
    expect(TARGETS).not.toMatch(/pool\.query/);
  });

  it('места — через resolvePlaceForLink guardian-context', () => {
    expect(TARGETS).toMatch(/resolvePlaceForLink/);
    expect(TARGETS).toMatch(/\/places\/\$\{placeId\}/);
  });

  it('resolvePlaceForLink: только видимые и не слитые места', () => {
    const fn = GUARDIAN.slice(
      GUARDIAN.indexOf('export async function resolvePlaceForLink'),
      GUARDIAN.indexOf('export async function getGuardianContext'),
    );
    expect(fn).toMatch(/merged_into_id IS NULL/);
    expect(fn).toMatch(/is_visible = true/);
  });

  it('get_tour_details резолвит тур той же resolveTourByQuery (одна мера)', () => {
    const fn = CORE.slice(
      CORE.indexOf('export async function getTourDetails'),
      CORE.indexOf('export async function getTourDetails') + 1500,
    );
    expect(fn).toMatch(/resolveTourByQuery\(q\)/);
    expect(fn).not.toMatch(/ILIKE/);
  });

  it('MCP-роут берёт цели из lib, своего switch по инструментам не держит', () => {
    expect(MCP_ROUTE).toMatch(/from '@\/lib\/mcp\/handoff-targets'/);
    expect(MCP_ROUTE).not.toMatch(/case 'make_trip_plan'/);
    // Сбой резолва не ломает ответ агенту.
    expect(MCP_ROUTE).toMatch(/handoffTargetForTool\(toolName, toolArgs\)\.catch\(\(\) => null\)/);
  });

  it('покрыты инструменты v2: туры, место, планер, безопасность', () => {
    for (const tool of ['make_trip_plan', 'safety_status', 'get_tour_details', 'get_tour_availability', 'get_guardian_context']) {
      expect(TARGETS).toContain(`'${tool}'`);
    }
  });
});

describe('атрибуция действий исполнения', () => {
  it('союз действий полный и честный (plan_shared, не telegram_sent)', () => {
    expect(HANDOFF).toMatch(/'plan_saved' \| 'plan_shared' \| 'offline_bundle_downloaded' \| 'lead_created'/);
    expect(HANDOFF).not.toMatch(/'telegram_sent'/);
  });

  it.each([
    ['plan_saved', TRIPS],
    ['plan_shared', SHARE],
    ['offline_bundle_downloaded', GPX],
  ])('%s фиксируется из проверенной cookie, не из body', (action, src) => {
    expect(src).toMatch(new RegExp(`attachMcpAttribution\\(`));
    expect(src).toContain(`'${action}'`);
    expect(src).toMatch(/MCP_ATTRIBUTION\.cookieName/);
    expect(src).not.toMatch(/body[^;]*handoff/i);
  });
});

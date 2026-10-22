/**
 * Род агента A2A — правило без базы. Вынесено из lib/a2a/journal (аудит
 * 15.10, CN-quick): его читают и админ-срез, и перепись /api/cron/a2a-census,
 * а перепись не должна тянуть за правилом модуль с INSERT — иначе реестр
 * возможностей (cron-capability-registry) честно припишет ей db_write.
 * journal реэкспортирует отсюда же: правило одно.
 */
import { PROBE_NAME_PATTERN } from '@/lib/mcp/probe-clients';

/** Кто это: внешний агент, проверка реестра A2A, иная проверка (curl, пробы) или свой клиент. */
export type A2aAgentKind = 'external' | 'registry' | 'probe' | 'self';

/** Образец реестра A2A — общий для JS и PostgreSQL (`~*`), как PROBE_NAME_PATTERN. */
export const A2A_REGISTRY_PATTERN = '^A2A-Registry-';
const REGISTRY_RE = new RegExp(A2A_REGISTRY_PATTERN, 'i');
const PROBE_RE = new RegExp(PROBE_NAME_PATTERN, 'i');

/** Параметры предиката a2aExternalSql — всегда в этом порядке: образец реестра, образец проб. */
export const A2A_EXTERNAL_PARAMS: [string, string] = [A2A_REGISTRY_PATTERN, PROBE_NAME_PATTERN];

/**
 * То же правило, что a2aAgentKind(...) === 'external', — для счёта в SQL
 * (сводка суток на обзоре админки): число внешних агентов нельзя сложить из
 * групп по имени, если считать разных вызывающих. Совпадение с JS держит
 * tests/integration/admin-day-counts.pg.test.ts.
 */
export function a2aExternalSql(t: string, registryParam: string, probeParam: string): string {
  return `(${t}.is_self = FALSE AND ${t}.agent !~* ${registryParam}::text AND ${t}.agent !~* ${probeParam}::text AND COALESCE(${t}.ua_family, '') <> 'curl')`;
}

/**
 * Кто это — по самоназванию и метке, не по адресу. Реестр A2A раз в сутки
 * шлёт настоящий message/send (`A2A-Registry-TaskProbe/1.0`, при регистрации
 * `A2A-Registry-Smoke/1.0`) — это не турист и не чужой агент; прочие пробы —
 * по образцу ремесла из lib/mcp/probe-clients и по curl.
 */
export function a2aAgentKind(agent: string, family: string, isSelf: boolean): A2aAgentKind {
  if (isSelf) return 'self';
  if (REGISTRY_RE.test(agent)) return 'registry';
  if (PROBE_RE.test(agent) || family === 'curl') return 'probe';
  return 'external';
}

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

const REGISTRY_RE = /^A2A-Registry-/i;
const PROBE_RE = new RegExp(PROBE_NAME_PATTERN, 'i');

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

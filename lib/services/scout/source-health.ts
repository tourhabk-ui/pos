/**
 * Здоровье источников разведки Scout Digest.
 *
 * Проблема (живой случай 24.07): дайджест выдал «Туриндустрия — нет сигналов»,
 * «Камчатка — нет сигналов», а система НЕ могла отличить «сегодня реально тихо»
 * от «фид умер / не достаётся». RSS опрашивались через Promise.allSettled,
 * упавший источник молча давал ноль, в метаданные писался просто список всех
 * настроенных источников — не кто реально отдал материал. Тот же чёрный ящик,
 * что у safety-ingest и у прочёса эволюции.
 *
 * Здесь — детерминированный учёт: по каждому источнику статус за прогон, и
 * `evaluateDeadSources` (переиспользуем из safety) находит молчащие фиды.
 * Персистентность — в agent_memory (без миграции): карта source_key → состояние.
 *
 * Философия репо (CLAUDE.md §8): детерминированный guard, не «правила в промпте».
 */
import {
  evaluateDeadSources,
  dueForAlert,
  type SourceExpectation,
  type SourceHealthRow,
  type SourceHealthEntry,
  type DeadSource,
  type SourceStatus,
} from '@/lib/services/safety/source-health';

export { evaluateDeadSources, dueForAlert };
export type { DeadSource, SourceHealthEntry, SourceStatus };

/**
 * Пороги тишины по источникам разведки. Scout бежит раз в сутки, поэтому порог
 * «фид мёртв, а не просто тихо» — несколько дней. Считаем по СЫРОЙ выдаче фида
 * (вернул ли items вообще), а не по свежим-после-дедупа: живой фид без новостей —
 * это 'ok', мёртвый фид — 0 сырых.
 */
export const SCOUT_SOURCE_EXPECTATIONS: readonly SourceExpectation[] = [
  { key: 'simonwillison', label: 'Simon Willison',   maxSilenceHours: 168 },
  { key: 'huggingface',   label: 'Hugging Face',      maxSilenceHours: 120 },
  { key: 'marktechpost',  label: 'MarkTechPost',      maxSilenceHours: 120 },
  { key: 'hackernews',    label: 'Hacker News',       maxSilenceHours: 96 },
  { key: 'habr_ai',       label: 'Habr AI',           maxSilenceHours: 120 },
  { key: 'rata',          label: 'RATA',              maxSilenceHours: 168 },
  { key: 'tourprom',      label: 'Tourprom',          maxSilenceHours: 168 },
  { key: 'kamgov',        label: 'Kamgov',            maxSilenceHours: 168 },
  { key: 'mchs_rss',      label: 'МЧС Камчатка (RSS)', maxSilenceHours: 168 },
] as const;

export interface ScoutSourceState {
  label: string | null;
  last_status: SourceStatus | null;
  last_run_at: string | null;
  last_nonempty_at: string | null;
  first_seen_at: string | null;
  last_alerted_at: string | null;
  raw_items: number | null;
}
export type ScoutHealthMap = Record<string, ScoutSourceState>;

/** Классифицирует исход загрузки фида (чистая). */
export function classifyFetch(rawItems: number, errored: boolean): SourceStatus {
  if (errored) return 'error';
  return rawItems > 0 ? 'ok' : 'empty';
}

/**
 * Обновляет карту здоровья результатами прогона (чистая). last_nonempty_at
 * двигаем только при 'ok'; first_seen_at ставим один раз (для периода
 * привыкания в evaluateDeadSources); last_alerted_at сохраняем.
 */
export function applyRun(prev: ScoutHealthMap, entries: SourceHealthEntry[], nowIso: string): ScoutHealthMap {
  const next: ScoutHealthMap = { ...prev };
  for (const e of entries) {
    const p = prev[e.key];
    next[e.key] = {
      label: e.label,
      last_status: e.status,
      last_run_at: nowIso,
      raw_items: e.rawItems,
      last_nonempty_at: e.status === 'ok' ? nowIso : (p?.last_nonempty_at ?? null),
      first_seen_at: p?.first_seen_at ?? nowIso,
      last_alerted_at: p?.last_alerted_at ?? null,
    };
  }
  return next;
}

/** Карта → строки для переиспользуемого evaluateDeadSources (чистая). */
export function mapToRows(map: ScoutHealthMap): SourceHealthRow[] {
  return Object.entries(map).map(([key, s]) => ({
    source_key: key,
    label: s.label,
    last_status: s.last_status,
    last_run_at: s.last_run_at,
    last_nonempty_at: s.last_nonempty_at,
    last_alerted_at: s.last_alerted_at,
    first_seen_at: s.first_seen_at,
    raw_items: s.raw_items,
    inserted: null,
  }));
}

/** Фиксирует факт алерта в карте (дебаунс). Чистая. */
export function markAlertedInMap(map: ScoutHealthMap, keys: string[], nowIso: string): ScoutHealthMap {
  const next = { ...map };
  for (const k of keys) {
    if (next[k]) next[k] = { ...next[k], last_alerted_at: nowIso };
  }
  return next;
}

/** Человекочитаемый алерт для Telegram (формулировка разведки, не safety). */
export function formatScoutDeadSources(dead: DeadSource[]): string {
  const lines = dead.map((d) => {
    if (d.reason === 'not_configured') return `• ${d.label}: не настроен`;
    if (d.reason === 'never') return `• ${d.label}: ни разу не дал данных (фид сломан?)`;
    return `• ${d.label}: молчит ${d.silentHours} ч`;
  });
  return `Разведка Scout: источники молчат\n${lines.join('\n')}\n\n` +
    `Раздел дайджеста может пустовать не потому что тихо, а потому что фид мёртв. Проверь источник.`;
}

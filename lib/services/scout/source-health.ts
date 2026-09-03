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
 *
 * Список обязан покрывать ВСЕ ключи RSS_SOURCES: `evaluateDeadSources` идёт по
 * ожиданиям, и источник без строки здесь не сторожится вообще. Так три фида
 * (АТОР, Skift, Product Hunt) были добавлены в разведку, но не сюда — и могли
 * молчать бесконечно, а `dead_sources` физически не мог их назвать. Сходимость
 * держит инвариант-тест `scout-source-coverage`.
 */
export const SCOUT_SOURCE_EXPECTATIONS: readonly SourceExpectation[] = [
  { key: 'simonwillison', label: 'Simon Willison',   maxSilenceHours: 168 },
  { key: 'huggingface',   label: 'Hugging Face',      maxSilenceHours: 120 },
  { key: 'marktechpost',  label: 'MarkTechPost',      maxSilenceHours: 120 },
  { key: 'hackernews',    label: 'Hacker News',       maxSilenceHours: 96 },
  { key: 'habr_ai',       label: 'Habr AI',           maxSilenceHours: 120 },
  // Первоисточники лабораторий (03.09). OpenAI и Google AI публикуют по
  // нескольку раз в неделю; DeepMind — реже, потому окно шире. Читаются
  // через реле Cloudflare при гео-отказе прода (см. lib/agents/scout-relay).
  { key: 'openai',        label: 'OpenAI',            maxSilenceHours: 168 },
  { key: 'google_ai',     label: 'Google AI',         maxSilenceHours: 168 },
  { key: 'deepmind',      label: 'DeepMind',          maxSilenceHours: 336 },
  { key: 'skift',         label: 'Skift',             maxSilenceHours: 120 },
  { key: 'producthunt',   label: 'Product Hunt',      maxSilenceHours: 120 },
  // ator/kamgov/mchs_rss удалены 01.08 из RSS_SOURCES как мёртвые (404 /
  // fetch failed — сайты сняли ленты).
  // rata/tourprom вернулись 08.08 на новых адресах фидов (редизайн изданий);
  // пороги: Турпром публикует непрерывно, RATA — деловой ритм с паузами на
  // выходные, потому окно шире.
  { key: 'tourprom',      label: 'Турпром',           maxSilenceHours: 72 },
  { key: 'ratanews',      label: 'RATA News',         maxSilenceHours: 120 },
  // Safety-слой — не RSS: раздел «Камчатка» кормится из external_alerts
  // (собственный мониторинг: сейсмика КБГС, МЧС, дороги, пожары FIRMS).
  // Неделя без ЕДИНОГО события — это не «на Камчатке тихо», это сломанный
  // ingest: сейсмобюллетени выходят практически ежедневно. Сам ingest-крон
  // отдельно сторожит Watchdog; здесь — данные, а не процесс.
  { key: 'safety_layer',  label: 'Safety-слой',       maxSilenceHours: 168 },
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

/**
 * Строка отчёта по одному фиду. Агрегат «6 из 12» говорит, что половина
 * разведки молчит, и не говорит какая — а без имени источника разбирать нечего:
 * доступа к фидам из среды сборки нет, единственный свидетель — сам прогон.
 */
export interface ScoutSourceReport {
  key: string;
  label: string;
  category?: string;
  status: SourceStatus;
  /** Сколько сырых items отдал фид в этом прогоне. */
  items: number;
  /** Когда фид последний раз давал материал (ISO), null — если ни разу. */
  last_ok: string | null;
  /** Часов с последней непустой выдачи; null — если ни разу не давал. */
  silent_hours: number | null;
  /** Причина сбоя этого прогона — только при status 'error'. */
  error?: string;
  /**
   * Каким путём прочитан в этом прогоне: 'direct' — с прода, 'relay' — через
   * воркер Cloudflare вне РФ (lib/agents/scout-relay). Источник на реле
   * зависит от Cloudflare, и это отдельная поломка — отчёт её не прячет.
   */
  via?: 'direct' | 'relay';
}

/**
 * Собирает пофидовый отчёт за прогон (чистая). `map` — уже обновлённая карта
 * здоровья: для живых фидов last_nonempty_at == сейчас, то есть silent_hours 0.
 * Память недоступна → пустая карта, и отчёт всё равно честен по status/items.
 */
export function buildSourceReport(
  entries: Array<SourceHealthEntry & { category?: string; via?: 'direct' | 'relay' }>,
  map: ScoutHealthMap,
  now: number,
): ScoutSourceReport[] {
  return entries.map((e) => {
    const lastOk = map[e.key]?.last_nonempty_at ?? null;
    const ms = lastOk ? new Date(lastOk).getTime() : NaN;
    return {
      key: e.key,
      label: e.label,
      category: e.category,
      status: e.status,
      items: e.rawItems,
      last_ok: lastOk,
      silent_hours: Number.isNaN(ms) ? null : Math.round((now - ms) / 3_600_000),
      ...(e.error ? { error: e.error } : {}),
      ...(e.via ? { via: e.via } : {}),
    };
  });
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

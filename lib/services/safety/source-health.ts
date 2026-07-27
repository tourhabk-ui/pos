/**
 * Сторож здоровья источников safety-ingest.
 *
 * Проблема (живой случай 24.07): пост МЧС про пеплопад Шивелуча в MAX не долетел
 * в ленту — у MAX нет открытого API, публичная страница SPA, скрейп пуст. И это
 * падало МОЛЧА: cron отдавал «ок» с нулём постов. Сторож делает провал видимым:
 * на каждом прогоне пишем статус источника, а `evaluateDeadSources` детерминированно
 * находит «мёртвые» — не настроен (нет env-ключа) или давно ничего не даёт.
 *
 * Философия репо (CLAUDE.md §8): детерминированный guard, не «правила в промпте».
 * Молчание источника — операционный риск безопасности, поэтому его надо ловить.
 */
import type { Pool } from 'pg';

export type SourceStatus = 'ok' | 'empty' | 'not_configured' | 'not_fetched' | 'error';

export interface SourceExpectation {
  key: string;
  label: string;
  /** env-переменная, без которой источник не работает (напр. VK_SERVICE_TOKEN). */
  requiresEnv?: string;
  /** Сколько часов молчания (0 релевантных постов) допустимо, прежде чем это «мёртв». */
  maxSilenceHours: number;
}

/**
 * Ожидаемые источники и их пороги тишины. Пороги щедрые: МЧС/сейсмо публикуют
 * часто, поэтому длинная тишина = вероятная поломка канала, а не «просто тихо».
 */
export const SAFETY_SOURCE_EXPECTATIONS: readonly SourceExpectation[] = [
  { key: 'vk_mchs',  label: 'VK — МЧС Камчатки',    requiresEnv: 'VK_SERVICE_TOKEN', maxSilenceHours: 72 },
  { key: 'max_mchs', label: 'MAX — МЧС Камчатки',   maxSilenceHours: 72 },
  { key: 'mchs_rss', label: 'МЧС RSS (41.mchs)',    maxSilenceHours: 96 },
  { key: 'kbgsras',  label: 'КБГС РАН (сейсмо)',    maxSilenceHours: 48 },
  { key: 'eqkam',    label: 'EMSD/EQKam (сейсмо)',  maxSilenceHours: 48 },
  // 'firms' (NASA FIRMS, пожары) сюда НЕ входит осознанно: «нет термоточек»
  // неотличимо от «нет пожаров» (зимой месяцами пусто) — dead-алерт по
  // тишине был бы ложью. Health-запись пишется (видно в админке), env-ключ
  // FIRMS_MAP_KEY, ingest — lib/services/safety/wildfire-firms.ts.
] as const;

/** Как часто повторять алерт по одному источнику. */
export const ALERT_COOLDOWN_HOURS = 12;

export interface SourceHealthRow {
  source_key: string;
  label: string | null;
  last_status: SourceStatus | null;
  last_run_at: string | Date | null;
  last_nonempty_at: string | Date | null;
  last_alerted_at: string | Date | null;
  first_seen_at: string | Date | null;
  raw_items: number | null;
  inserted: number | null;
}

export interface DeadSource {
  key: string;
  label: string;
  reason: 'not_configured' | 'silent' | 'never';
  /** Часов тишины (для 'silent'/'never' — от last_nonempty_at; иначе null). */
  silentHours: number | null;
}

export interface SourceHealthEntry {
  key: string;
  label: string;
  status: SourceStatus;
  rawItems: number;
  inserted: number;
}

function toMs(v: string | Date | null | undefined): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}

/**
 * Чистая функция: по строкам здоровья и ожиданиям находит мёртвые источники.
 * `now` инжектируется для тестируемости.
 */
export function evaluateDeadSources(
  rows: SourceHealthRow[],
  expectations: readonly SourceExpectation[],
  now: number,
): DeadSource[] {
  const byKey = new Map(rows.map((r) => [r.source_key, r]));
  const dead: DeadSource[] = [];

  for (const exp of expectations) {
    const row = byKey.get(exp.key);

    // Нет строки вообще — источник ещё ни разу не наблюдался (свежая таблица /
    // первый прогон не случился). Не судим — период привыкания.
    if (!row) continue;

    // Явно не настроен (нет env-ключа) — детерминированно и сразу, без привыкания.
    if (row.last_status === 'not_configured') {
      dead.push({ key: exp.key, label: exp.label, reason: 'not_configured', silentHours: null });
      continue;
    }

    // Период привыкания: пока источник наблюдается меньше порога тишины, вывод
    // «never/silent» преждевременен (на свежей таблице всё выглядело бы мёртвым).
    const firstSeen = toMs(row.first_seen_at) ?? toMs(row.last_run_at);
    const observedHours = firstSeen === null ? Infinity : (now - firstSeen) / 3_600_000;

    const lastNonEmpty = toMs(row.last_nonempty_at);
    if (lastNonEmpty === null) {
      // Опрашивался, но НИ РАЗУ не дал сырых данных — «мёртв» только если наблюдаем
      // его уже дольше порога тишины (иначе ещё рано судить).
      if (observedHours > exp.maxSilenceHours) {
        dead.push({ key: exp.key, label: exp.label, reason: 'never', silentHours: null });
      }
      continue;
    }

    const silentHours = (now - lastNonEmpty) / 3_600_000;
    if (silentHours > exp.maxSilenceHours) {
      dead.push({ key: exp.key, label: exp.label, reason: 'silent', silentHours: Math.round(silentHours) });
    }
  }

  return dead;
}

/** Какие из мёртвых источников пора алертить (дебаунс по last_alerted_at). */
export function dueForAlert(
  dead: DeadSource[],
  rows: SourceHealthRow[],
  now: number,
  cooldownHours = ALERT_COOLDOWN_HOURS,
): DeadSource[] {
  const byKey = new Map(rows.map((r) => [r.source_key, r]));
  return dead.filter((d) => {
    const lastAlerted = toMs(byKey.get(d.key)?.last_alerted_at ?? null);
    return lastAlerted === null || (now - lastAlerted) / 3_600_000 >= cooldownHours;
  });
}

// ── DB-слой ──────────────────────────────────────────────────────────────

/** Записывает статус источников за прогон. `last_nonempty_at` двигаем при status='ok'. */
export async function recordSourceHealth(pool: Pool, entries: SourceHealthEntry[]): Promise<void> {
  for (const e of entries) {
    await pool.query(
      `INSERT INTO safety_source_health
         (source_key, label, last_run_at, last_status, raw_items, inserted,
          last_nonempty_at, first_seen_at, updated_at)
       VALUES ($1, $2, NOW(), $3, $4, $5, CASE WHEN $3 = 'ok' THEN NOW() ELSE NULL END, NOW(), NOW())
       ON CONFLICT (source_key) DO UPDATE SET
         label            = EXCLUDED.label,
         last_run_at      = NOW(),
         last_status      = EXCLUDED.last_status,
         raw_items        = EXCLUDED.raw_items,
         inserted         = EXCLUDED.inserted,
         last_nonempty_at = CASE WHEN EXCLUDED.last_status = 'ok'
                                 THEN NOW() ELSE safety_source_health.last_nonempty_at END,
         first_seen_at    = COALESCE(safety_source_health.first_seen_at, NOW()),
         updated_at       = NOW()`,
      [e.key, e.label, e.status, e.rawItems, e.inserted],
    );
  }
}

/** Читает все строки здоровья. */
export async function loadSourceHealth(pool: Pool): Promise<SourceHealthRow[]> {
  const { rows } = await pool.query<SourceHealthRow>(
    `SELECT source_key, label, last_status, last_run_at, last_nonempty_at,
            last_alerted_at, first_seen_at, raw_items, inserted
       FROM safety_source_health`,
  );
  return rows;
}

/** Фиксирует факт алерта (дебаунс). */
export async function markAlerted(pool: Pool, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await pool.query(
    `UPDATE safety_source_health SET last_alerted_at = NOW() WHERE source_key = ANY($1)`,
    [keys],
  );
}

/** Человекочитаемая строка алерта для Telegram. */
export function formatDeadSourceAlert(dead: DeadSource[]): string {
  const lines = dead.map((d) => {
    if (d.reason === 'not_configured') return `• ${d.label}: не настроен (нет env-ключа)`;
    if (d.reason === 'never') return `• ${d.label}: ни разу не дал данных (скрейп/парс сломан?)`;
    return `• ${d.label}: молчит ${d.silentHours} ч`;
  });
  return `Safety-ingest: источники не дают данных\n${lines.join('\n')}\n\nЛента безопасности может отставать. Проверь канал/ключ.`;
}

/**
 * lib/services/safety/park-closure-hold.ts
 *
 * Правило срока закрытия парка — и к уже лежащему (решение владельца 06.11).
 *
 * Классификатор ставит новое правило срока (`parkClosureHours`) новым постам:
 * сезонное закрытие без даты держится 21 сутки от публикации, названная
 * дата — до 60 суток. Строки, записанные до правила, держат прежний срок:
 * сводка 02.11 «на всех территориях природных парков на период межсезонья»
 * стоит в ленте до 09.11, и после этого Налычево стало бы ЗЕЛЁНЫМ при
 * закрытых маршрутах. Тот же приём, что у `capDatedWarnings`: правило одно,
 * крон приёма каждые пять минут прогоняет им живой набор, и хранилище
 * догоняет само — без миграции, которая стала бы второй копией правила.
 *
 * Срок только ПРОДЛЕВАЕТСЯ (условие `> expires_at` в UPDATE): укорачивать
 * здесь нечего, а недельный срок 168 ч, который классификатор дал
 * оперативному закрытию из сводки, правило без даты (48 ч) не должно срезать.
 *
 * Чего проход не трогает (ревью 06.11):
 *  - истёкшие строки: продлевать погашенное нельзя. С миграции 1394 снятое
 *    человеком помечено `ended_by = 'admin'`, снятое сводкой об открытии —
 *    `'reopening'`; истёкшее само сезонное закрытие становится «статус не
 *    известен» (park-reopening.ts), а не продлевается здесь. Условие «ещё
 *    жива» повторено и в самом UPDATE: строка, снятая между чтением и
 *    записью, не воскресает;
 *  - ручные записи: `manual-…` отсеивается ДО alertOrigin — тот узнаёт
 *    ручную запись со ссылкой на пост в MAX как ленту MAX по адресу;
 *  - строки, чей `external_id` не той формы, которую пишет классификатор
 *    (`<лента>/<день>/t<отпечаток>` или `<лента>/t<отпечаток>`): админ может
 *    задать id сам, и срок такой записи ставил человек;
 *  - строки с обрезанным текстом: saveEvent хранит заголовок до 200 знаков и
 *    описание до 800. Классификатор видел весь пост, и дата открытия за
 *    800-м знаком в его срок вошла, а проход её бы не увидел и продлил
 *    закрытие мимо названного открытия.
 *
 * Срок считается от ПОСЛЕДНЕЙ сводки — `COALESCE(last_published_at,
 * created_at)` (миграция 1394): `created_at` — дата первого поста, а повтор
 * той же сводки — новое подтверждение. Читается строкой UTC, а не через Date
 * драйвера, чтобы срок по названной дате не зависел от пояса процесса.
 * Каждое продление пишется в журнал решений (`risk_classified`): прежний и
 * новый срок, чтобы на вопрос «почему красное» был ответ.
 */

import { parkClosureHours } from '@/lib/safety/park-closure';
import { alertOrigin } from '@/lib/safety/alert-origin';
import { appendSafetyEvent, type AppendSafetyEventInput } from '@/lib/safety/ledger';
import type { QueryFn } from '@/lib/services/safety/alert-prune';
import { UTC_WALL_NOW_SQL, utcWallIsoSql } from '@/lib/db/timestamp-iso';

interface Row {
  id: string;
  title: string | null;
  description: string | null;
  external_id: string | null;
  source_url: string | null;
  created_iso: string | null;
  expires_iso: string | null;
}

/** Длины, до которых saveEvent обрезает текст (seismic-parser, classifyMchsItem). */
const TITLE_CLIP = 200;
const DESCRIPTION_CLIP = 800;

/** Форма external_id, которую пишет классификатор лент. */
const FEED_ID_RE = /^[a-z][a-z0-9_.]*(?:\/\d{4}-\d{2}-\d{2})?\/t[0-9a-z]+$/;

export type ParkHoldSkip = 'manual' | 'foreign_id' | 'clipped';

export interface ParkHoldResult {
  checked: number;
  extended: number;
  /** id продлённых строк — чтобы по ответу крона было видно, какие. */
  extended_ids: string[];
  skipped: Record<ParkHoldSkip, number>;
}

/** Почему строку не продлеваем, или null — правило к ней применимо. */
export function parkHoldSkip(row: Pick<Row, 'title' | 'description' | 'external_id' | 'source_url'>): ParkHoldSkip | null {
  const id = (row.external_id ?? '').trim();
  if (id.startsWith('manual-')) return 'manual';
  const origin = alertOrigin(id, row.source_url);
  if (origin?.key === 'manual') return 'manual';
  if (!origin || !FEED_ID_RE.test(id)) return 'foreign_id';
  if ((row.title ?? '').length >= TITLE_CLIP || (row.description ?? '').length >= DESCRIPTION_CLIP) return 'clipped';
  return null;
}

export async function holdParkClosures(
  query: QueryFn,
  record: (e: AppendSafetyEventInput) => Promise<unknown> = appendSafetyEvent,
): Promise<ParkHoldResult> {
  const res = await query<Row>(
    `SELECT id::text, title, description, external_id, source_url,
            ${utcWallIsoSql('COALESCE(last_published_at, created_at)')} AS created_iso, ${utcWallIsoSql('expires_at')} AS expires_iso
       FROM external_alerts
      WHERE alert_type = 'park_closure'
        AND expires_at > ${UTC_WALL_NOW_SQL}
        AND ended_by IS NULL`,
    [],
  );

  const skipped: Record<ParkHoldSkip, number> = { manual: 0, foreign_id: 0, clipped: 0 };
  const ids: string[] = [];
  const hours: number[] = [];
  const before = new Map<string, string | null>();
  for (const row of res.rows) {
    if (!row.created_iso || !row.expires_iso) continue;
    const skip = parkHoldSkip(row);
    if (skip) { skipped[skip] += 1; continue; }
    const created = new Date(row.created_iso);
    if (Number.isNaN(created.getTime())) continue;
    ids.push(row.id);
    hours.push(parkClosureHours(`${row.title ?? ''} ${row.description ?? ''}`, created));
    before.set(row.id, row.expires_iso);
  }
  if (ids.length === 0) return { checked: res.rows.length, extended: 0, extended_ids: [], skipped };

  // Сложение — в SQL, от того же основания. Условие «ещё жива» — и здесь:
  // между SELECT и UPDATE админ мог тревогу снять.
  const updated = await query<{ id: string; expires_iso: string }>(
    `UPDATE external_alerts ea
        SET expires_at = COALESCE(ea.last_published_at, ea.created_at) + make_interval(hours => v.hours)
       FROM unnest($1::text[], $2::int[]) AS v(id, hours)
      WHERE ea.id::text = v.id
        AND ea.alert_type = 'park_closure'
        AND ea.expires_at > ${UTC_WALL_NOW_SQL}
        AND ea.ended_by IS NULL
        AND COALESCE(ea.last_published_at, ea.created_at) + make_interval(hours => v.hours) > ea.expires_at
      RETURNING ea.id::text AS id, ${utcWallIsoSql('ea.expires_at')} AS expires_iso`,
    [ids, hours],
  );
  for (const r of updated.rows) {
    await record({
      entityId: r.id,
      eventType: 'risk_classified',
      actorType: 'system',
      actorId: 'safety-ingest.holdParkClosures',
      decisionReason: 'закрытие парка: срок по правилу 06.11 (сезонное — 21 сутки от последней сводки, названная дата — до 60 суток)',
      details: { prior_expires_at: before.get(r.id) ?? null, expires_at: r.expires_iso },
    });
  }
  return { checked: res.rows.length, extended: updated.rows.length, extended_ids: updated.rows.map((r) => r.id), skipped };
}

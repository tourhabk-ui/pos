/**
 * lib/services/safety/park-reopening.ts
 *
 * Закрытие парка на межсезонье — до сводки об открытии, а после предела —
 * «не знаю», а не «зелёный» (решение владельца 06.11, «1 да», п. 1 раздела 9
 * docs/agents/LEAD_PLAN.md). Первая правка дала срок (21 сутки,
 * park-closure-hold.ts); здесь — два прохода крона приёма, которые замыкают
 * правило с обеих сторон.
 *
 * ── applyParkReopenings: сводка об открытии снимает закрытие ──────────────
 *
 * Классификатор пишет сводку об открытии строкой `park_reopening`, рождённой
 * истёкшей (seismic-parser, срок 0 ч): живой её не видит ни один читатель
 * ленты, она — улика для этого прохода. Проход берёт открытия за
 * `REOPENING_WINDOW_DAYS` по дате публикации и снимает их парки с ЖИВЫХ
 * закрытий из лент, опубликованных (последней сводкой) РАНЬШЕ открытия.
 * Парков не осталось — закрытие гаснет с `ended_by = 'reopening'`.
 * Закрытие, опубликованное после открытия, не трогается: новая сводка о
 * закрытии сильнее старой об открытии.
 *
 * Чего проход не трогает: ручные записи и записи с id не той формы, что пишет
 * классификатор (`parkHoldSkip`) — их ставил человек, и снимать их по
 * сводке ленты нельзя.
 *
 * Сводки об открытии пишутся только из сводок о доступности (турпортал,
 * Минтур) и только по строгому распознавателю (detectParkReopening): ложное
 * открытие делает место зелёным. Попавшее всё же ложное администратор
 * отклоняет (rejectParkReopening, DELETE в админке): проходы его больше не
 * читают, а закрытия получают парки и срок обратно.
 *
 * ── markParkStatusUnknown: «не знаю» после предела ────────────────────────
 *
 * По каждому парку справочника `parks`: последнее СЕЗОННОЕ закрытие этого
 * парка из лент (по дате последней сводки). Если оно истекло само (не снято
 * человеком и не открытием, `ended_by IS NULL`), после него не было открытия
 * этого парка, живого закрытия этого парка нет, и с той сводки прошло не
 * больше `PARK_UNKNOWN_MAX_DAYS`, — держится строка `park_status_unknown`
 * уровня 1 с датой той сводки. Место парка становится ЖЁЛТЫМ (правило крона,
 * PARK_STATUS_UNKNOWN_SQL), лента и MCP называют дату последней сводки.
 *
 * Оперативное закрытие (циклон, названная дата) в «не знаю» не переходит: оно
 * само говорит, когда кончится. Поверх «не знаю» оно красит место красным и
 * не гасит его насовсем — после него «последним сезонным» остаётся прежнее.
 *
 * Срок строки — сутки, и каждый проход продлевает его, пока условие держится;
 * условие кончилось — строка гаснет тем же проходом. Снятая администратором
 * (`ended_by = 'admin'`) из того же основания не выводится снова; новое
 * основание (более позднее сезонное закрытие) её возвращает.
 *
 * Время в external_alerts — стенное UTC (#2495): сравнения — с
 * UTC_WALL_NOW_SQL, даты наружу — utcWallIsoSql, точные значения для сверки
 * «основание не сдвинулось» — текстом колонки.
 */

import { isIndefiniteClosure } from '@/lib/safety/park-closure';
import { PARK_UNKNOWN_MAX_DAYS } from '@/lib/safety/park-closure-terms';
import { PARK_UNKNOWN_ID_PREFIX } from '@/lib/safety/alert-origin';
import { appendSafetyEvent, type AppendSafetyEventInput } from '@/lib/safety/ledger';
import type { QueryFn } from '@/lib/services/safety/alert-prune';
import { parkHoldSkip } from '@/lib/services/safety/park-closure-hold';
import { UTC_WALL_NOW_SQL, utcWallIsoSql } from '@/lib/db/timestamp-iso';

/** Окно сводок об открытии, которые проход перечитывает каждым прогоном. */
export const REOPENING_WINDOW_DAYS = 14;

export { PARK_UNKNOWN_MAX_DAYS };

/** Сколько живёт строка «не знаю» без следующего прохода. */
const PARK_UNKNOWN_TTL_HOURS = 24;

type Record_ = (e: AppendSafetyEventInput) => Promise<unknown>;

// ── Открытие снимает закрытие ──────────────────────────────────────────────

interface ClosureRow {
  id: string;
  title: string | null;
  description: string | null;
  external_id: string | null;
  source_url: string | null;
  parks: string[];
  /** Основание отсчёта — COALESCE(last_published_at, created_at) — текстом, для точной сверки. */
  base_text: string;
  /** Срок до прохода — текстом: отмена открытия возвращает его (rejectParkReopening). */
  expires_text: string;
  opened: string[] | null;
  opening_ids: string[] | null;
}

export interface ParkReopeningResult {
  /** Сводок об открытии в окне. */
  openings: number;
  /** Живых закрытий из лент, сверенных с ними. */
  checked: number;
  /** Закрытий, с которых сняты не все парки. */
  narrowed: number;
  /** Закрытий, погашенных целиком. */
  ended: number;
  /** id изменённых закрытий — чтобы по ответу крона было видно, каких. */
  changed_ids: string[];
}

export async function applyParkReopenings(query: QueryFn, record: Record_ = appendSafetyEvent): Promise<ParkReopeningResult> {
  const opened = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM external_alerts
      WHERE alert_type = 'park_reopening'
        AND affected_parks IS NOT NULL
        AND ended_by IS NULL
        AND COALESCE(last_published_at, created_at) > ${UTC_WALL_NOW_SQL} - make_interval(days => $1::int)`,
    [REOPENING_WINDOW_DAYS],
  );
  const openings = Number(opened.rows[0]?.n ?? 0);
  if (openings === 0) return { openings: 0, checked: 0, narrowed: 0, ended: 0, changed_ids: [] };

  const res = await query<ClosureRow>(
    `WITH o AS (
       SELECT id::text AS id, affected_parks AS parks, COALESCE(last_published_at, created_at) AS opened_at
         FROM external_alerts
        WHERE alert_type = 'park_reopening'
          AND affected_parks IS NOT NULL
          AND ended_by IS NULL
          AND COALESCE(last_published_at, created_at) > ${UTC_WALL_NOW_SQL} - make_interval(days => $1::int)
     )
     SELECT c.id::text AS id, c.title, c.description, c.external_id, c.source_url,
            c.affected_parks AS parks,
            COALESCE(c.last_published_at, c.created_at)::text AS base_text,
            c.expires_at::text AS expires_text,
            ARRAY(SELECT DISTINCT p FROM o, unnest(o.parks) AS p
                   WHERE o.opened_at > COALESCE(c.last_published_at, c.created_at)
                     AND p = ANY(c.affected_parks)) AS opened,
            ARRAY(SELECT o.id FROM o
                   WHERE o.opened_at > COALESCE(c.last_published_at, c.created_at)
                     AND o.parks && c.affected_parks) AS opening_ids
       FROM external_alerts c
      WHERE c.alert_type = 'park_closure'
        AND c.expires_at > ${UTC_WALL_NOW_SQL}
        AND c.ended_by IS NULL
        AND c.affected_parks IS NOT NULL`,
    [REOPENING_WINDOW_DAYS],
  );

  const plan: Array<{ id: string; prior: string[]; left: string[]; base: string; expires: string; opened: string[]; opening_ids: string[] }> = [];
  let checked = 0;
  for (const row of res.rows) {
    const skip = parkHoldSkip(row);
    if (skip === 'manual' || skip === 'foreign_id') continue;
    checked += 1;
    const open = row.opened ?? [];
    if (open.length === 0) continue;
    plan.push({
      id: row.id,
      prior: row.parks,
      left: row.parks.filter((p) => !open.includes(p)),
      base: row.base_text,
      expires: row.expires_text,
      opened: open,
      opening_ids: row.opening_ids ?? [],
    });
  }
  if (plan.length === 0) return { openings, checked, narrowed: 0, ended: 0, changed_ids: [] };

  // Условие «ещё жива, не снята, основание и парки те же» — в самом UPDATE:
  // между чтением и записью админ мог её снять, новая сводка о закрытии —
  // вернуть парки и сдвинуть основание, соседний прогон — уже снять парки.
  const updated = await query<{ id: string; parks: string[]; ended: boolean }>(
    `UPDATE external_alerts ea
        SET affected_parks = CASE WHEN cardinality(v.left_parks) = 0 THEN ea.affected_parks ELSE v.left_parks END,
            expires_at = CASE WHEN cardinality(v.left_parks) = 0 THEN ${UTC_WALL_NOW_SQL} ELSE ea.expires_at END,
            ended_by = CASE WHEN cardinality(v.left_parks) = 0 THEN 'reopening' ELSE ea.ended_by END
       FROM jsonb_to_recordset($1::jsonb) AS v(id text, prior text[], left_parks text[], base text)
      WHERE ea.id::text = v.id
        AND ea.alert_type = 'park_closure'
        AND ea.expires_at > ${UTC_WALL_NOW_SQL}
        AND ea.ended_by IS NULL
        AND ea.affected_parks = v.prior
        AND COALESCE(ea.last_published_at, ea.created_at)::text = v.base
      RETURNING ea.id::text AS id, ea.affected_parks AS parks, (ea.ended_by = 'reopening') AS ended`,
    [JSON.stringify(plan.map((p) => ({ id: p.id, prior: p.prior, left_parks: p.left, base: p.base })))],
  );

  const byId = new Map(plan.map((p) => [p.id, p]));
  let narrowed = 0;
  let ended = 0;
  for (const r of updated.rows) {
    const p = byId.get(r.id);
    if (r.ended) ended += 1; else narrowed += 1;
    await record({
      entityId: r.id,
      eventType: 'risk_classified',
      actorType: 'system',
      actorId: 'safety-ingest.applyParkReopenings',
      decisionReason: r.ended
        ? 'закрытие парка снято: более поздняя сводка об открытии назвала все его парки'
        : 'закрытие парка сужено: парки, открытые более поздней сводкой, сняты',
      details: {
        prior_parks: p?.prior ?? null,
        parks: r.ended ? [] : r.parks,
        opened_parks: p?.opened ?? null,
        opening_ids: p?.opening_ids ?? null,
        closure_published_at: p?.base ?? null,
        prior_expires_at: p?.expires ?? null,
      },
    });
  }
  return { openings, checked, narrowed, ended, changed_ids: updated.rows.map((r) => r.id) };
}

// ── Администратор отклоняет ложное открытие ────────────────────────────────

/** Кто пишет журнал прохода открытий — по нему отмена находит тронутые закрытия. */
const REOPENING_ACTOR = 'safety-ingest.applyParkReopenings';

export interface ParkReopeningRejectResult {
  /** Строка — сводка об открытии, и этот вызов её отклонил. */
  rejected: boolean;
  /** Закрытия, которым возвращены парки или срок. */
  restored_ids: string[];
}

/**
 * Отклонить сводку об открытии (ревью 06.11). Ложное открытие гасило живое
 * закрытие, а снять его было нечем: строка рождается истёкшей, список и
 * DELETE админки брали только живые, и погашенное закрытие не возвращалось.
 *
 * Строка открытия получает `ended_by = 'admin'` — оба прохода её больше не
 * читают. Закрытия, которые она сузила или погасила, находятся по журналу
 * решений (applyParkReopenings пишет id открытий в `details.opening_ids`) и
 * получают обратно парки этого открытия; погашенное — ещё и прежний срок
 * (`details.prior_expires_at`). Срок за это время вышел — закрытие остаётся
 * истёкшим, но без `ended_by`, и вывод «не знаю» читает его как истёкшее
 * само. Снятое человеком (`admin`, `legacy`) не трогается. Парки, которые
 * открыла ДРУГАЯ, не отклонённая сводка, следующий проход снимет снова.
 */
export async function rejectParkReopening(
  query: QueryFn,
  id: string,
  record: Record_ = appendSafetyEvent,
): Promise<ParkReopeningRejectResult> {
  const rej = await query<{ id: string; parks: string[] | null }>(
    `UPDATE external_alerts
        SET ended_by = 'admin'
      WHERE id::text = $1
        AND alert_type = 'park_reopening'
        AND ended_by IS NULL
      RETURNING id::text AS id, affected_parks AS parks`,
    [id],
  );
  const opening = rej.rows[0];
  if (!opening) return { rejected: false, restored_ids: [] };
  const openedParks = opening.parks ?? [];
  await record({
    entityId: opening.id,
    eventType: 'risk_classified',
    actorType: 'editor',
    actorId: 'admin.rejectParkReopening',
    decisionReason: 'сводка об открытии отклонена администратором: проходы парков её больше не читают',
    details: { parks: openedParks },
  });

  const touched = await query<{ closure_id: string; prior_parks: string[]; ended: boolean; prior_expires_at: string | null }>(
    `SELECT entity_id AS closure_id,
            ARRAY(SELECT jsonb_array_elements_text(COALESCE(details->'prior_parks', '[]'::jsonb))) AS prior_parks,
            (jsonb_array_length(COALESCE(details->'parks', '[]'::jsonb)) = 0) AS ended,
            details->>'prior_expires_at' AS prior_expires_at
       FROM safety_decision_events
      WHERE actor_id = $1
        AND details->'opening_ids' ? $2::text
      ORDER BY id`,
    [REOPENING_ACTOR, opening.id],
  );

  // По закрытию: какие парки вернуть (только парки ЭТОГО открытия, которые у
  // закрытия были) и, если его погасили, — прежний срок.
  const byClosure = new Map<string, { parks: Set<string>; priorExpires: string | null }>();
  for (const t of touched.rows) {
    const entry = byClosure.get(t.closure_id) ?? { parks: new Set<string>(), priorExpires: null };
    for (const p of t.prior_parks) if (openedParks.includes(p)) entry.parks.add(p);
    if (t.ended && t.prior_expires_at) entry.priorExpires = t.prior_expires_at;
    byClosure.set(t.closure_id, entry);
  }
  if (byClosure.size === 0) return { rejected: true, restored_ids: [] };

  const plan = [...byClosure.entries()]
    .map(([closureId, e]) => ({ id: closureId, parks: [...e.parks], prior_expires: e.priorExpires }))
    .filter((p) => p.parks.length > 0 || p.prior_expires !== null);
  if (plan.length === 0) return { rejected: true, restored_ids: [] };
  // Парки — объединением, порядок прежних не трогается; срок — только у
  // погашенного открытием. Закрытие, снятое человеком, условие пропускает.
  const restored = await query<{ id: string; parks: string[]; revived: boolean }>(
    `UPDATE external_alerts ea
        SET affected_parks = COALESCE(ea.affected_parks, '{}'::text[])
              || ARRAY(SELECT p FROM unnest(v.parks) AS p WHERE NOT (p = ANY(COALESCE(ea.affected_parks, '{}'::text[])))),
            expires_at = CASE WHEN ea.ended_by = 'reopening' AND v.prior_expires IS NOT NULL
                              THEN v.prior_expires::timestamp ELSE ea.expires_at END,
            ended_by = CASE WHEN ea.ended_by = 'reopening' THEN NULL ELSE ea.ended_by END
       FROM jsonb_to_recordset($1::jsonb) AS v(id text, parks text[], prior_expires text)
      WHERE ea.id::text = v.id
        AND ea.alert_type = 'park_closure'
        AND (ea.ended_by IS NULL OR ea.ended_by = 'reopening')
      RETURNING ea.id::text AS id, ea.affected_parks AS parks, (ea.expires_at > ${UTC_WALL_NOW_SQL}) AS revived`,
    [JSON.stringify(plan)],
  );
  for (const r of restored.rows) {
    await record({
      entityId: r.id,
      eventType: 'risk_classified',
      actorType: 'editor',
      actorId: 'admin.rejectParkReopening',
      decisionReason: r.revived
        ? 'закрытие парка возвращено: сводка об открытии, которая его сняла, отклонена администратором'
        : 'парки закрытия возвращены после отклонения сводки об открытии; срок закрытия уже вышел',
      details: { opening_id: opening.id, parks: r.parks },
    });
  }
  return { rejected: true, restored_ids: restored.rows.map((r) => r.id) };
}

// ── «Не знаю» после предела ────────────────────────────────────────────────

interface FeedClosure {
  id: string;
  title: string | null;
  description: string | null;
  external_id: string | null;
  source_url: string | null;
  parks: string[];
  ended_by: string | null;
  live: boolean;
  base_iso: string;
  base_text: string;
}

interface UnknownRow {
  id: string;
  external_id: string;
  live: boolean;
  ended_by: string | null;
  created_text: string | null;
}

export interface ParkStatusUnknownResult {
  /** Парков справочника. */
  parks_checked: number;
  /** Парки, о которых после прохода держится «не знаю». */
  unknown: string[];
  /** Начато этим проходом: впервые, с новым основанием или после перерыва. */
  started: string[];
  /** Погашено этим проходом: пришло открытие или закрытие, либо вышел предел. */
  ended: string[];
  /** Основание то же, а строку снял администратор: не выводится снова. */
  held_by_admin: string[];
}

/** «Природный парк «Налычево»» → «Налычево»; без кавычек — имя целиком. */
export function parkShortName(displayName: string): string {
  const quoted = [...displayName.matchAll(/«([^«»]+)»/g)].map((m) => m[1]);
  return quoted.length > 0 ? quoted[quoted.length - 1] : displayName;
}

/** «02.11» — день сводки по Камчатке (UTC+12, без летнего времени). */
export function kamchatkaDayMonth(iso: string): string {
  const d = new Date(Date.parse(iso) + 12 * 3_600_000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}`;
}

/**
 * Заголовок и текст строки «не знаю» — из справочника и самой сводки, без
 * догадок. Дата сводки стоит и в заголовке: карточка места, совет Кузьмича и
 * вердикт маршрута показывают одни заголовки (active_alerts), а ответ обязан
 * её называть (решение владельца 06.11). Корня «закрыт» в заголовке нет:
 * «статус не известен» не должен читаться уликой «парк закрыт».
 *
 * Сводка названа точно — сезонная, о закрытии на межсезонье: после неё
 * могла быть оперативная (циклон), и «последняя сводка от …» назвала бы не
 * ту дату (ревью 06.11). Об открытии — «мы не нашли», а не «не было»: распознаватель
 * открытия строг намеренно и пропускает часть настоящих сводок
 * (detectParkReopening), и «не было» было бы фактом об источнике, которого
 * мы не знаем.
 */
export function parkUnknownWords(displayName: string, basis: { base_iso: string; title: string | null; description: string | null }): { title: string; description: string } {
  const text = `${basis.title ?? ''} ${basis.description ?? ''}`.toLowerCase();
  const term = /межсезон/.test(text) ? 'на межсезонье' : 'без даты открытия';
  const day = kamchatkaDayMonth(basis.base_iso);
  return {
    title: `Статус парка «${parkShortName(displayName)}» не известен: последняя сезонная сводка от ${day}`,
    description:
      `Сводка от ${day} сообщала о закрытии маршрутов ${term}; ` +
      'сводку об открытии в лентах, которые читает Ведар, мы не нашли. Перед выходом уточните у дирекции парка.',
  };
}

export async function markParkStatusUnknown(query: QueryFn, record: Record_ = appendSafetyEvent): Promise<ParkStatusUnknownResult> {
  const parks = (await query<{ slug: string; display_name: string }>(
    `SELECT slug, display_name FROM parks ORDER BY slug`, [],
  )).rows;

  // Закрытия парков из лент за окно предела — живые и истёкшие: последнее
  // сезонное по парку решает, а живое любое говорит «красный, не жёлтый».
  const closures = (await query<FeedClosure>(
    `SELECT id::text AS id, title, description, external_id, source_url, affected_parks AS parks, ended_by,
            expires_at > ${UTC_WALL_NOW_SQL} AS live,
            ${utcWallIsoSql('COALESCE(last_published_at, created_at)')} AS base_iso,
            COALESCE(last_published_at, created_at)::text AS base_text
       FROM external_alerts
      WHERE alert_type = 'park_closure'
        AND affected_parks IS NOT NULL
        AND COALESCE(last_published_at, created_at) > ${UTC_WALL_NOW_SQL} - make_interval(days => $1::int)`,
    [PARK_UNKNOWN_MAX_DAYS],
  )).rows;
  // Живое закрытие любого рода, ручное тоже: при нём место и так красное.
  const liveAny = (await query<{ parks: string[] }>(
    `SELECT affected_parks AS parks FROM external_alerts
      WHERE alert_type = 'park_closure' AND affected_parks IS NOT NULL AND expires_at > ${UTC_WALL_NOW_SQL}`,
    [],
  )).rows;
  const openings = (await query<{ parks: string[]; opened_iso: string }>(
    `SELECT affected_parks AS parks, ${utcWallIsoSql('COALESCE(last_published_at, created_at)')} AS opened_iso
       FROM external_alerts
      WHERE alert_type = 'park_reopening'
        AND affected_parks IS NOT NULL
        AND ended_by IS NULL
        AND COALESCE(last_published_at, created_at) > ${UTC_WALL_NOW_SQL} - make_interval(days => $1::int)`,
    [PARK_UNKNOWN_MAX_DAYS + 1],
  )).rows;
  const existing = (await query<UnknownRow>(
    `SELECT id::text AS id, external_id, expires_at > ${UTC_WALL_NOW_SQL} AS live, ended_by,
            created_at::text AS created_text
       FROM external_alerts
      WHERE external_id LIKE $1`,
    [`${PARK_UNKNOWN_ID_PREFIX}%`],
  )).rows;
  const existingById = new Map(existing.map((r) => [r.external_id, r]));

  const feed = closures.filter((c) => {
    const skip = parkHoldSkip(c);
    return skip !== 'manual' && skip !== 'foreign_id';
  });
  const seasonal = new Set(feed.filter((c) => isIndefiniteClosure(`${c.title ?? ''} ${c.description ?? ''}`)).map((c) => c.id));

  // Производитель рода `park_status_unknown` — эти записи (alert-types-produced).
  const wanted: Array<{
    alert_type: 'park_status_unknown'; severity: 1; slug: string; external_id: string;
    title: string; description: string; base: string; source_url: string | null; basis_id: string;
  }> = [];
  const heldByAdmin: string[] = [];
  for (const park of parks) {
    const own = feed
      .filter((c) => seasonal.has(c.id) && c.parks.includes(park.slug))
      .sort((a, b) => Date.parse(b.base_iso) - Date.parse(a.base_iso));
    const last = own[0];
    if (!last) continue;
    if (last.live || last.ended_by !== null) continue;
    if (liveAny.some((c) => c.parks.includes(park.slug))) continue;
    const base = Date.parse(last.base_iso);
    if (openings.some((o) => o.parks.includes(park.slug) && Date.parse(o.opened_iso) > base)) continue;
    const externalId = `${PARK_UNKNOWN_ID_PREFIX}${park.slug}`;
    const prior = existingById.get(externalId);
    if (prior && prior.ended_by === 'admin' && prior.created_text === last.base_text) {
      heldByAdmin.push(park.slug);
      continue;
    }
    const words = parkUnknownWords(park.display_name, last);
    wanted.push({
      alert_type: 'park_status_unknown',
      severity: 1,
      slug: park.slug,
      external_id: externalId,
      title: words.title,
      description: words.description,
      base: last.base_text,
      source_url: last.source_url,
      basis_id: last.id,
    });
  }

  const started: string[] = [];
  if (wanted.length > 0) {
    // created_at и last_published_at — дата сводки-основания, не «сейчас»:
    // свежесть ленты (MAX(created_at)) строка «не знаю» не подделывает, а
    // открытие, опубликованное после основания, но принятое позже, её гасит.
    // Сверка с прежней строкой по основанию — текстом, без потери точности.
    const up = await query<{ id: string; external_id: string }>(
      `INSERT INTO external_alerts (alert_type, severity, title, description, affected_zones, affected_parks,
                                    created_at, last_published_at, expires_at, source_url, external_id)
       SELECT v.alert_type, v.severity, v.title, v.description, '{}', ARRAY[v.slug],
              v.base::timestamp, v.base::timestamp,
              ${UTC_WALL_NOW_SQL} + make_interval(hours => $2::int), v.source_url, v.external_id
         FROM jsonb_to_recordset($1::jsonb)
              AS v(alert_type text, severity int, slug text, title text, description text, base text, source_url text, external_id text)
       ON CONFLICT (external_id) DO UPDATE
          SET alert_type = EXCLUDED.alert_type,
              severity = EXCLUDED.severity,
              title = EXCLUDED.title,
              description = EXCLUDED.description,
              affected_zones = EXCLUDED.affected_zones,
              affected_parks = EXCLUDED.affected_parks,
              created_at = EXCLUDED.created_at,
              last_published_at = EXCLUDED.last_published_at,
              expires_at = EXCLUDED.expires_at,
              source_url = EXCLUDED.source_url,
              ended_by = NULL
        WHERE external_alerts.ended_by IS DISTINCT FROM 'admin'
           OR external_alerts.created_at IS DISTINCT FROM EXCLUDED.created_at
       RETURNING id::text AS id, external_id`,
      [JSON.stringify(wanted), PARK_UNKNOWN_TTL_HOURS],
    );
    const ids = new Map(up.rows.map((r) => [r.external_id, r.id]));
    for (const w of wanted) {
      const prior = existingById.get(w.external_id);
      if (prior && prior.live && prior.created_text === w.base) continue;
      started.push(w.slug);
      await record({
        entityId: ids.get(w.external_id) ?? null,
        eventType: 'risk_classified',
        actorType: 'system',
        actorId: 'safety-ingest.markParkStatusUnknown',
        decisionReason: 'статус парка не известен: сезонное закрытие истекло, сводку об открытии мы не нашли',
        details: { park: w.slug, basis_id: w.basis_id, basis_published_at: w.base, source_url: w.source_url },
      });
    }
  }

  // Условие кончилось — строка гаснет: пришло открытие или закрытие, вышел
  // предел. ended_by не ставится: её погасило правило, а не человек, и при
  // том же основании она вернётся, когда условие снова сойдётся.
  //
  // Гаснут только строки, которые этот проход САМ прочитал живыми: соседний
  // прогон (GET и POST крона идут параллельно) мог завести строку после
  // нашего чтения, и наш устаревший снимок её бы погасил (ревью 06.11).
  const keep = wanted.map((w) => w.external_id);
  const seenLive = existing.filter((r) => r.live).map((r) => r.id);
  const gone = seenLive.length === 0 ? { rows: [] as Array<{ id: string; external_id: string }> } : await query<{ id: string; external_id: string }>(
    `UPDATE external_alerts
        SET expires_at = ${UTC_WALL_NOW_SQL}
      WHERE external_id LIKE $1
        AND NOT (external_id = ANY($2::text[]))
        AND id::text = ANY($3::text[])
        AND expires_at > ${UTC_WALL_NOW_SQL}
      RETURNING id::text AS id, external_id`,
    [`${PARK_UNKNOWN_ID_PREFIX}%`, keep, seenLive],
  );
  const ended = gone.rows.map((r) => r.external_id.slice(PARK_UNKNOWN_ID_PREFIX.length));
  for (const r of gone.rows) {
    await record({
      entityId: r.id,
      eventType: 'risk_classified',
      actorType: 'system',
      actorId: 'safety-ingest.markParkStatusUnknown',
      decisionReason: `статус парка снова известен или вышел предел: открытие, новое закрытие либо больше ${PARK_UNKNOWN_MAX_DAYS} суток от сводки`,
      details: { park: r.external_id.slice(PARK_UNKNOWN_ID_PREFIX.length) },
    });
  }

  return {
    parks_checked: parks.length,
    unknown: wanted.map((w) => w.slug),
    started,
    ended,
    held_by_admin: heldByAdmin,
  };
}

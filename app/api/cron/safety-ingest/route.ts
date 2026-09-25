import { z } from 'zod';
import { fetchTelegramPreview } from '@/lib/services/safety/telegram-source';
import type { FetchVia } from '@/lib/agents/scout-relay';
import { fetchEmsdPage } from '@/lib/services/safety/emsd-fetch';
import { EMSD_QUAKES_URL } from '@/lib/services/safety/emsd-quakes';
import { ingestEmsdQuakes, type EmsdIngestResult, ingestAll, ingestFromHtml, ingestNewsFeeds, ingestTelegramNewsHtml, ingestMaxItems, ingestNewsFeedXmls, type ParseResult } from '@/lib/services/safety/seismic-parser';
import { appendSafetyEvent } from '@/lib/safety/ledger';
import { sourceReport, TRIGGER_LABEL, type IngestTrigger, ingestRunStatus, ingestRunDetail, type RunSource, type IngestRunStatus } from '@/lib/services/safety/ingest-outcome';
import { pruneRejectedGenres, type PruneResult } from '@/lib/services/safety/alert-prune';
import { ingestFirmsWildfires } from '@/lib/services/safety/wildfire-firms';
import { query } from '@/lib/database';
import { VOLCANO_STALE_DAYS } from '@/lib/services/safety/kvert-vona';
import { KFEGS_MAX_AGE_DAYS } from '@/lib/services/safety/volcano-scales';
import { pool } from '@/lib/db-pool';
import { buildAnchorIndex, matchAlertAnchor, ROAD_ALERT_RADIUS_KM } from '@/lib/safety/alert-anchor';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { sendPushBroadcast } from '@/lib/notifications/web-push';
import { pushCopy } from '@/lib/services/safety/push-copy';
import {
  SAFETY_SOURCE_EXPECTATIONS,
  recordSourceHealth,
  loadSourceHealth,
  evaluateDeadSources,
  splitKnownDormant,
  dueForAlert,
  markAlerted,
  formatDeadSourceAlert,
  type SourceHealthEntry,
  type SourceStatus,
} from '@/lib/services/safety/source-health';

/**
 * Статус источника по его результату: канал жив, если прислал хоть один
 * сырой пост.
 *
 * Safety Decision Ledger (925): здесь же — source_observed/fetch_failed,
 * по одному источнику за прогон. not_configured/not_fetched НЕ эмитят
 * source_observed — источник в этих состояниях не был опрошен вовсе,
 * фиксировать «наблюдение» было бы неправдой (§4.0).
 */
async function entryFor(
  key: string,
  label: string,
  result: ParseResult | undefined,
  opts: { requiresEnv?: string; notFetched?: boolean } = {},
): Promise<SourceHealthEntry> {
  let status: SourceStatus;
  let rawItems = 0;
  let inserted = 0;
  if (opts.requiresEnv && !process.env[opts.requiresEnv]) {
    status = 'not_configured';
  } else if (opts.notFetched || !result) {
    status = 'not_fetched';
  } else {
    rawItems = result.rawItems ?? result.events.length;
    inserted = result.inserted;
    // Жив, если пришёл хоть один сырой пост ИЛИ что-то классифицировалось.
    status = rawItems > 0 || result.events.length > 0 ? 'ok' : 'empty';
  }
  if (status === 'ok' || status === 'empty') {
    await appendSafetyEvent({
      entityId: null,
      eventType: 'source_observed',
      actorType: 'source',
      actorId: key,
      details: { label, rawItems, inserted },
    });
  }
  // Частичный отказ (часть items не разобралась) не исключает source_observed
  // выше — оба факта верны одновременно, если результат вообще был.
  if (result && result.errors.length > 0) {
    await appendSafetyEvent({
      entityId: null,
      eventType: 'fetch_failed',
      actorType: 'source',
      actorId: key,
      decisionReason: result.errors.join('; ').slice(0, 500),
      details: { label, errors: result.errors },
    });
  }
  return { key, label, status, rawItems, inserted };
}

/** Источник, чьё молчание принято решением (knownDormant), — для тела ответа. */
export type KnownDormantSource = { key: string; label: string; since: string; reason: string; silentHours: number | null };

/**
 * Записать здоровье источников и, если есть мёртвые (с дебаунсом), алертнуть в
 * Telegram. Возвращает принятых-молчащих (knownDormant): они в Telegram не
 * уходят, но обязаны быть видны в теле ответа — «не шумим» ≠ «не знаем».
 */
async function watchSourceHealth(entries: SourceHealthEntry[]): Promise<KnownDormantSource[]> {
  try {
    await recordSourceHealth(pool, entries);
    const rows = await loadSourceHealth(pool);
    const now = Date.now();
    const dead = evaluateDeadSources(rows, SAFETY_SOURCE_EXPECTATIONS, now);
    const { alertable, known } = splitKnownDormant(dead, SAFETY_SOURCE_EXPECTATIONS);
    const knownOut: KnownDormantSource[] = known.map((k) => ({
      key: k.key, label: k.label, since: k.since, reason: k.dormantReason, silentHours: k.silentHours,
    }));
    const due = dueForAlert(alertable, rows, now);
    if (!due.length) return knownOut;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
      await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: formatDeadSourceAlert(due) }),
      }).catch(() => {});
    }
    await markAlerted(pool, due.map((d) => d.key));
    return knownOut;
  } catch (err) {
    // Мониторинг не должен ронять ingest — но и молчать нельзя (§4.0): пустой
    // catch превращал «сторож источников не отработал» в «источники живы».
    console.error('[safety-ingest] watchSourceHealth не отработал:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * GET  /api/cron/safety-ingest  — сервер сам fetch'ит t.me (работает если не заблокирован)
 * POST /api/cron/safety-ingest  — GitHub Actions передаёт HTML body, сервер только парсит
 *
 * POST body: { kbgsras_html: string, eqkam_html: string }
 * GitHub Actions нужен когда хостинг не может достучаться до t.me (Timeweb / Roskomnadzor).
 */

function authError(req: Request): Response | null {
  const secret = getCronSecret(req);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!timingSafeCompare(secret, cronSecret)) return Response.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });
  return null;
}

/**
 * Ассоциация алерта с точкой/маршрутом.
 *
 * По умолчанию — зона (~сотни км, northern/eastern/avachinsky): годится для
 * событий без точных координат (МЧС-текст, официальные предупреждения о
 * цунами) и для точек без lat/lng.
 *
 * Радиус вместо зоны — у двух родов событий, и оба заведены по живому
 * случаю, а не про запас.
 *
 * Пожар (`fire_danger`, NASA FIRMS): у события ЕСТЬ точные координаты
 * кластера (`external_alerts.lat/lng`, migration 687). Находка issue #861 —
 * одиночная термоточка (возможно вулканическая термаль, severity 0) зажигала
 * карточки ВСЕХ маршрутов зоны, включая лежащие в 300 км. RADIUS 50 км —
 * инженерная оценка (шире 10-километрового кластера FIRMS, уже зоны).
 *
 * Ограничение проезда (`road_closure`, лента МЧС): координат у события нет
 * вовсе, и до 15.09 оно раскладывалось зоной. Владелец увидел итог на
 * карточке «Раздолья»: «Вилючинский перевал — проезд по пропускам» у
 * купальни за шестьдесят километров. Координаты берутся из НАШЕГО каталога
 * по имени объекта в заголовке (`anchorRoadAlerts` ниже), радиус 30 км —
 * решение владельца.
 *
 * Событие или точка без обеих координат уходят в обычный зонный фолбэк:
 * привязка, которой нет, не выдаётся за привязку.
 *
 * Единственная формула на все три поля (active_alerts/alert_severity/
 * recommender_status) — раньше один и тот же предикат был написан трижды,
 * в трёх отдельных correlated subquery. Плодить его четвёртым местом при
 * следующей правке не стоит.
 */

/**
 * Когда у события и у точки есть координаты И тип события таков, что
 * расстояние вообще что-то значит.
 *
 * Условие написано ОДИН раз и подставляется в обе ветки: в первой редакции
 * оно было продублировано с отрицанием, и любая правка радиусных типов
 * требовала помнить про второй экземпляр. Точка, не попавшая ни в одну
 * ветку, теряет очистку `active_alerts` и остаётся со вчерашним значением —
 * то есть цена расхождения здесь не косметическая.
 */
const GEO_SCOPED_SQL = `
  ea.alert_type IN ('fire_danger', 'road_closure')
  AND ea.lat IS NOT NULL AND ea.lng IS NOT NULL
  AND ark.lat IS NOT NULL AND ark.lng IS NOT NULL
`;

/**
 * Радиус по роду события, км.
 *
 * Пожар — 50: шире 10-километрового кластера FIRMS, уже зоны (инженерная
 * оценка #861, не замер).
 *
 * Дорожное ограничение — 30: решение владельца 15.09 («30 км от вилючинского
 * вулкана достаточно») после карточки «Раздолья», где предупреждение о
 * Вилючинском перевале висело за шестьдесят километров. Число хранится в
 * `ROAD_ALERT_RADIUS_KM` и подставляется отсюда, чтобы у радиуса не завелось
 * второго значения в SQL.
 */
const ALERT_MATCH_SQL = `
  (
    ${GEO_SCOPED_SQL}
    AND 2 * 6371 * asin(sqrt(
          power(sin(radians((ark.lat - ea.lat) / 2)), 2)
          + cos(radians(ea.lat)) * cos(radians(ark.lat))
            * power(sin(radians((ark.lng - ea.lng) / 2)), 2)
        )) <= CASE ea.alert_type
                WHEN 'road_closure' THEN ${ROAD_ALERT_RADIUS_KM}
                ELSE 50
              END
  )
  OR (
    NOT (${GEO_SCOPED_SQL})
    -- Пустые/NULL зоны совпадают НИ С КЕМ (17.09). Раньше здесь стояло
    -- «IS NULL OR = '{}' OR …» — пустота читалась как «весь край», и любое
    -- предупреждение, у которого зона не распозналась, красило каждое место
    -- (паводок в Соболевском округе → красный на сопках в центре города).
    -- Та же ошибка сводила на нет лечение USGS в seismic-zones.ts: далёкое
    -- землетрясение сохранялось с [] и по этому предикату красило всех.
    -- «Не установлено» ≠ «везде» (§4.0). Событие с пустыми зонами остаётся в
    -- общекраевой ленте (/safety, safety_status); явно общекраевые тексты
    -- получают все четыре зоны в mchs_zones по слову источника.
    -- Зеркальный предикат — lib/routes/collect-signals.ts; сторож
    -- tests/unit/alert-zone-unknown.test.ts держит их вместе.
    AND ark.zone = ANY(ea.affected_zones)
  )
`;

/**
 * Привязать дорожные предупреждения к точке каталога.
 *
 * Лента МЧС координат не несёт, поэтому до 15.09 ограничение проезда
 * раскладывалось ЗОНОЙ — на сотни километров. Владелец увидел итог на
 * карточке «Раздолья»: «Вилючинский перевал — проезд по пропускам» у
 * купальни за шестьдесят километров.
 *
 * Здесь координаты берутся из НАШЕГО каталога по имени объекта в заголовке
 * (`lib/safety/alert-anchor.ts`, три исхода: нашли / несколько / нет).
 * Дальше радиусную привязку делает `ALERT_MATCH_SQL` — тем же способом, что
 * уже работает на пожарах FIRMS.
 *
 * Лечит и уже лежащие записи, а не только свежий приём: предупреждение живёт
 * неделю, и починка, которая начинает действовать через неделю, — это не
 * починка. Условие `lat IS NULL` делает прогон идемпотентным: привязанное
 * второй раз не трогается.
 */
interface RoadAnchorResult {
  /** Получили точку привязки — дальше судит радиус. */
  anchored: number;
  /** Имя в заголовке совпало с несколькими точками: какая — неизвестно. */
  ambiguous: number;
  /** Такой точки в каталоге нет. Пробел каталога, а не ошибка привязки. */
  unresolved: number;
  error?: string;
}

async function anchorRoadAlerts(): Promise<RoadAnchorResult> {
  try {
    const places = await query<{ id: string; name: string; lat: string; lng: string }>(
      `SELECT id::text AS id, name, lat::text AS lat, lng::text AS lng
         FROM places
        WHERE is_visible = TRUE AND merged_into_id IS NULL
          AND lat IS NOT NULL AND lng IS NOT NULL`,
    );
    if (places.rows.length === 0) {
      // Каталог пуст — привязывать не к чему. Это отказ, а не «ноль
      // привязок»: ноль здесь неотличим от «всё уже привязано» (§4.0).
      return { anchored: 0, ambiguous: 0, unresolved: 0, error: 'каталог мест пуст — привязывать не к чему' };
    }
    const index = buildAnchorIndex(places.rows.map(r => ({
      id: r.id, name: r.name, lat: Number(r.lat), lng: Number(r.lng),
    })));

    const pending = await query<{ id: string; title: string }>(
      `SELECT id::text AS id, title FROM external_alerts
        WHERE alert_type = 'road_closure'
          AND expires_at > NOW()
          AND (lat IS NULL OR lng IS NULL)`,
    );

    let anchored = 0, ambiguous = 0, unresolved = 0;
    for (const row of pending.rows) {
      const match = matchAlertAnchor(index, row.title);
      if (match.kind === 'ambiguous') { ambiguous++; continue; }
      if (match.kind === 'none') { unresolved++; continue; }
      await query(
        `UPDATE external_alerts SET lat = $2, lng = $3 WHERE id::text = $1`,
        [row.id, match.place.lat, match.place.lng],
      );
      anchored++;
    }
    return { anchored, ambiguous, unresolved };
  } catch (e) {
    // Молчать нельзя: без строки в логе «почему предупреждение опять на всю
    // зону» не находится никогда.
    const message = e instanceof Error ? e.message : 'привязка не выполнилась';
    console.error('[safety-ingest] привязка дорожных предупреждений не выполнилась:', message);
    return { anchored: 0, ambiguous: 0, unresolved: 0, error: message };
  }
}

async function updateRealTimeStatus(): Promise<{ updated: number; error?: string }> {
  try {
    const r = await query(`
      WITH matched AS (
        -- LEFT JOIN external_alerts: каждая точка обязана попасть в агрегат
        -- ровно один раз, даже без единого совпадения — иначе точка без
        -- активных алертов не получит очистку active_alerts/severity этим
        -- прогоном и останется со вчерашним значением.
        SELECT
          lrs.id AS lrs_id,
          ea.title,
          ea.severity
        FROM location_real_time_status lrs
        LEFT JOIN agent_route_knowledge ark ON ark.id = lrs.agent_route_id
        LEFT JOIN external_alerts ea
          ON ea.expires_at > NOW()
          AND (${ALERT_MATCH_SQL})
      ),
      dedup AS (
        -- DISTINCT: RSS-перепубликации одного предупреждения (разные guid,
        -- один текст) размножали алерт шестикратно на карточках маршрутов.
        -- Теперь дедуп отдельным шагом, чтобы ниже осталась ВОЗМОЖНОСТЬ
        -- отсортировать: у array_agg(DISTINCT ...) порядок задать нечем,
        -- кроме самого title.
        SELECT DISTINCT ON (lrs_id, title) lrs_id, title, severity
        FROM matched
        ORDER BY lrs_id, title, severity DESC
      ),
      agg AS (
        -- ПОРЯДОК ПО ОПАСНОСТИ, а не по алфавиту (правка 15.09).
        --
        -- Владелец на карточке «Раздолья»: «Кузьмич безопасность бред
        -- написал». Карточка писала «Сегодня сюда — нет» и тут же
        -- «Активное предупреждение: Вилючинский перевал — проезд по
        -- пропускам», хотя перевал в шестидесяти километрах и severity у
        -- него 1. Красный вердикт давал ДРУГОЙ алерт зоны, посильнее, а
        -- показывался первый по алфавиту: activeAlerts[0] читатели
        -- (карточка, Кузьмич) берут как «то самое предупреждение».
        --
        -- Объяснение, не относящееся к выводу, хуже отсутствия объяснения:
        -- человек сверяет одно с другим и перестаёт верить обоим.
        SELECT
          lrs_id,
          COALESCE(
            array_agg(title ORDER BY severity DESC, title)
              FILTER (WHERE title IS NOT NULL),
            '{}'
          ) AS alerts,
          COALESCE(MAX(severity), 0) AS max_severity
        FROM dedup
        GROUP BY lrs_id
      ),
      volc AS (
        -- ВУЛКАНИЧЕСКИЙ УРОВЕНЬ ТОЧКИ (26.09). До этого статус считался
        -- только по алертам и загрузке, и Шивелуч под KVERT ОРАНЖЕВЫМ (пепел
        -- до 12 км) стоял [ЗЕЛЁНЫЙ] — первой строкой карточки, у Кузьмича и
        -- в MCP, а код вулкана печатался строкой ниже, как примечание.
        -- Статус места — максимум по всем шкалам, а не одна из них.
        --
        -- 2 — оранжевый/красный, 1 — жёлтый: то же правило, что у радара
        -- (levelForColor, lib/services/safety/volcano-scales). Устаревшая
        -- шкала не голосует: KVERT старше VOLCANO_STALE_DAYS и сводка КФ ЕГС
        -- старше kfegsIsFresh — это «не знаем», а не «спокойно» и не
        -- «опасно» (§4.0); о давности говорят сами строки шкал.
        SELECT
          lrs.id AS lrs_id,
          GREATEST(
            COALESCE((
              SELECT MAX(CASE vs.aviation_color_code
                           WHEN 'red' THEN 2 WHEN 'orange' THEN 2 WHEN 'yellow' THEN 1 ELSE 0 END)
                FROM volcano_status vs
               WHERE vs.place_ark_id = lrs.agent_route_id
                 AND vs.observed_at > NOW() - INTERVAL '1 day' * $1::int
            ), 0),
            COALESCE((
              SELECT CASE b.color
                       WHEN 'red' THEN 2 WHEN 'orange' THEN 2 WHEN 'yellow' THEN 1 ELSE 0 END
                FROM volcano_bulletin_kfegs b
               WHERE b.place_ark_id = lrs.agent_route_id
                 AND (b.observed_date::timestamp AT TIME ZONE 'UTC') >= NOW() - INTERVAL '1 day' * $2::int
               ORDER BY b.observed_date DESC
               LIMIT 1
            ), 0)
          ) AS level
        FROM location_real_time_status lrs
      )
      UPDATE location_real_time_status lrs
      SET
        active_alerts = agg.alerts,
        alert_severity = agg.max_severity,
        recommender_status = CASE
          WHEN agg.max_severity >= 2 THEN 'red'
          WHEN volc.level >= 2 THEN 'red'
          WHEN lrs.tourists_today >= COALESCE(
            (SELECT capacity_per_day FROM location_safety_profile WHERE agent_route_id = lrs.agent_route_id),
            50
          ) THEN 'red'
          WHEN lrs.tourists_today >= COALESCE(
            (SELECT ROUND(capacity_per_day * 0.7) FROM location_safety_profile WHERE agent_route_id = lrs.agent_route_id),
            35
          ) THEN 'yellow'
          WHEN volc.level >= 1 THEN 'yellow'
          ELSE 'green'
        END,
        updated_at = NOW()
      FROM agg
      JOIN volc ON volc.lrs_id = agg.lrs_id
      WHERE agg.lrs_id = lrs.id
    `, [VOLCANO_STALE_DAYS, KFEGS_MAX_AGE_DAYS + 1]);
    // Safety Decision Ledger (925): одно событие на прогон, не на алерт — сам
    // SQL агрегатный (array_agg/MAX(severity) по CTE), per-alert разбивка
    // здесь не восстановима без переписывания запроса на построчный проход
    // (отдельная задача, не эта фаза). Честно фиксируем факт «пересчёт
    // прошёл», не «алерт X повлиял на точку Y» (§4.0).
    await appendSafetyEvent({
      entityId: null,
      eventType: 'route_or_tour_impact_calculated',
      actorType: 'system',
      actorId: 'safety-ingest.updateRealTimeStatus',
      details: { updated: r.rowCount ?? 0 },
    });
    return { updated: r.rowCount ?? 0 };
  } catch (e) {
    return { updated: 0, error: `real-time update failed: ${(e as Error).message}` };
  }
}

async function dispatchPushAlerts(): Promise<{ dispatched: number; suppressed: number; skipped: number; error?: string }> {
  // Если VAPID не настроен — не трогаем push_sent_at, следующий cron повторит после настройки
  if (!process.env.NEXT_PUBLIC_VAPID_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return { dispatched: 0, suppressed: 0, skipped: 0, error: 'VAPID keys not configured — push skipped' };
  }

  try {
    const { rows } = await pool.query<{
      id: number;
      alert_type: string;
      severity: number | null;
      magnitude: string | null;
      title: string;
      description: string | null;
    }>(`
      SELECT id, alert_type, severity, magnitude, title, description
      FROM external_alerts
      -- road_closure убран из push (решение владельца 06.09, отменяет #836):
      -- одно и то же ограничение приходит сразу с нескольких источников
      -- (kamgov, Минтур, ВК МЧС) с чуть разным текстом, контент-дедуп
      -- (seismic-parser.saveEvent) сверяет ДОСЛОВНО и разные формулировки не
      -- ловит — турист получал 5-6 push об одном и том же перекрытии. Порог
      -- «ехать/не ехать до выезда» не стоит риска, что людей раздражит спам
      -- и они удалят PWA: severity 1 остаётся видимым на /safety, но не в push.
      WHERE (severity >= 2 OR alert_type = 'tsunami_warning')
        AND push_sent_at IS NULL
        -- Уже заглушённые (миграция 957) из выборки уходят: решение по ним
        -- принято и записано, перебирать их каждые полчаса незачем.
        AND push_suppressed_at IS NULL
        -- Окно ретрая = срок действия алерта, а не произвольные 2 часа.
        -- Прежнее created_at > NOW() - '2 hours' создавало тупик с Watchdog
        -- (найдено 31.07 на живых 11 алертах): алерт, не доставленный за
        -- первые 2 часа (нет VAPID, крон лежал), выпадал из выборки НАВСЕГДА,
        -- а сторож честно кричал о нём ещё 7 суток — и починка ключей уже
        -- ничего не доставляла. expires_at задаётся источником по типу
        -- (цунами 12ч, опасное сейсмо 48ч, пожарная опасность/дороги до 7
        -- суток) — это то же определение «алерт ещё действует», по которому
        -- живёт вся система (idx_alerts_active).
        AND expires_at > NOW()
      ORDER BY severity DESC, created_at DESC
    `);

    let dispatched = 0;
    let suppressed = 0;
    for (const alert of rows) {
      // ── Один звонок на тип, пока прежний ещё действует (владелец 14.09) ──
      //
      // В 10:12 пришло ТРИ уведомления об одном паводке: экстренное
      // предупреждение, фраза про достижение опасного уровня и новость о
      // выезде спасателей в Соболево. Для человека это одно событие, для
      // конвейера — три строки: контент-дедуп saveEvent сверяет заголовок с
      // описанием, а у трёх разных постов МЧС они разные. Дальше каждая
      // строка получает свой `tag: alert-<id>`, а разные теги на телефоне не
      // заменяют друг друга — ложатся стопкой.
      //
      // Глушить можно потому, что второй push не нёс НИ ОДНОГО сведения,
      // которого не было в первом: заголовок называет тип и край целиком
      // («Паводок — Камчатка»), района в push нет, а инструкция у типа одна
      // на всех. Теряется звонок, не факт: алерт целиком остаётся на /safety.
      //
      // Два предохранителя, оба намеренные:
      //   • тяжесть ВЫШЕ прежней проходит всегда — иначе правило заглушило бы
      //     развитие обстановки, ради которого push и существует;
      //   • цунами не глушится НИКОГДА. Там повторное предупреждение может
      //     нести другую волну и другое время подхода, и цена ошибки в этом
      //     типе не такая, как в остальных.
      if (alert.alert_type !== 'tsunami_warning') {
        const louder = await pool.query<{ id: number }>(
          `SELECT id FROM external_alerts
            WHERE alert_type = $1
              AND id <> $2
              AND push_sent_at IS NOT NULL
              AND expires_at > NOW()
              AND COALESCE(severity, 0) >= COALESCE($3::int, 0)
            LIMIT 1`,
          [alert.alert_type, alert.id, alert.severity]
        );
        if ((louder.rowCount ?? 0) > 0) {
          const reason = `дубль по типу ${alert.alert_type}: push об алерте ${louder.rows[0].id} уже разослан и ещё действует`;
          await pool.query(
            `UPDATE external_alerts
                SET push_suppressed_at = NOW(), push_suppressed_reason = $2
              WHERE id = $1`,
            [alert.id, reason]
          );
          await appendSafetyEvent({
            entityId: String(alert.id),
            eventType: 'dedup_skipped',
            actorType: 'system',
            actorId: 'safety-ingest.dispatchPushAlerts',
            decisionReason: reason,
            details: { suppressed_by: louder.rows[0].id, alert_type: alert.alert_type },
          });
          suppressed++;
          continue;
        }
      }

      // Текст пуша — в lib/services/safety/push-copy. Лестница из трёх `?:`
      // стояла здесь и всё незнакомое отправляла как землетрясение с командой
      // «уходите вверх от воды»: вулкан, паводок и метель приходили человеку
      // чужой инструкцией. У неизвестного типа теперь инструкции нет вовсе —
      // придуманное действие в поле опаснее отсутствующего.
      const { title: pushTitle, body: pushBody } = pushCopy({
        alertType: alert.alert_type,
        title: alert.title,
        description: alert.description,
        magnitude: alert.magnitude != null ? Number(alert.magnitude) : null,
      });

      const result = await sendPushBroadcast({
        title: pushTitle,
        body: pushBody,
        url: '/safety',
        tag: `alert-${alert.id}`,
      });

      // Ноль подписок — доставлять некому, но алерт ещё действителен: НЕ
      // помечаем отправленным. Прежде total=0 проскакивал мимо проверки ниже
      // и push_sent_at ставился при нуле реальных доставок — ложь в данных,
      // прятавшая недоставку от сторожа. Первый же подписавшийся получит
      // предупреждение следующим прогоном, пока expires_at не вышел.
      if (result.total === 0) continue;

      // Если все подписки недостижимы — не фиксируем push_sent_at: следующий cron повторит.
      // ГРУБЫЙ ПОРОГ: severity>=2 (M6+) не гарантирует цунами-риск; tsunami_warning важнее.
      if (result.total > 0 && result.sent === 0) {
        // Молчаливый провал — оповестить администратора через Telegram
        const token  = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (token && chatId) {
          await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id:    chatId,
              text:       `КРИТИЧНО: Push-алерт не доставлен\n${alert.title}\nПодписок: ${result.total}, доставлено: 0, ошибок: ${result.failed}\nTуристы без предупреждения. Проверь VAPID и push_subscriptions.`,
              parse_mode: 'HTML',
            }),
          }).catch(() => {});
        }
        continue;
      }

      await pool.query('UPDATE external_alerts SET push_sent_at = NOW() WHERE id = $1', [alert.id]);
      // Safety Decision Ledger (925): рассылка широковещательная
      // (sendPushBroadcast идёт по ВСЕМ push_subscriptions) — событие честно
      // фиксирует «алерт разослан N подписчикам», а не «турист X уведомлён
      // об Y»: такой связи турист↔алерт в данных нет (§4.0).
      await appendSafetyEvent({
        entityId: String(alert.id),
        eventType: 'traveller_notified',
        actorType: 'system',
        actorId: 'safety-ingest.dispatchPushAlerts',
        details: { sent: result.sent, failed: result.failed, total: result.total },
      });
      dispatched++;
    }

    // `suppressed` отделён от `skipped` намеренно: «не стали слать, потому что
    // уже звонили об этом» и «не смогли доставить» — разные исходы, и свести
    // их в одно число значило бы спрятать одно за другим (§4.0).
    return { dispatched, suppressed, skipped: rows.length - dispatched - suppressed };
  } catch (e) {
    return { dispatched: 0, suppressed: 0, skipped: 0, error: `push dispatch failed: ${(e as Error).message}` };
  }
}

interface ParseResultSummary {
  events: unknown[];
  inserted: number;
  skipped: number;
  errors: string[];
  /** Сырых элементов до классификации (у FIRMS — термоточек). */
  rawItems?: number;
}

function buildResponse(
  ingestResult: {
    kbgsras: ParseResultSummary;
    eqkam: ParseResultSummary;
    usgs?: ParseResultSummary;
    mchs?: ParseResultSummary;
    news?: ParseResultSummary;
    minec?: ParseResultSummary;
    vk?: ParseResultSummary;
    max?: ParseResultSummary;
    firms?: ParseResultSummary;
    total_inserted: number;
  },
  rtStatus: { updated: number; error?: string },
  durationMs: number,
  pushResult?: { dispatched: number; suppressed?: number; skipped: number; error?: string },
  trigger: IngestTrigger = 'workflow_post',
  extras?: {
    delegated_to_heartbeat?: string[];
    telegramSeismicAgeMin?: number | null;
    knownDormantSources?: KnownDormantSource[];
    /** Каким путём heartbeat прочитал каналы t.me и почему не смог. */
    telegramFetch?: {
      kbgsras: { via: FetchVia | null; reason: string | null; direct_status: number | null };
      eqkam: { via: FetchVia | null; reason: string | null; direct_status: number | null };
      ingested: boolean;
      ingest_error: string | null;
    };
    /**
     * Таблица землетрясений emsd.ru (24.09): дошли ли, чем раскодировали,
     * сколько разобрали и куда делись строки. «Не дошли» обязано быть видно
     * здесь словами, а не только отсутствием новых толчков в ленте.
     */
    emsdFetch?: {
      url: string;
      reached: boolean;
      http_status: number | null;
      decoded_by: string | null;
      error: string | null;
      threshold_ml: number | null;
      rows_parsed: number | null;
      rows_rejected: number | null;
      inserted: number | null;
      skipped_expired: number | null;
      skipped_same_quake: number | null;
      problems: string[];
    };
  },
  // Уборка могла не пройти — тогда приходит причина, а не результат. Приём
  // от этого не страдает (см. safely), но молчать об ошибке нельзя: она
  // должна быть видна в ответе, иначе чистка перестанет работать незаметно.
  pruned?: PruneResult | { error: string },
  // Привязка дорожных предупреждений к точке: сколько привязано, сколько
  // осталось зонными и почему. Отказ приходит причиной, а не нулём — ноль
  // привязок и несработавшая привязка выглядят одинаково (§4.0).
  roadAnchors?: RoadAnchorResult | { error: string },
) {
  const errors = [
    ...ingestResult.kbgsras.errors,
    ...ingestResult.eqkam.errors,
    ...(ingestResult.mchs?.errors ?? []),
    ...(ingestResult.news?.errors ?? []),
    ...(ingestResult.minec?.errors ?? []),
    ...(ingestResult.vk?.errors ?? []),
    ...(ingestResult.max?.errors ?? []),
    ...(ingestResult.firms?.errors ?? []),
    ...(rtStatus.error ? [rtStatus.error] : []),
    ...(pushResult?.error ? [pushResult.error] : []),
    ...(pruned && 'error' in pruned ? [pruned.error] : []),
    ...(roadAnchors && 'error' in roadAnchors && roadAnchors.error ? [roadAnchors.error] : []),
  ];
  // Кто из двух планировщиков это и что случилось с каждым источником.
  // Разбор #883: `inserted: 0` у ВК читался как «канал МЧС молчит», а означал
  // «heartbeat положил те же события минутами раньше». Один и тот же источник
  // даёт разные числа в зависимости от того, кто пришёл первым, поэтому без
  // имени наблюдателя отчёт нечитаем в принципе.
  // Старые поля НЕ трогаем: воркфлоу и админка читают их, а это правка
  // наблюдаемости, не контракта.
  const sources = Object.fromEntries(
    ([
      ['kbgsras', ingestResult.kbgsras, undefined],
      ['eqkam', ingestResult.eqkam, undefined],
      ['usgs', ingestResult.usgs, undefined],
      ['mchs_rss', ingestResult.mchs, undefined],
      ['news', ingestResult.news, undefined],
      ['minec', ingestResult.minec, undefined],
      ['vk_mchs', ingestResult.vk, 'VK_SERVICE_TOKEN'],
      ['max_mchs', ingestResult.max, undefined],
      ['firms', ingestResult.firms, 'FIRMS_MAP_KEY'],
    ] as const).map(([key, result, requiresEnv]) => [
      key,
      sourceReport({
        result,
        requiresEnv,
        envValue: requiresEnv ? process.env[requiresEnv] : undefined,
      }),
    ]),
  );

  return Response.json({
    success: true,
    duration_ms: durationMs,
    trigger,
    trigger_label: TRIGGER_LABEL[trigger],
    sources,
    kbgsras: {
      events_found: ingestResult.kbgsras.events.length,
      inserted: ingestResult.kbgsras.inserted,
      skipped: ingestResult.kbgsras.skipped,
    },
    eqkam: {
      events_found: ingestResult.eqkam.events.length,
      inserted: ingestResult.eqkam.inserted,
      skipped: ingestResult.eqkam.skipped,
    },
    usgs: ingestResult.usgs ? {
      events_found: ingestResult.usgs.events.length,
      inserted: ingestResult.usgs.inserted,
      skipped: ingestResult.usgs.skipped,
    } : undefined,
    mchs: ingestResult.mchs ? {
      events_found: ingestResult.mchs.events.length,
      inserted: ingestResult.mchs.inserted,
      skipped: ingestResult.mchs.skipped,
    } : undefined,
    news: ingestResult.news ? {
      events_found: ingestResult.news.events.length,
      inserted: ingestResult.news.inserted,
      skipped: ingestResult.news.skipped,
    } : undefined,
    minec: ingestResult.minec ? {
      events_found: ingestResult.minec.events.length,
      inserted: ingestResult.minec.inserted,
      skipped: ingestResult.minec.skipped,
    } : undefined,
    vk: ingestResult.vk ? {
      events_found: ingestResult.vk.events.length,
      inserted: ingestResult.vk.inserted,
      skipped: ingestResult.vk.skipped,
    } : undefined,
    max: ingestResult.max ? {
      events_found: ingestResult.max.events.length,
      inserted: ingestResult.max.inserted,
      skipped: ingestResult.max.skipped,
    } : undefined,
    firms: ingestResult.firms ? {
      // configured отличает «ключа нет» от «термоточек нет»: без него нули
      // в ответе неразличимы, и проверка после настройки env превращается
      // в гадание (живой случай 28.07 — владелец добавил FIRMS_MAP_KEY,
      // а подтвердить работу по логу крона было нечем).
      configured: Boolean(process.env.FIRMS_MAP_KEY),
      hotspots: ingestResult.firms.rawItems ?? 0,
      events_found: ingestResult.firms.events.length,
      inserted: ingestResult.firms.inserted,
      skipped: ingestResult.firms.skipped,
    } : undefined,
    total_inserted: ingestResult.total_inserted,
    real_time_updated: rtStatus.updated,
    // Сколько протухших по жанру записей снято этим прогоном. Ноль здесь —
    // «проверено, чисто», а не «не проверяли»: поле есть всегда.
    pruned_genres: pruned ?? null,
    // Дорожные предупреждения: сколько получили точку привязки, сколько
    // остались зонными из-за неоднозначности имени и сколько — из-за того,
    // что такой точки у нас нет. Три исхода видны раздельно: «не привязали»
    // по разным причинам чинится по-разному.
    road_anchors: roadAnchors ?? null,
    push_alerts_dispatched: pushResult?.dispatched ?? 0,
    // Сколько звонков намеренно не сделано, потому что об этом типе уже
    // предупреждали и алерт ещё действует (миграция 957). Ноль тут значит
    // «дублей не было», а не «правило выключено» — поле есть всегда.
    push_alerts_suppressed: pushResult?.suppressed ?? 0,
    // #883 (A): источники, которых в этом ответе НЕТ числами, потому что их
    // обслуживает heartbeat-GET. Явный список вместо вводящих в заблуждение
    // «inserted: 0» после того, как heartbeat уже забрал те же посты.
    delegated_to_heartbeat: extras?.delegated_to_heartbeat,
    // Возраст последней доставки от воркфлоу, минут. Цифра в ответе, а не
    // только в алерте: чтобы задержку сейсмо-канала можно было ПОСМОТРЕТЬ,
    // не дожидаясь, пока она перевалит порог. `null` — доставок в журнале
    // нет; это разные вещи с «доставка была только что», и путать их нельзя.
    telegram_seismic_age_min: extras?.telegramSeismicAgeMin,
    // Принятое молчание (knownDormant в SAFETY_SOURCE_EXPECTATIONS): в Telegram
    // не уходит, в теле ответа обязано быть — «не шумим» ≠ «не знаем».
    known_dormant_sources: extras?.knownDormantSources ?? [],
    // Путь чтения каналов t.me: 'direct' | 'relay' | null с причиной. Есть
    // только у heartbeat — POST получает разметку готовой от раннера.
    telegram_fetch: extras?.telegramFetch,
    emsd_fetch: extras?.emsdFetch,
    errors: errors.length > 0 ? errors : undefined,
  });
}

/**
 * Выполнить служебный шаг так, чтобы он не мог уронить приём.
 *
 * Возвращает результат либо `{ error }`. Ошибка попадает в ответ и в лог, но
 * не наверх: тревога 14.08 показала, чем это кончается — падение уборки
 * стирает heartbeat, и монитор объявляет молчание сейсмо-приёма, хотя данные
 * приняты. Свидетельство работы дороже результата уборки.
 */
async function safely<T>(step: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[safety-ingest] шаг «${step}» не прошёл:`, error.slice(0, 200));
    return { error: `${step}: ${error.slice(0, 200)}` };
  }
}

/**
 * Запись heartbeat. Провал записи НЕ глотается молча.
 *
 * Здесь стояло `.catch(() => {})`. Это ровно тот дефект, который весь день
 * ловим, только в самом чувствительном месте: если INSERT не пройдёт, монитор
 * доложит «сейсмо-ингест молчит» — и снова покажет не туда, а в логе не
 * останется ни следа о том, что приём был и запись о нём не легла.
 *
 * Бросить наверх нельзя: тогда сбой журнала уронил бы приём, а это уже пройдено
 * (тревога 3805 минут). Поэтому ошибка называется в логе и не идёт дальше.
 */
function logHeartbeat(
  startedAt: Date,
  durationMs: number,
  totalInserted: number,
  pushDispatched: number,
  // Кто именно отработал. Без этого GET и POST в журнале НЕРАЗЛИЧИМЫ, и
  // вопрос «когда воркфлоу последний раз доставил сейсмику» неотвечаем в
  // принципе: строки одинаковые. А это и есть тот вопрос, задержку которого
  // мы весь день не видели — узнали о ней случайно, разбирая другой сбой.
  trigger: IngestTrigger,
  // Чем закончился прогон — по своим источникам (#1759). Здесь стояло
  // `'success'` безусловно: двадцать часов отказов на каждом прогоне, и
  // сторожа серии молчали, потому что читали этот статус. Теперь тот же
  // heartbeat говорит «частично» и «не смог», а cron-failing / cron-fruitless
  // ловят серию без единой новой проверки.
  status: IngestRunStatus,
  detail: readonly string[],
): void {
  pool.query(
    `INSERT INTO agent_run_history (agent_id, status, started_at, ended_at, duration_ms, items_created, metadata)
     VALUES ('safety-ingest', $5, $1, NOW(), $2, $3, $4)`,
    [
      startedAt,
      durationMs,
      totalInserted,
      JSON.stringify({
        push_dispatched: pushDispatched,
        trigger,
        // Ключи те же, что читает алерт cron-fruitless: skip_reason — класс,
        // empty_reasons[0] — адрес починки словами.
        ...(status === 'success' ? {} : { skip_reason: 'fetch_failed', empty_reasons: detail }),
      }),
      status,
    ],
  ).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[safety-ingest] heartbeat НЕ записан:', msg.slice(0, 200));
  });
}

/**
 * Минут с последней доставки сейсмики от воркфлоу. `null` — доставок в журнале
 * нет вовсе; это НЕ то же самое, что «только что», и путать их нельзя.
 *
 * Считается до записи heartbeat текущего прогона не по замыслу, а по факту
 * порядка вызовов — и это не важно: GET никогда не пишет workflow_post.
 */
async function telegramSeismicAgeMin(): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ last_post: string | null }>(
      `SELECT MAX(ended_at)::text AS last_post
         FROM agent_run_history
        WHERE agent_id = 'safety-ingest'
          AND metadata->>'trigger' = 'workflow_post'
          AND ended_at > NOW() - INTERVAL '7 days'`,
    );
    const last = rows[0]?.last_post ?? null;
    if (!last) return null;
    return Math.round((Date.now() - new Date(last).getTime()) / 60_000);
  } catch {
    return null;
  }
}

// GET — сервер сам тянет t.me (fallback если хостинг разблокирован)
export async function GET(req: Request) {
  const err = authError(req);
  if (err) return err;

  const t0 = Date.now();
  const startedAt = new Date(t0);
  // ── Сейсмика больше не ждёт планировщика GitHub (21.09) ─────────────────
  //
  // EQKam приходит страницей t.me, и до сегодня её приносил ТОЛЬКО воркфлоу.
  // Замер за 5,3 суток: 40 прогонов вместо 1524 при объявленных `*/5`;
  // медианный разрыв 188 минут при SLA, который сам воркфлоу объясняет так:
  // «цунами от 185 км ≈ 15 мин». Отказов не было — планировщик просто не
  // запускал, и потому не краснело ничего.
  //
  // Теперь страницу берёт heartbeat: напрямую, а при блокировочном отказе
  // через реле (infra/safety-relay — воркер, который 03.09 и доказал замером
  // чтение t.me). Воркфлоу остаётся вторым путём и ничего не теряет:
  // saveEvent идемпотентен по внешнему id, повторный разбор той же страницы
  // ничего не удваивает.
  //
  // ── Главный источник сейсмики — emsd.ru (24.09, решение владельца) ─────
  //
  // «нам нужно переключиться на этот ресурс, tg не активен у них». Таблица
  // «Последние 10 землетрясений Ml > 4,0» с главной КФ ФИЦ ЕГС РАН закрывает
  // диапазон M4.0–4.9, который шёл ТОЛЬКО из EQKam: USGS у нас спрашивается
  // с M5.0. Скачивается параллельно с остальными, а ЗАПИСЫВАЕТСЯ ниже, после
  // того как USGS уже записал своё: одновременная запись двух источников не
  // увидела бы друг друга, и один толчок стал бы двумя предупреждениями.
  const [ingestAllResult, firmsResult, kbgsrasPage, eqkamPage, emsdPage] = await Promise.all([
    ingestAll(),
    ingestFirmsWildfires(),
    fetchTelegramPreview('kbgsras'),
    fetchTelegramPreview('eqkam'),
    fetchEmsdPage(EMSD_QUAKES_URL),
  ]);
  const emsdResult: EmsdIngestResult | { error: string } | null = emsdPage.html !== null
    ? await safely('emsd-ingest', () => ingestEmsdQuakes(emsdPage.html as string))
    : null;
  const emsdOk = emsdResult !== null && !('error' in emsdResult);
  // Разбор — только когда есть ОБЕ страницы: ingestFromHtml принимает их
  // парой. Пустую строку вместо непрочитанной страницы подставлять нельзя —
  // парсер разберёт её как «канал прислал ноль постов», то есть выдаст
  // неудачу похода за молчанием канала (§4.0, разбор в source-health.ts).
  const telegramPages = kbgsrasPage.html !== null && eqkamPage.html !== null
    ? { kbgsras: kbgsrasPage.html, eqkam: eqkamPage.html }
    : null;
  const telegramResult = telegramPages
    ? await safely('telegram-ingest', () => ingestFromHtml(telegramPages.kbgsras, telegramPages.eqkam))
    : null;
  const telegramOk = telegramResult !== null && !('error' in telegramResult);
  const ingestResult = {
    ...ingestAllResult,
    firms: firmsResult,
    ...(telegramOk
      ? { kbgsras: telegramResult.kbgsras, eqkam: telegramResult.eqkam }
      : {}),
    ...(emsdOk ? { emsd: emsdResult } : {}),
    total_inserted: ingestAllResult.total_inserted + firmsResult.inserted
      + (telegramOk ? telegramResult.total_inserted : 0)
      + (emsdOk ? emsdResult.inserted : 0),
  };
  // Жанровые стражи применяются и к уже лежащему, а не только на приёме.
  // Перепись 11.08: 137 маршрутов из 421 стояли «Не сегодня» из-за одной
  // старой записи — репортаж «спасатели обеспечили безопасность тургруппы».
  // Страж этот глагол знает, но запись попала в базу раньше него, а ручная
  // чистка (миграция 846) шла своим списком глаголов на SQL и до «обеспечила
  // безопасность» не доросла. Два списка об одном правиле разошлись; теперь
  // список один, и хранилище догоняет само. ДО updateRealTimeStatus — иначе
  // он разложит отбракованное по точкам заново.
  //
  // ── Почему в try, а не голым await ─────────────────────────────────────
  //
  // Тревога 14.08: «сейсмо-ингест молчит 3805 минут» при SLA в пять. Приём
  // при этом мог отработать: heartbeat пишется НИЖЕ по коду, и любое падение
  // между приёмом и записью стирает не данные, а СВИДЕТЕЛЬСТВО того, что
  // приём был. Монитор видит тишину и объявляет молчание.
  //
  // Уборка не имеет права убивать приём. Сейсмика — безопасность людей,
  // чистка жанров — гигиена витрины; когда второе роняет первое, порядок
  // важности перевёрнут. Ошибка называется в ответе и не мешает работать.
  const pruned = await safely('prune', () => pruneRejectedGenres(query));
  // ДО раскладки по точкам: привязка даёт дорожному предупреждению
  // координаты, а радиусную ветку ALERT_MATCH_SQL включает именно их
  // наличие. После — предупреждение ушло бы по зоне ещё на один прогон.
  const roadAnchors = await safely('road-anchor', () => anchorRoadAlerts());
  const [rtStatus, pushResult] = await Promise.all([updateRealTimeStatus(), dispatchPushAlerts()]);
  const durationMs = Date.now() - t0;
  // Статус — по источникам, которыми владеет heartbeat (см. записи здоровья
  // ниже): kbgsras/eqkam сюда НЕ входят, t.me с хостинга гео-закрыт, и по ним
  // GET был бы «частичным» вечно.
  const getSources: RunSource[] = [
    // Телеграм-каналы входят в статус ТОЛЬКО когда мы за ними ходили. Не
    // смогли — это отдельная строка отчёта ниже (telegram_fetch), а не
    // «частичный прогон» навсегда: путь может быть закрыт не у нас.
    ...(telegramOk
      ? [
          { label: 'КБГС РАН (t.me)', errors: telegramResult.kbgsras.errors, inserted: telegramResult.kbgsras.inserted },
          { label: 'EQKam (t.me)', errors: telegramResult.eqkam.errors, inserted: telegramResult.eqkam.inserted },
        ]
      : []),
    // emsd.ru — как t.me: входит в статус, только когда за ним сходили.
    // Не дошли — строка emsd_fetch в ответе и тишина в здоровье источника,
    // а не «частичный прогон» из-за чужого сервера.
    ...(emsdOk
      ? [{ label: 'КФ ЕГС — землетрясения (emsd.ru)', errors: emsdResult.errors, inserted: emsdResult.inserted }]
      : []),
    { label: 'МЧС RSS (41.mchs)', errors: ingestResult.mchs.errors, inserted: ingestResult.mchs.inserted },
    { label: 'USGS', errors: ingestResult.usgs.errors, inserted: ingestResult.usgs.inserted },
    { label: 'новостные ленты', errors: ingestResult.news.errors, inserted: ingestResult.news.inserted },
    ...(process.env.VK_SERVICE_TOKEN
      ? [{ label: 'VK — МЧС Камчатки', errors: ingestResult.vk.errors, inserted: ingestResult.vk.inserted }]
      : []),
    ...(process.env.FIRMS_MAP_KEY
      ? [{ label: 'NASA FIRMS (пожары)', errors: firmsResult.errors, inserted: firmsResult.inserted }]
      : []),
  ];
  logHeartbeat(
    startedAt, durationMs, ingestResult.total_inserted, pushResult.dispatched, 'heartbeat_get',
    ingestRunStatus(getSources), ingestRunDetail(getSources),
  );
  // kbgsras и eqkam пишутся ТОЛЬКО когда heartbeat их реально прочитал.
  //
  // Прежде их здоровье принадлежало POST'у целиком, и довод был верен: t.me
  // с хостинга не читался, heartbeat писал бы «пусто» каждые пять минут, и
  // канал выглядел бы вечно свежим независимо от того, доставил воркфлоу или
  // нет. Теперь heartbeat читать УМЕЕТ — но не всегда сможет (реле может
  // отказать, t.me может закрыться плотнее), и довод обязан пережить это
  // изменение, а не исчезнуть вместе с ним.
  //
  // Поэтому условие ровно то же, только проверяется делом: сходили и
  // разобрали — владеем и пишем; не сходили — молчим, и last_run_at
  // по-прежнему означает «когда принёс воркфлоу». Запись «пусто» после
  // неудачного похода была бы той же ложью, от которой правило и защищало.
  const knownDormantGet = await watchSourceHealth(await Promise.all([
    ...(telegramOk
      ? [
          entryFor('kbgsras', 'КБГС РАН (сейсмо)', telegramResult.kbgsras),
          entryFor('eqkam', 'EMSD/EQKam (сейсмо)', telegramResult.eqkam),
        ]
      : []),
    // Записывается ТОЛЬКО после похода, который дошёл и разобрался. Таблица
    // по определению не пустеет, поэтому тишина здесь значит одно: не можем
    // прочитать emsd.ru. Её и ловит порог в SAFETY_SOURCE_EXPECTATIONS.
    ...(emsdOk ? [entryFor('emsd_quakes', 'КФ ЕГС — землетрясения (emsd.ru)', emsdResult)] : []),
    entryFor('mchs_rss', 'МЧС RSS (41.mchs)', ingestResult.mchs),
    entryFor('vk_mchs', 'VK — МЧС Камчатки', ingestResult.vk, { requiresEnv: 'VK_SERVICE_TOKEN' }),
    entryFor('max_mchs', 'MAX — МЧС Камчатки', undefined, { notFetched: true }),
    // FIRMS пишется в health для видимости в админке, но НЕ входит в
    // SAFETY_SOURCE_EXPECTATIONS: «нет термоточек» неотличимо от «нет пожаров»
    // (сезонность) — dead-алерт по тишине был бы ложью.
    entryFor('firms', 'NASA FIRMS (пожары)', firmsResult, { requiresEnv: 'FIRMS_MAP_KEY' }),
  ]));
  // GET дёргает супервизор start.js каждые 5 минут — он и есть heartbeat.
  return buildResponse(ingestResult, rtStatus, durationMs, pushResult, 'heartbeat_get',
    {
      telegramSeismicAgeMin: await telegramSeismicAgeMin(),
      knownDormantSources: knownDormantGet,
      // КАКИМ ПУТЁМ прочитаны каналы. Без этого через месяц не отличить
      // «читается из РФ» от «читается через Cloudflare», а это разные
      // зависимости и разные поломки — правило самого реле (scout-relay).
      // Причина неудачи стоит здесь же: «не смогли сходить» обязано быть
      // видно в теле, а не только по отсутствию цифр.
      telegramFetch: {
        kbgsras: { via: kbgsrasPage.via, reason: kbgsrasPage.reason, direct_status: kbgsrasPage.directStatus },
        eqkam: { via: eqkamPage.via, reason: eqkamPage.reason, direct_status: eqkamPage.directStatus },
        ingested: telegramOk,
        ingest_error: telegramResult !== null && 'error' in telegramResult ? telegramResult.error : null,
      },
      emsdFetch: {
        url: EMSD_QUAKES_URL,
        reached: emsdPage.html !== null,
        http_status: emsdPage.status,
        decoded_by: emsdPage.decodedBy,
        error: emsdPage.error ?? (emsdResult !== null && 'error' in emsdResult ? emsdResult.error : null),
        threshold_ml: emsdOk ? emsdResult.table.threshold : null,
        rows_parsed: emsdOk ? emsdResult.table.rows.length : null,
        rows_rejected: emsdOk ? emsdResult.table.rejected.length : null,
        inserted: emsdOk ? emsdResult.inserted : null,
        skipped_expired: emsdOk ? emsdResult.skippedExpired : null,
        skipped_same_quake: emsdOk ? emsdResult.skippedSameQuake : null,
        problems: emsdOk ? emsdResult.table.problems : [],
      },
    }, pruned, roadAnchors);
}

const HtmlBodySchema = z.object({
  kbgsras_html: z.string().min(1),
  eqkam_html: z.string().min(1),
  // Канал Минэкономразвития (законодательство/ограничения для туризма).
  // Optional: старый воркфлоу без этого поля продолжает работать.
  minec_html: z.string().optional(),
  /**
   * RSS kamgov.ru, скачанный раннером: с Timeweb гос-сайт не открывается, и
   * сервер каждый прогон писал «news feed unavailable: kamgov» при живом фиде.
   * Массив — у сайта несколько путей (/rss, /mintur/rss), дубли снимает разбор.
   */
  kamgov_xml: z.array(z.string().max(600_000)).max(5).optional(),
  // Канал ГУ МЧС Камчатки в MAX (max.ru/id4101120929_gos). У MAX нет открытого
  // read-API, поэтому раннер сам читает канал и присылает уже готовые посты
  // массивом. Сервер прогоняет каждый через classifyMchsItem — она и есть
  // фильтр мусора (приветствия/анонсы/учения → отброшены). Optional.
  max_items: z.array(z.object({
    id: z.string().min(1),
    text: z.string(),
    date: z.string().optional(),
    link: z.string().optional(),
  })).optional(),
});

// POST — GitHub Actions передаёт уже скачанный HTML (Telegram, geo-заблокирован
// для хостинга), сервер парсит его + сам тянет МЧС RSS и USGS напрямую (эти два
// источника не заблокированы — раньше POST-путь их вообще не вызывал, из-за
// чего волкан-алерты МЧС/#258 никогда не доходили через реальный cron, только
// через ручной GET).
/**
 * Склейка двух половин новостного конвейера: то, что сервер дотянулся сам, и
 * то, что принёс раннер. В ответе крона это по-прежнему один блок `news` —
 * дробить его на два было бы честно к коду и непонятно человеку.
 */
function mergeParseResults(a: ParseResult, b?: ParseResult): ParseResult {
  if (!b) return a;
  return {
    events: [...a.events, ...b.events],
    inserted: a.inserted + b.inserted,
    skipped: a.skipped + b.skipped,
    errors: [...a.errors, ...b.errors],
  };
}

export async function POST(req: Request) {
  const err = authError(req);
  if (err) return err;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = HtmlBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Missing kbgsras_html or eqkam_html' }, { status: 400 });
  }

  const t0 = Date.now();
  const startedAt = new Date(t0);
  const kamgovXmls = (parsed.data.kamgov_xml ?? []).filter((x) => x.trim().length > 0);
  // #883 (B): POST больше НЕ тянет то, что сервер достаёт сам, — VK API, USGS,
  // МЧС RSS и FIRMS обслуживает heartbeat (start.js -> GET каждые 5 минут;
  // его смерть ловит отдельная watchdog-проверка checkSeismicCronDead).
  // POST остаётся транспортом для того, что с хостинга недостижимо:
  // t.me-HTML, kamgov-XML, minec-HTML и посты MAX, принесённые раннером.
  // Двойная работа снята: у VK API лимиты, и лишний поход туда каждые ~час
  // бесплатным не был.
  const [telegramResult, newsFeedResult, kamgovResult, minecResult, maxResult] = await Promise.all([
    ingestFromHtml(parsed.data.kbgsras_html, parsed.data.eqkam_html),
    // kamgov с сервера не тянется НИКОГДА (гео-блок с Timeweb): его приносит
    // раннер XML'ом ниже. Прежнее условие «тянуть, если раннер не принёс»
    // било в стену 12 раз в час — столько POST'ов шлёт реле Cloudflare, а оно
    // kamgov не забирает по замыслу; каждый писал «news feed unavailable» и
    // держал статус прогона partial. Отсутствие XML — не повод пробовать с
    // того адреса, откуда не открывается по построению.
    ingestNewsFeeds(['kamgov']),
    kamgovXmls.length > 0
      ? ingestNewsFeedXmls(kamgovXmls, 'kamgov')
      : Promise.resolve(undefined),
    parsed.data.minec_html
      ? ingestTelegramNewsHtml(parsed.data.minec_html)
      : Promise.resolve(undefined),
    parsed.data.max_items && parsed.data.max_items.length > 0
      ? ingestMaxItems(parsed.data.max_items)
      : Promise.resolve(undefined),
  ]);
  // Одна половина новостей пришла с сервера, другая — с раннера; в ответе
  // это по-прежнему один блок `news`.
  const newsResult = mergeParseResults(newsFeedResult, kamgovResult);
  // #883 (A): делегированные источники в ответе POST не показываются числами —
  // «inserted: 0» после того, как heartbeat уже забрал те же посты, читалось
  // как «канал ничего не приносит» и стоило целого разбора. Вместо цифр —
  // явный список delegated_to_heartbeat в ответе.
  const ingestResult = {
    kbgsras: telegramResult.kbgsras,
    eqkam: telegramResult.eqkam,
    news: newsResult,
    minec: minecResult,
    max: maxResult,
    total_inserted: telegramResult.total_inserted
      + newsResult.inserted + (minecResult?.inserted ?? 0) + (maxResult?.inserted ?? 0),
  };
  // Жанровые стражи применяются и к уже лежащему, а не только на приёме.
  // Перепись 11.08: 137 маршрутов из 421 стояли «Не сегодня» из-за одной
  // старой записи — репортаж «спасатели обеспечили безопасность тургруппы».
  // Страж этот глагол знает, но запись попала в базу раньше него, а ручная
  // чистка (миграция 846) шла своим списком глаголов на SQL и до «обеспечила
  // безопасность» не доросла. Два списка об одном правиле разошлись; теперь
  // список один, и хранилище догоняет само. ДО updateRealTimeStatus — иначе
  // он разложит отбракованное по точкам заново.
  //
  // ── Почему в try, а не голым await ─────────────────────────────────────
  //
  // Тревога 14.08: «сейсмо-ингест молчит 3805 минут» при SLA в пять. Приём
  // при этом мог отработать: heartbeat пишется НИЖЕ по коду, и любое падение
  // между приёмом и записью стирает не данные, а СВИДЕТЕЛЬСТВО того, что
  // приём был. Монитор видит тишину и объявляет молчание.
  //
  // Уборка не имеет права убивать приём. Сейсмика — безопасность людей,
  // чистка жанров — гигиена витрины; когда второе роняет первое, порядок
  // важности перевёрнут. Ошибка называется в ответе и не мешает работать.
  const pruned = await safely('prune', () => pruneRejectedGenres(query));
  // ДО раскладки по точкам: привязка даёт дорожному предупреждению
  // координаты, а радиусную ветку ALERT_MATCH_SQL включает именно их
  // наличие. После — предупреждение ушло бы по зоне ещё на один прогон.
  const roadAnchors = await safely('road-anchor', () => anchorRoadAlerts());
  const [rtStatus, pushResult] = await Promise.all([updateRealTimeStatus(), dispatchPushAlerts()]);
  const durationMs = Date.now() - t0;
  // Статус — по источникам, которые приносит воркфлоу (те же, что в записях
  // здоровья ниже). Делегированные heartbeat'у сюда не входят по построению.
  const postSources: RunSource[] = [
    { label: 'КБГС РАН (сейсмо)', errors: telegramResult.kbgsras.errors, inserted: telegramResult.kbgsras.inserted },
    { label: 'EMSD/EQKam (сейсмо)', errors: telegramResult.eqkam.errors, inserted: telegramResult.eqkam.inserted },
    ...(maxResult ? [{ label: 'MAX — МЧС Камчатки', errors: maxResult.errors, inserted: maxResult.inserted }] : []),
  ];
  logHeartbeat(
    startedAt, durationMs, ingestResult.total_inserted, pushResult.dispatched, 'workflow_post',
    ingestRunStatus(postSources), ingestRunDetail(postSources),
  );
  // ЛОВУШКА из #883, решённая ПО ПОСТРОЕНИЮ: делегированные источники
  // (vk_mchs, mchs_rss, firms) здесь НЕ упоминаются вовсе — ни ok, ни
  // not_fetched. Отсутствие записи не трогает их строку в
  // safety_source_health: её каждые 5 минут обновляет heartbeat-GET, и
  // ложный КРИТ «живой канал МЧС мёртв» невозможен. Писать сюда
  // not_fetched было бы ровно той ошибкой, о которой предупреждала issue.
  const knownDormantPost = await watchSourceHealth(await Promise.all([
    entryFor('kbgsras', 'КБГС РАН (сейсмо)', telegramResult.kbgsras),
    entryFor('eqkam', 'EMSD/EQKam (сейсмо)', telegramResult.eqkam),
    // maxResult undefined = раннер не прислал постов (MAX-SPA пуст) → not_fetched.
    // MAX не делегирован: его умеет читать только раннер, heartbeat не покрывает.
    entryFor('max_mchs', 'MAX — МЧС Камчатки', maxResult),
  ]));
  // POST приходит из GitHub Actions с данными, которые сервер не достаёт сам.
  return buildResponse(ingestResult, rtStatus, durationMs, pushResult, 'workflow_post', {
    delegated_to_heartbeat: ['mchs_rss', 'usgs', 'vk_mchs', 'firms'],
    knownDormantSources: knownDormantPost,
  }, pruned, roadAnchors);
}

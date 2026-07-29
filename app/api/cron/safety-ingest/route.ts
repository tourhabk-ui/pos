import { z } from 'zod';
import { ingestAll, ingestFromHtml, ingestMchsAlerts, ingestUsgs, ingestNewsFeeds, ingestTelegramNewsHtml, ingestVkMchs, ingestMaxItems, ingestNewsFeedXmls, type ParseResult } from '@/lib/services/safety/seismic-parser';
import { ingestFirmsWildfires } from '@/lib/services/safety/wildfire-firms';
import { query } from '@/lib/database';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { sendPushBroadcast } from '@/lib/notifications/web-push';
import {
  SAFETY_SOURCE_EXPECTATIONS,
  recordSourceHealth,
  loadSourceHealth,
  evaluateDeadSources,
  dueForAlert,
  markAlerted,
  formatDeadSourceAlert,
  type SourceHealthEntry,
  type SourceStatus,
} from '@/lib/services/safety/source-health';

/** Статус источника по его результату: канал жив, если прислал хоть один сырой пост. */
function entryFor(
  key: string,
  label: string,
  result: ParseResult | undefined,
  opts: { requiresEnv?: string; notFetched?: boolean } = {},
): SourceHealthEntry {
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
  return { key, label, status, rawItems, inserted };
}

/** Записать здоровье источников и, если есть мёртвые (с дебаунсом), алертнуть в Telegram. */
async function watchSourceHealth(entries: SourceHealthEntry[]): Promise<void> {
  try {
    await recordSourceHealth(pool, entries);
    const rows = await loadSourceHealth(pool);
    const now = Date.now();
    const dead = evaluateDeadSources(rows, SAFETY_SOURCE_EXPECTATIONS, now);
    const due = dueForAlert(dead, rows, now);
    if (!due.length) return;

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
  } catch {
    // Мониторинг не должен ронять ingest — молча пропускаем.
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
  if (!timingSafeCompare(secret, cronSecret)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return null;
}

async function updateRealTimeStatus(): Promise<{ updated: number; error?: string }> {
  try {
    const r = await query(`
      UPDATE location_real_time_status lrs
      SET
        active_alerts = (
          -- DISTINCT: RSS-перепубликации одного предупреждения (разные guid,
          -- один текст) размножали алерт шестикратно на карточках маршрутов
          SELECT COALESCE(array_agg(DISTINCT ea.title), '{}')
          FROM external_alerts ea
          LEFT JOIN agent_route_knowledge ark ON ark.id = lrs.agent_route_id
          WHERE ea.expires_at > NOW()
            AND (
              ea.affected_zones IS NULL
              OR ea.affected_zones = '{}'
              OR ark.zone = ANY(ea.affected_zones)
            )
        ),
        alert_severity = (
          SELECT COALESCE(MAX(ea.severity), 0)
          FROM external_alerts ea
          LEFT JOIN agent_route_knowledge ark ON ark.id = lrs.agent_route_id
          WHERE ea.expires_at > NOW()
            AND (
              ea.affected_zones IS NULL
              OR ea.affected_zones = '{}'
              OR ark.zone = ANY(ea.affected_zones)
            )
        ),
        recommender_status = CASE
          WHEN (
            SELECT COALESCE(MAX(ea.severity), 0)
            FROM external_alerts ea
            LEFT JOIN agent_route_knowledge ark ON ark.id = lrs.agent_route_id
            WHERE ea.expires_at > NOW()
              AND (
                ea.affected_zones IS NULL
                OR ea.affected_zones = '{}'
                OR ark.zone = ANY(ea.affected_zones)
              )
          ) >= 2 THEN 'red'
          WHEN lrs.tourists_today >= COALESCE(
            (SELECT capacity_per_day FROM location_safety_profile WHERE agent_route_id = lrs.agent_route_id),
            50
          ) THEN 'red'
          WHEN lrs.tourists_today >= COALESCE(
            (SELECT ROUND(capacity_per_day * 0.7) FROM location_safety_profile WHERE agent_route_id = lrs.agent_route_id),
            35
          ) THEN 'yellow'
          ELSE 'green'
        END,
        updated_at = NOW()
    `);
    return { updated: r.rowCount ?? 0 };
  } catch (e) {
    return { updated: 0, error: `real-time update failed: ${(e as Error).message}` };
  }
}

async function dispatchPushAlerts(): Promise<{ dispatched: number; skipped: number; error?: string }> {
  // Если VAPID не настроен — не трогаем push_sent_at, следующий cron повторит после настройки
  if (!process.env.NEXT_PUBLIC_VAPID_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return { dispatched: 0, skipped: 0, error: 'VAPID keys not configured — push skipped' };
  }

  try {
    const { rows } = await pool.query<{
      id: number;
      alert_type: string;
      magnitude: string | null;
      title: string;
      description: string | null;
    }>(`
      SELECT id, alert_type, magnitude, title, description
      FROM external_alerts
      -- road_closure добавлен по issue #836: перекрытие подъезда приходит с
      -- severity 1 и под общий порог >=2 не попадало — турист узнавал о
      -- закрытой дороге, уже стоя перед шлагбаумом. Это единственный тип,
      -- где решение «ехать/не ехать» принимается ДО выезда.
      WHERE (severity >= 2 OR alert_type IN ('tsunami_warning', 'road_closure'))
        AND push_sent_at IS NULL
        AND created_at > NOW() - INTERVAL '2 hours'
      ORDER BY severity DESC, created_at DESC
    `);

    let dispatched = 0;
    for (const alert of rows) {
      const isTsunami = alert.alert_type === 'tsunami_warning';
      // fire_danger попадает сюда при severity>=2 (крупный очаг): без своей
      // ветки пуш назывался бы «Землетрясение M?» — чужой заголовок про пожар.
      const isFire = alert.alert_type === 'fire_danger';
      const isRoad = alert.alert_type === 'road_closure';
      const pushTitle = isTsunami
        ? 'УГРОЗА ЦУНАМИ — Камчатка'
        : isFire
          ? 'Природный пожар — Камчатка'
          : isRoad
            ? 'Ограничение проезда — Камчатка'
            : `Землетрясение M${alert.magnitude ? Number(alert.magnitude).toFixed(1) : '?'} — Камчатка`;
      const pushBody = isTsunami
        ? `${alert.description?.slice(0, 100) ?? alert.title}. Уходите вверх ≥30 м от воды.`
        : isFire
          ? `${alert.title}. Сверьте маршрут — возможны перекрытия и задымление.`
          : isRoad
            ? `${alert.title}. Проверьте подъезд до выезда.`
            : `${alert.title}. Если у берега — немедленно вверх ≥30 м.`;

      const result = await sendPushBroadcast({
        title: pushTitle,
        body: pushBody,
        url: '/safety',
        tag: `alert-${alert.id}`,
      });

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
      dispatched++;
    }

    return { dispatched, skipped: rows.length - dispatched };
  } catch (e) {
    return { dispatched: 0, skipped: 0, error: `push dispatch failed: ${(e as Error).message}` };
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
  pushResult?: { dispatched: number; skipped: number; error?: string },
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
  ];
  return Response.json({
    success: true,
    duration_ms: durationMs,
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
    push_alerts_dispatched: pushResult?.dispatched ?? 0,
    errors: errors.length > 0 ? errors : undefined,
  });
}

function logHeartbeat(startedAt: Date, durationMs: number, totalInserted: number, pushDispatched: number): void {
  pool.query(
    `INSERT INTO agent_run_history (agent_id, status, started_at, ended_at, duration_ms, items_created, metadata)
     VALUES ('safety-ingest', 'success', $1, NOW(), $2, $3, $4)`,
    [startedAt, durationMs, totalInserted, JSON.stringify({ push_dispatched: pushDispatched })],
  ).catch(() => {});
}

// GET — сервер сам тянет t.me (fallback если хостинг разблокирован)
export async function GET(req: Request) {
  const err = authError(req);
  if (err) return err;

  const t0 = Date.now();
  const startedAt = new Date(t0);
  const [ingestAllResult, firmsResult] = await Promise.all([ingestAll(), ingestFirmsWildfires()]);
  const ingestResult = {
    ...ingestAllResult,
    firms: firmsResult,
    total_inserted: ingestAllResult.total_inserted + firmsResult.inserted,
  };
  const [rtStatus, pushResult] = await Promise.all([updateRealTimeStatus(), dispatchPushAlerts()]);
  const durationMs = Date.now() - t0;
  logHeartbeat(startedAt, durationMs, ingestResult.total_inserted, pushResult.dispatched);
  await watchSourceHealth([
    entryFor('kbgsras', 'КБГС РАН (сейсмо)', ingestResult.kbgsras),
    entryFor('eqkam', 'EMSD/EQKam (сейсмо)', ingestResult.eqkam),
    entryFor('mchs_rss', 'МЧС RSS (41.mchs)', ingestResult.mchs),
    entryFor('vk_mchs', 'VK — МЧС Камчатки', ingestResult.vk, { requiresEnv: 'VK_SERVICE_TOKEN' }),
    entryFor('max_mchs', 'MAX — МЧС Камчатки', undefined, { notFetched: true }),
    // FIRMS пишется в health для видимости в админке, но НЕ входит в
    // SAFETY_SOURCE_EXPECTATIONS: «нет термоточек» неотличимо от «нет пожаров»
    // (сезонность) — dead-алерт по тишине был бы ложью.
    entryFor('firms', 'NASA FIRMS (пожары)', firmsResult, { requiresEnv: 'FIRMS_MAP_KEY' }),
  ]);
  return buildResponse(ingestResult, rtStatus, durationMs, pushResult);
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
  const [telegramResult, mchsResult, usgsResult, newsFeedResult, kamgovResult, minecResult, vkResult, maxResult, firmsResult] = await Promise.all([
    ingestFromHtml(parsed.data.kbgsras_html, parsed.data.eqkam_html),
    ingestMchsAlerts(),
    ingestUsgs(),
    // kamgov принесён раннером — сервер его не тянет и не считает мёртвым.
    ingestNewsFeeds(kamgovXmls.length > 0 ? ['kamgov'] : []),
    parsed.data.minec_html
      ? ingestTelegramNewsHtml(parsed.data.minec_html)
      : Promise.resolve(undefined),
    kamgovXmls.length > 0
      ? ingestNewsFeedXmls(kamgovXmls, 'kamgov')
      : Promise.resolve(undefined),
    ingestVkMchs(),
    parsed.data.max_items && parsed.data.max_items.length > 0
      ? ingestMaxItems(parsed.data.max_items)
      : Promise.resolve(undefined),
    ingestFirmsWildfires(),
  ]);
  // Одна половина новостей пришла с сервера, другая — с раннера; в ответе
  // это по-прежнему один блок `news`.
  const newsResult = mergeParseResults(newsFeedResult, kamgovResult);
  const ingestResult = {
    kbgsras: telegramResult.kbgsras,
    eqkam: telegramResult.eqkam,
    mchs: mchsResult,
    usgs: usgsResult,
    news: newsResult,
    minec: minecResult,
    vk: vkResult,
    max: maxResult,
    firms: firmsResult,
    total_inserted: telegramResult.total_inserted + mchsResult.inserted + usgsResult.inserted
      + newsResult.inserted + (minecResult?.inserted ?? 0) + vkResult.inserted + (maxResult?.inserted ?? 0)
      + firmsResult.inserted,
  };
  const [rtStatus, pushResult] = await Promise.all([updateRealTimeStatus(), dispatchPushAlerts()]);
  const durationMs = Date.now() - t0;
  logHeartbeat(startedAt, durationMs, ingestResult.total_inserted, pushResult.dispatched);
  await watchSourceHealth([
    entryFor('kbgsras', 'КБГС РАН (сейсмо)', telegramResult.kbgsras),
    entryFor('eqkam', 'EMSD/EQKam (сейсмо)', telegramResult.eqkam),
    entryFor('mchs_rss', 'МЧС RSS (41.mchs)', mchsResult),
    entryFor('vk_mchs', 'VK — МЧС Камчатки', vkResult, { requiresEnv: 'VK_SERVICE_TOKEN' }),
    // maxResult undefined = раннер не прислал постов (MAX-SPA пуст) → not_fetched.
    entryFor('max_mchs', 'MAX — МЧС Камчатки', maxResult),
    // FIRMS: в health для видимости, вне EXPECTATIONS (сезонная пустота — норма).
    entryFor('firms', 'NASA FIRMS (пожары)', firmsResult, { requiresEnv: 'FIRMS_MAP_KEY' }),
  ]);
  return buildResponse(ingestResult, rtStatus, durationMs, pushResult);
}

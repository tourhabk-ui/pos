import { z } from 'zod';
import { ingestAll, ingestFromHtml } from '@/lib/services/seismic-parser';
import { query } from '@/lib/database';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { sendPushBroadcast } from '@/lib/notifications/web-push';

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
          SELECT COALESCE(array_agg(ea.title), '{}')
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

async function dispatchPushAlerts(): Promise<number> {
  try {
    const { rows } = await pool.query<{ id: number; title: string; magnitude: string | null }>(
      `SELECT id, title, magnitude FROM external_alerts
       WHERE push_sent_at IS NULL
         AND magnitude >= 5.5
         AND created_at > NOW() - INTERVAL '3 hours'
         AND alert_type IN ('earthquake', 'tsunami_warning', 'volcanic_eruption')
       ORDER BY magnitude DESC NULLS LAST
       LIMIT 10`,
    );
    let sent = 0;
    for (const alert of rows) {
      const mag = alert.magnitude ? Number(alert.magnitude).toFixed(1) : '5.5+';
      await sendPushBroadcast({
        title: `⚠️ Землетрясение M${mag}`,
        body: `${alert.title}. Если вы на берегу — немедленно уходите вверх ≥30 м.`,
        url: '/safety',
      });
      await pool.query('UPDATE external_alerts SET push_sent_at = NOW() WHERE id = $1', [alert.id]);
      sent++;
    }
    return sent;
  } catch {
    return 0;
  }
}

function buildResponse(
  ingestResult: { kbgsras: { events: unknown[]; inserted: number; skipped: number; errors: string[] }; eqkam: { events: unknown[]; inserted: number; skipped: number; errors: string[] }; usgs?: { events: unknown[]; inserted: number; skipped: number; errors: string[] }; total_inserted: number },
  rtStatus: { updated: number; error?: string },
  durationMs: number,
  pushed = 0,
) {
  const errors = [
    ...ingestResult.kbgsras.errors,
    ...ingestResult.eqkam.errors,
    ...(rtStatus.error ? [rtStatus.error] : []),
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
    total_inserted: ingestResult.total_inserted,
    real_time_updated: rtStatus.updated,
    pushed_alerts: pushed,
    errors: errors.length > 0 ? errors : undefined,
  });
}

// GET — сервер сам тянет t.me (fallback если хостинг разблокирован)
export async function GET(req: Request) {
  const err = authError(req);
  if (err) return err;

  const t0 = Date.now();
  const ingestResult = await ingestAll();
  const [rtStatus, pushed] = await Promise.all([updateRealTimeStatus(), dispatchPushAlerts()]);
  return buildResponse(ingestResult, rtStatus, Date.now() - t0, pushed);
}

const HtmlBodySchema = z.object({
  kbgsras_html: z.string().min(1),
  eqkam_html: z.string().min(1),
});

// POST — GitHub Actions передаёт уже скачанный HTML, сервер только парсит
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
  const ingestResult = await ingestFromHtml(parsed.data.kbgsras_html, parsed.data.eqkam_html);
  const [rtStatus, pushed] = await Promise.all([updateRealTimeStatus(), dispatchPushAlerts()]);
  return buildResponse(ingestResult, rtStatus, Date.now() - t0, pushed);
}

/**
 * Здоровье ДОСТАВКИ тревог: «тревога создана → доставлена» одним взглядом.
 *
 * ── Зачем (#1485, аудит 01.09) ────────────────────────────────────────────
 *
 * Сейсмо- и вулканические тревоги формировались и не доходили ни до кого:
 * push-канал был пуст, сейсмо-крон отставал на четыре часа. Снаружи это
 * выглядело как «система безопасности работает» — хуже, чем её отсутствие.
 * Watchdog это видит раз в полчаса и пишет в Telegram; здесь то же самое
 * стоит на /hub/admin/health, где смотрят глазами.
 *
 * ── Четыре числа, у каждого три исхода (§4.0) ─────────────────────────────
 *
 * Каждая величина спрашивается своим запросом и в своём try: отказ одного
 * не обнуляет остальные и не превращается в «ноль». null значит «не смогли
 * посчитать», и `reason` говорит почему. Сводный `ok` тоже троичный: пока
 * хоть одно число неизвестно, здоровье неизвестно, а не хорошее.
 *
 *   subscriptions — сколько браузеров вообще могут получить push;
 *   last_ingest   — когда сейсмо-приём бегал последний раз и чем кончился
 *                   (agent_run_history, agentId из cron-registry);
 *   notified_24h  — сколько тревог за сутки реально разослано и на сколько
 *                   подписок (события traveller_notified журнала решений);
 *   undelivered   — опасные тревоги старше 30 минут без push_sent_at — те же
 *                   условия, что у Watchdog, чтобы два монитора не спорили.
 */
import { pool } from '@/lib/db-pool';

export const SAFETY_INGEST_AGENT_ID = 'safety-ingest';
/** Сейсмо-приём по расписанию — каждые 5 минут; больше 30 — уже отставание. */
export const INGEST_STALE_MINUTES = 30;

export interface AlertDeliveryHealth {
  subscriptions: { count: number | null; reason: string | null };
  last_ingest: {
    at: string | null;
    status: string | null;
    age_minutes: number | null;
    stale: boolean | null;
    reason: string | null;
  };
  notified_24h: { alerts: number | null; sent: number | null; failed: number | null; reason: string | null };
  undelivered: { count: number | null; reason: string | null };
  /** true — всё измерено и хорошо; false — измерено и плохо; null — не всё измерено. */
  ok: boolean | null;
}

function sqlstate(err: unknown): string {
  return typeof err === 'object' && err && 'code' in err ? String((err as { code: unknown }).code) : '?';
}

function failed(name: string, err: unknown): string {
  console.error(`[alert-delivery-health] ${name} failed, SQLSTATE ${sqlstate(err)}:`, err instanceof Error ? err.message : err);
  return 'запрос не выполнился — см. лог сервера';
}

const toInt = (v: unknown): number => {
  const n = parseInt(String(v ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
};

export async function computeAlertDeliveryHealth(now: Date = new Date()): Promise<AlertDeliveryHealth> {
  const out: AlertDeliveryHealth = {
    subscriptions: { count: null, reason: null },
    last_ingest: { at: null, status: null, age_minutes: null, stale: null, reason: null },
    notified_24h: { alerts: null, sent: null, failed: null, reason: null },
    undelivered: { count: null, reason: null },
    ok: null,
  };

  try {
    const r = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM push_subscriptions`);
    out.subscriptions.count = toInt(r.rows[0]?.n);
  } catch (err) {
    out.subscriptions.reason = failed('subscriptions', err);
  }

  try {
    const r = await pool.query<{ started_at: Date; status: string }>(
      `SELECT started_at, status FROM agent_run_history
        WHERE agent_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [SAFETY_INGEST_AGENT_ID],
    );
    const row = r.rows[0];
    if (!row) {
      // Нет ни одного прогона — это факт, а не отказ запроса.
      out.last_ingest.reason = 'ни одного прогона в истории';
      out.last_ingest.stale = true;
    } else {
      const at = new Date(row.started_at);
      const age = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
      out.last_ingest = { at: at.toISOString(), status: row.status, age_minutes: age, stale: age > INGEST_STALE_MINUTES, reason: null };
    }
  } catch (err) {
    out.last_ingest.reason = failed('last_ingest', err);
  }

  try {
    const r = await pool.query<{ alerts: string; sent: string; failed: string }>(
      `SELECT COUNT(*)::text AS alerts,
              COALESCE(SUM((details->>'sent')::int), 0)::text AS sent,
              COALESCE(SUM((details->>'failed')::int), 0)::text AS failed
         FROM safety_decision_events
        WHERE event_type = 'traveller_notified'
          AND created_at > NOW() - INTERVAL '24 hours'`,
    );
    const row = r.rows[0];
    out.notified_24h = { alerts: toInt(row?.alerts), sent: toInt(row?.sent), failed: toInt(row?.failed), reason: null };
  } catch (err) {
    out.notified_24h.reason = failed('notified_24h', err);
  }

  try {
    const r = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM external_alerts
        WHERE push_sent_at IS NULL
          AND severity >= 2
          AND created_at < NOW() - INTERVAL '30 minutes'
          AND expires_at > NOW()`,
    );
    out.undelivered.count = toInt(r.rows[0]?.n);
  } catch (err) {
    out.undelivered.reason = failed('undelivered', err);
  }

  const measured =
    out.subscriptions.count !== null &&
    out.last_ingest.stale !== null &&
    out.notified_24h.alerts !== null &&
    out.undelivered.count !== null;
  if (measured) {
    out.ok =
      (out.subscriptions.count as number) > 0 &&
      out.last_ingest.stale === false &&
      (out.undelivered.count as number) === 0;
  }
  return out;
}

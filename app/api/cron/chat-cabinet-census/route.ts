/**
 * GET /api/cron/chat-cabinet-census?days=14 — пользуются ли кабинетом в чате.
 * Bearer CRON_SECRET. Только читает.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Слово владельца 30.10: «счёт: пользуются ли». Кабинет в чате (1351) сделан
 * на догадке, что партнёру удобнее кнопки в мессенджере, чем сайт. Проверить
 * догадку можно только числом нажатий — а до 1353 его не было нигде: чтения
 * («Входящие», карточка, клиенты) не оставляют строк, записи (звонок, задача)
 * лежат в CRM вперемешку с сайтом и помощником.
 *
 * ── Что здесь есть ─────────────────────────────────────────────────────────
 *
 *  - нажатия за окно по действию, месту (владелец чата карточки / менеджер
 *    команды), каналу и исходу (`chat_cabinet_usage`, 1353);
 *  - по дням: нажатия и сколько карточек нажимали;
 *  - по карточкам: витринное имя (оно и так на сайте), категория, нажатия,
 *    последний день — для пилота («пользуется ли оператор»);
 *  - знаменатель: сколько карточек вообще могут нажимать (чат привязан,
 *    категория с кабинетом) и сколько менеджеров с привязанным чатом;
 *  - ежедневная сводка: по дням и исходам (`crm_chat_digests`, 1351) и
 *    выбранное время (`chat_cabinet_settings`; карточка без строки — «утром»).
 *
 * Текстов, чатов, имён клиентов и людей нет: счётчик их и не хранит.
 * Приговора нет: «нужен ли кабинет» решает человек по числам.
 * Раздел, который не прочитался, говорит об отказе словами — не пустотой (§4.0).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { kamchatkaDate, shiftDate } from '@/lib/analytics/kamchatka-day';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = raw === null ? def : parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

type Section<T> = { refused: false; data: T } | { refused: true; error: string };

async function section<T>(name: string, run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { refused: false, data: await run() };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
    console.error(`[chat-cabinet-census] ${name}: чтение не удалось, SQLSTATE ${code}`);
    return { refused: true, error: `чтение не удалось, SQLSTATE ${code}` };
  }
}

/** Карточки, у которых кабинет в чате может быть: чат привязан, категория с кабинетом. */
export const CABINET_PARTNERS_SQL = `
  SELECT COUNT(*)::int AS partners,
         COUNT(*) FILTER (WHERE max_chat_id IS NOT NULL)::int AS with_max,
         COUNT(*) FILTER (WHERE telegram_chat_id IS NOT NULL)::int AS with_telegram
    FROM partners
   WHERE (max_chat_id IS NOT NULL OR telegram_chat_id IS NOT NULL)
     AND category IN ('operator', 'transfer', 'stay', 'guide')`;

export const CABINET_MEMBERS_SQL = `
  SELECT COUNT(*)::int AS members
    FROM operator_members
   WHERE status = 'active' AND user_id IS NOT NULL
     AND (max_chat_id IS NOT NULL OR telegram_chat_id IS NOT NULL)`;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  const days = clampInt(request.nextUrl.searchParams.get('days'), 14, 1, 90);
  const today = kamchatkaDate(new Date());
  const from = shiftDate(today, -(days - 1));

  const [byAction, byDay, byPartner, reachable, members, digests, settings] = await Promise.all([
    section('нажатия по действию', async () => (await pool.query<{
      action: string; seat: string; channel: string; ok: number; failed: number;
    }>(
      `SELECT action, seat, channel,
              COALESCE(SUM(n) FILTER (WHERE outcome = 'ok'), 0)::int AS ok,
              COALESCE(SUM(n) FILTER (WHERE outcome = 'failed'), 0)::int AS failed
         FROM chat_cabinet_usage
        WHERE day >= $1::date
        GROUP BY action, seat, channel
        ORDER BY SUM(n) DESC, action`,
      [from],
    )).rows),
    section('нажатия по дням', async () => (await pool.query<{ day: string; presses: number; partners: number }>(
      `SELECT day::text AS day, SUM(n)::int AS presses, COUNT(DISTINCT partner_id)::int AS partners
         FROM chat_cabinet_usage
        WHERE day >= $1::date
        GROUP BY day
        ORDER BY day`,
      [from],
    )).rows),
    section('нажатия по карточкам', async () => (await pool.query<{
      partner_id: string; name: string; category: string; owner: number; member: number; last_day: string;
    }>(
      `SELECT u.partner_id::text AS partner_id, COALESCE(p.company_name, p.name) AS name, p.category,
              COALESCE(SUM(u.n) FILTER (WHERE u.seat = 'owner'), 0)::int AS owner,
              COALESCE(SUM(u.n) FILTER (WHERE u.seat = 'member'), 0)::int AS member,
              MAX(u.day)::text AS last_day
         FROM chat_cabinet_usage u
         JOIN partners p ON p.id = u.partner_id
        WHERE u.day >= $1::date
        GROUP BY u.partner_id, p.company_name, p.name, p.category
        ORDER BY SUM(u.n) DESC, u.partner_id`,
      [from],
    )).rows),
    section('карточки с привязанным чатом', async () => (await pool.query<{
      partners: number; with_max: number; with_telegram: number;
    }>(CABINET_PARTNERS_SQL)).rows[0] ?? { partners: 0, with_max: 0, with_telegram: 0 }),
    section('менеджеры с привязанным чатом', async () => (await pool.query<{ members: number }>(CABINET_MEMBERS_SQL)).rows[0]?.members ?? 0),
    section('сводки по дням', async () => (await pool.query<{ day: string; channel: string; n: number }>(
      `SELECT digest_date::text AS day, channel, COUNT(*)::int AS n
         FROM crm_chat_digests
        WHERE digest_date >= $1::date
        GROUP BY digest_date, channel
        ORDER BY digest_date, channel`,
      [from],
    )).rows),
    section('время сводки', async () => (await pool.query<{ digest: string; n: number }>(
      `SELECT digest, COUNT(*)::int AS n FROM chat_cabinet_settings GROUP BY digest ORDER BY digest`,
    )).rows),
  ]);

  const totals = !byAction.refused
    ? byAction.data.reduce((acc, r) => ({ ok: acc.ok + r.ok, failed: acc.failed + r.failed }), { ok: 0, failed: 0 })
    : null;

  return NextResponse.json({
    success: true,
    days,
    from,
    to: today,
    totals,
    partners_pressing: byPartner.refused ? null : byPartner.data.length,
    by_action: byAction,
    by_day: byDay,
    by_partner: byPartner,
    reachable_partners: reachable,
    reachable_members: members,
    digests,
    digest_settings: { note: 'карточка без строки получает сводку утром', rows: settings },
  });
}

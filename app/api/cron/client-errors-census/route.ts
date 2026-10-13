/**
 * GET /api/cron/client-errors-census?days=1&prune=1&notify=1 — перепись
 * ловушки ошибок браузера (решение владельца 13.10: «ловушку»).
 *
 * Отвечает на вопрос «какие баги ловят люди на сайте», которого до 13.10
 * было не задать: ошибки в браузере нигде не записывались. Группы — по
 * отпечатку (fingerprint), а не по тексту: одна ошибка у ста человек — одна
 * строка. Внешние, свои (cookie владельца) и боты считаются порознь, как в
 * page_views: владелец сам ходит по сайту и ловит баги — его ошибки это
 * отдельный список, а не шум.
 *
 * Три исхода у каждого замера (§4.0): число, или «не смог» в failed_measures
 * — пустой список групп при упавшем запросе не выдаётся за «ошибок нет».
 *
 * ?prune=1 — удалить строки старше RETENTION_DAYS (единственная запись
 * переписи; без параметра — только чтение).
 * ?notify=1 — дайджест в Telegram (tgSend возвращает исход; «не ушёл» —
 * в ответе, не в тишине). Без внешних ошибок дайджест не шлётся: тишина
 * означает «ошибок нет», а не «не спросили» — это различимо по ответу.
 *
 * Запускает cron-client-errors.yml раз в сутки. Сторож:
 * tests/unit/client-errors-census.test.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { tgSend } from '@/lib/notifications/tg-send';
import { escapeHtml } from '@/lib/text/escape-html';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const RETENTION_DAYS = 30;
const SCOPE = 'client-errors-census';

interface Measured<T> { value: T | null; failed: string | null }

async function measure<T>(name: string, fn: () => Promise<T>): Promise<Measured<T>> {
  try {
    return { value: await fn(), failed: null };
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error(`[${SCOPE}] замер «${name}» не удался:`, e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return { value: null, failed: `${name}: ${e?.code ?? 'ERR'} ${e?.message ?? 'неизвестная ошибка'}` };
  }
}

export interface ErrorGroup {
  fingerprint: string;
  kind: string;
  message: string;
  n: number;
  visitor_days: number;
  paths: string[];
  from_phone: number;
  offline_n: number;
  builds: string[];
  first_seen: string;
  last_seen: string;
}

interface GroupRow {
  fingerprint: string; kind: string; message: string; n: string; visitor_days: string;
  paths: string[] | null; from_phone: string; offline_n: string; builds: string[] | null; first_seen: string; last_seen: string;
}

const num = (v: string | number | null | undefined) => Number(v ?? 0);

function toGroup(r: GroupRow): ErrorGroup {
  return {
    fingerprint: r.fingerprint, kind: r.kind, message: r.message,
    n: num(r.n), visitor_days: num(r.visitor_days), paths: r.paths ?? [],
    from_phone: num(r.from_phone), offline_n: num(r.offline_n), builds: r.builds ?? [],
    first_seen: r.first_seen, last_seen: r.last_seen,
  };
}

const GROUP_SELECT = `
  SELECT fingerprint, kind, MIN(message) AS message, COUNT(*) AS n,
         COUNT(DISTINCT visitor_hash) AS visitor_days,
         (array_agg(DISTINCT path))[1:3] AS paths,
         COUNT(*) FILTER (WHERE device = 'phone') AS from_phone,
         COUNT(*) FILTER (WHERE online = FALSE) AS offline_n,
         array_agg(DISTINCT build) FILTER (WHERE build IS NOT NULL) AS builds,
         to_char(MIN(created_at), 'YYYY-MM-DD HH24:MI') AS first_seen,
         to_char(MAX(created_at), 'YYYY-MM-DD HH24:MI') AS last_seen
    FROM client_errors
   WHERE created_at >= NOW() - ($1 || ' days')::interval`;

export interface Totals { rows: number; external: number; self: number; bot: number; visitor_days: number }

/** Текст дайджеста для Telegram (HTML): цифры и верх списка, без стеков. */
export function digestText(days: number, totals: Totals, groups: ErrorGroup[], selfGroups: ErrorGroup[]): string {
  const lines: string[] = [];
  lines.push(`<b>Ошибки в браузере за ${days} дн.</b>: внешних ${totals.external} (человеко-дней ${totals.visitor_days}), своих ${totals.self}, ботов ${totals.bot}`);
  groups.slice(0, 5).forEach((g, i) => {
    const where = g.paths.slice(0, 2).map(escapeHtml).join(', ');
    const fromPhone = g.from_phone ? `, с телефона ${g.from_phone}` : '';
    lines.push(`${i + 1}. ${escapeHtml(g.message.slice(0, 160))} — ${g.n} раз, человеко-дней ${g.visitor_days}${fromPhone}; ${where}`);
  });
  if (selfGroups.length) {
    lines.push(`<b>Свои</b>: ${selfGroups.slice(0, 3).map((g) => `${escapeHtml(g.message.slice(0, 80))} (${g.n})`).join('; ')}`);
  }
  return lines.join('\n').slice(0, 3500);
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const daysRaw = Number(req.nextUrl.searchParams.get('days') ?? '1');
  const days = Number.isFinite(daysRaw) && daysRaw >= 1 && daysRaw <= 30 ? Math.floor(daysRaw) : 1;
  const prune = req.nextUrl.searchParams.get('prune') === '1';
  const notify = req.nextUrl.searchParams.get('notify') === '1';
  const p = [String(days)];

  const [totals, groups, selfGroups, byPath, marks] = await Promise.all([
    measure('totals', async () => (await pool.query<{ rows: string; external: string; self: string; bot: string; visitor_days: string }>(
      `SELECT COUNT(*) AS rows,
              COUNT(*) FILTER (WHERE NOT is_self AND NOT is_bot) AS external,
              COUNT(*) FILTER (WHERE is_self) AS self,
              COUNT(*) FILTER (WHERE is_bot) AS bot,
              COUNT(DISTINCT visitor_hash) FILTER (WHERE NOT is_self AND NOT is_bot) AS visitor_days
         FROM client_errors WHERE created_at >= NOW() - ($1 || ' days')::interval`, p)).rows[0]),
    measure('groups', async () => (await pool.query<GroupRow>(
      `${GROUP_SELECT} AND NOT is_self AND NOT is_bot GROUP BY 1, 2 ORDER BY COUNT(*) DESC LIMIT 30`, p)).rows.map(toGroup)),
    measure('self_groups', async () => (await pool.query<GroupRow>(
      `${GROUP_SELECT} AND is_self GROUP BY 1, 2 ORDER BY COUNT(*) DESC LIMIT 10`, p)).rows.map(toGroup)),
    measure('by_path', async () => (await pool.query<{ path: string; n: string; groups: string }>(
      `SELECT path, COUNT(*) AS n, COUNT(DISTINCT fingerprint) AS groups
         FROM client_errors WHERE created_at >= NOW() - ($1 || ' days')::interval AND NOT is_self AND NOT is_bot
        GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 10`, p)).rows.map((r) => ({ path: r.path, n: num(r.n), groups: num(r.groups) }))),
    measure('marks', async () => (await pool.query<{ rows_total: string; since: string | null }>(
      `SELECT COUNT(*) AS rows_total, to_char(MIN(created_at), 'YYYY-MM-DD') AS since FROM client_errors`)).rows[0]),
  ]);

  const pruned = prune
    ? await measure('prune', async () => (await pool.query(
        `DELETE FROM client_errors WHERE created_at < NOW() - ($1 || ' days')::interval`, [String(RETENTION_DAYS)])).rowCount ?? 0)
    : null;

  const failed = ([['totals', totals], ['groups', groups], ['self_groups', selfGroups], ['by_path', byPath], ['marks', marks]] as const)
    .filter(([, m]) => m.failed !== null)
    .map(([, m]) => m.failed as string);
  if (pruned?.failed) failed.push(pruned.failed);

  const t: Totals | null = totals.value ? {
    rows: num(totals.value.rows), external: num(totals.value.external), self: num(totals.value.self),
    bot: num(totals.value.bot), visitor_days: num(totals.value.visitor_days),
  } : null;

  let notifyOutcome: { sent: boolean; reason: string } | null = null;
  if (notify) {
    if (!t || !groups.value) notifyOutcome = { sent: false, reason: 'перепись не сосчиталась — слать нечего' };
    else if (t.external === 0 && t.self === 0) notifyOutcome = { sent: false, reason: 'ошибок нет' };
    else {
      const out = await tgSend(SCOPE, digestText(days, t, groups.value, selfGroups.value ?? []));
      notifyOutcome = out.ok ? { sent: true, reason: 'доставлен' } : { sent: false, reason: out.reason };
    }
  }

  return NextResponse.json({
    ok: failed.length === 0,
    window_days: days,
    generated_at: new Date().toISOString(),
    totals: t,
    groups: groups.value,
    self_groups: selfGroups.value,
    by_path: byPath.value,
    marks: marks.value ? { rows_total: num(marks.value.rows_total), since: marks.value.since } : null,
    retention_days: RETENTION_DAYS,
    pruned: pruned ? pruned.value : null,
    notify: notifyOutcome,
    failed_measures: failed,
    note: 'Группы — по отпечатку (род + сообщение без чисел + первый кадр стека). Внешние без своих (cookie vedar_self) и ботов. visitor_days — человеко-дни суточного hash, не люди. ПД в строках нет: чистка на входе.',
  });
}

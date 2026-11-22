/**
 * /api/trips/[id]/vote-link — голосование группы по дням (фича 6), сторона
 * владельца поездки. Только владельцу — тем же условием, что у замены дня.
 *
 * POST { hours } — новая ссылка голосования (прежняя закрывается). Токен
 * отдаётся ОДИН раз в ответе (в БД — только sha256), не пишется в лог.
 * GET — итог последней ссылки: срок, сколько голосовали, «за/против» по дням.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';
import { OWNED_TRIP_SQL } from '@/lib/trips/trip-write';
import { hashToken, newVoteToken, tallyVotes, voteDeadline, VOTE_MAX_HOURS, VOTE_MIN_HOURS } from '@/lib/trips/trip-vote';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { 'Cache-Control': 'no-store' };
const Body = z.object({ hours: z.number().int().min(VOTE_MIN_HOURS).max(VOTE_MAX_HOURS) });

function dbFail(where: string, err: unknown): NextResponse {
  const e = err as { code?: unknown };
  console.error(`[trips/vote-link] ${where}:`, typeof e?.code === 'string' ? e.code : 'нет SQLSTATE');
  return NextResponse.json({ success: false, error: 'Голосование сейчас не открылось — попробуйте чуть позже' }, { status: 500, headers: NO_STORE });
}

async function ownedDays(id: string, userId: string): Promise<number | null> {
  const { rows } = await pool.query<{ days: unknown }>(OWNED_TRIP_SQL, [id, userId]);
  if (!rows[0]) return null;
  return Array.isArray(rows[0].days) ? rows[0].days.length : 0;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: `Срок голосования — от ${VOTE_MIN_HOURS} до ${VOTE_MAX_HOURS} часов` }, { status: 400 });
  }
  try {
    const n = await ownedDays(id, auth.userId);
    if (n === null) return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
    if (n === 0) return NextResponse.json({ success: false, error: 'В поездке нет дней — голосовать не за что' }, { status: 400 });
    const token = newVoteToken();
    const deadline = voteDeadline(new Date(), parsed.data.hours);
    await pool.query(`UPDATE trip_vote_links SET closed_at = NOW() WHERE trip_id = $1 AND closed_at IS NULL`, [id]);
    await pool.query(`INSERT INTO trip_vote_links (trip_id, token_hash, deadline_at) VALUES ($1, $2, $3)`, [id, hashToken(token), deadline.toISOString()]);
    return NextResponse.json({ success: true, data: { path: `/vote/${token}`, deadline_at: deadline.toISOString() } }, { headers: NO_STORE });
  } catch (err) {
    return dbFail('ссылка не записалась', err);
  }
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  try {
    const n = await ownedDays(id, auth.userId);
    if (n === null) return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
    const { rows } = await pool.query<{ id: string; deadline_at: string }>(
      `SELECT id, deadline_at FROM trip_vote_links WHERE trip_id = $1 AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [id]);
    const link = rows[0];
    if (!link) return NextResponse.json({ success: true, data: { link: null } }, { headers: NO_STORE });
    const votes = await pool.query<{ day_num: number; vote: number; voter_key: string }>(
      `SELECT day_num, vote, voter_key FROM trip_votes WHERE link_id = $1`, [link.id]);
    const deadline = new Date(link.deadline_at);
    return NextResponse.json({ success: true, data: { link: {
      deadline_at: deadline.toISOString(),
      open: deadline.getTime() > Date.now(),
      voters: new Set(votes.rows.map((r) => r.voter_key)).size,
      tallies: tallyVotes(votes.rows, n),
    } } }, { headers: NO_STORE });
  } catch (err) {
    return dbFail('итог не прочитался', err);
  }
}

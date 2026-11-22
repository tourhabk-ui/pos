/**
 * /api/trip-vote/[token] — голос группы по ссылке БЕЗ входа (фича 6, слово
 * владельца 23.11). Доступ — знанием токена; наружу только название поездки,
 * заголовки и даты дней, срок и итог «за/против». Ни владельца, ни туров, ни
 * цен, ни занятости.
 *
 * GET — дни, срок, итог и мои голоса. POST { day, vote: 1 | -1 | 0 } —
 * поставить, сменить или снять голос. Голосующий — случайный id в
 * httpOnly-cookie (в БД — хэш с id ссылки). Защита от накрутки: срок,
 * потолок голосующих на ссылку, лимит частоты по IP в памяти. Токен в лог
 * не пишется.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import {
  hashToken, voterKey, newVoterId, tallyVotes, MAX_VOTERS, VOTER_COOKIE, TOKEN_RE, VOTER_RE,
} from '@/lib/trips/trip-vote';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ token: string }> };
const NO_STORE = { 'Cache-Control': 'no-store' };
const readLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const voteLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const Body = z.object({ day: z.number().int().min(1).max(60), vote: z.union([z.literal(1), z.literal(-1), z.literal(0)]) });

const GONE = 'Ссылка голосования не найдена или закрыта — попросите у организатора новую.';

interface LinkRow { id: string; deadline_at: string; title: string; arrival_date: string | null; days: unknown }

async function findLink(token: string): Promise<LinkRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  const { rows } = await pool.query<LinkRow>(
    `SELECT l.id, l.deadline_at, t.title, t.arrival_date::text AS arrival_date, t.days
       FROM trip_vote_links l JOIN user_trips t ON t.id = l.trip_id
      WHERE l.token_hash = $1 AND l.closed_at IS NULL AND t.deleted_at IS NULL`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

function dayList(days: unknown): Array<{ day: number; title: string }> {
  if (!Array.isArray(days)) return [];
  return days.slice(0, 60).map((d, i) => {
    const o = (d ?? {}) as { day?: unknown; title?: unknown };
    return { day: Number.isInteger(o.day) ? (o.day as number) : i + 1, title: typeof o.title === 'string' ? o.title.slice(0, 160) : `День ${i + 1}` };
  });
}

function fail(where: string, err: unknown): NextResponse {
  const e = err as { code?: unknown };
  console.error(`[trip-vote] ${where}:`, typeof e?.code === 'string' ? e.code : 'нет SQLSTATE');
  return NextResponse.json({ success: false, error: 'Голосование сейчас не открылось — попробуйте чуть позже' }, { status: 500, headers: NO_STORE });
}

async function summary(link: LinkRow, voter: string | null) {
  const days = dayList(link.days);
  const { rows } = await pool.query<{ day_num: number; vote: number; voter_key: string }>(
    `SELECT day_num, vote, voter_key FROM trip_votes WHERE link_id = $1`, [link.id]);
  const mineKey = voter ? voterKey(link.id, voter) : null;
  const mine: Record<string, number> = {};
  for (const r of rows) if (mineKey && r.voter_key === mineKey) mine[String(r.day_num)] = Number(r.vote);
  const deadline = new Date(link.deadline_at);
  return {
    title: link.title, arrival_date: link.arrival_date, days,
    deadline_at: deadline.toISOString(), open: deadline.getTime() > Date.now(),
    voters: new Set(rows.map((r) => r.voter_key)).size, max_voters: MAX_VOTERS,
    tallies: tallyVotes(rows, days.length), mine,
  };
}

function voterFrom(req: NextRequest): string | null {
  const v = req.cookies.get(VOTER_COOKIE)?.value ?? null;
  return v && VOTER_RE.test(v) ? v : null;
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  if (!readLimiter.check(getClientIp(req.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком часто — подождите минуту.' }, { status: 429, headers: NO_STORE });
  }
  const { token } = await ctx.params;
  try {
    const link = await findLink(token);
    if (!link) return NextResponse.json({ success: false, error: GONE }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ success: true, data: await summary(link, voterFrom(req)) }, { headers: NO_STORE });
  } catch (err) {
    return fail('итог не прочитался', err);
  }
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  if (!voteLimiter.check(getClientIp(req.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком часто — подождите минуту.' }, { status: 429, headers: NO_STORE });
  }
  const { token } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Голос не понят — обновите страницу.' }, { status: 400, headers: NO_STORE });
  try {
    const link = await findLink(token);
    if (!link) return NextResponse.json({ success: false, error: GONE }, { status: 404, headers: NO_STORE });
    if (new Date(link.deadline_at).getTime() <= Date.now()) {
      return NextResponse.json({ success: false, error: 'Срок голосования вышел — итог у организатора.' }, { status: 409, headers: NO_STORE });
    }
    const { day, vote } = parsed.data;
    if (day > dayList(link.days).length) return NextResponse.json({ success: false, error: 'Такого дня в поездке нет.' }, { status: 400, headers: NO_STORE });
    const existing = voterFrom(req);
    const voter = existing ?? newVoterId();
    const key = voterKey(link.id, voter);
    if (vote === 0) {
      await pool.query(`DELETE FROM trip_votes WHERE link_id = $1 AND day_num = $2 AND voter_key = $3`, [link.id, day, key]);
    } else {
      const known = await pool.query<{ n: number; me: boolean }>(
        `SELECT COUNT(DISTINCT voter_key)::int AS n, BOOL_OR(voter_key = $2) AS me FROM trip_votes WHERE link_id = $1`, [link.id, key]);
      const row = known.rows[0];
      if (!row?.me && Number(row?.n ?? 0) >= MAX_VOTERS) {
        return NextResponse.json({ success: false, error: `По этой ссылке уже проголосовали ${MAX_VOTERS} человек — больше голосов она не принимает.` }, { status: 409, headers: NO_STORE });
      }
      await pool.query(
        `INSERT INTO trip_votes (link_id, day_num, voter_key, vote) VALUES ($1, $2, $3, $4)
         ON CONFLICT (link_id, day_num, voter_key) DO UPDATE SET vote = EXCLUDED.vote, updated_at = NOW()`,
        [link.id, day, key, vote]);
    }
    const res = NextResponse.json({ success: true, data: await summary(link, voter) }, { headers: NO_STORE });
    if (!existing) {
      res.cookies.set(VOTER_COOKIE, voter, { httpOnly: true, sameSite: 'lax', secure: true, path: '/api/trip-vote', maxAge: 60 * 60 * 24 * 30 });
    }
    return res;
  } catch (err) {
    return fail('голос не записался', err);
  }
}

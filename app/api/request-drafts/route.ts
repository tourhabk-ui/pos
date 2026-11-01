/**
 * /api/request-drafts — неотправленная заявка для одного напоминания
 * (lib/requests/request-drafts.ts, миграция 1363).
 *
 *  GET  — можно ли предложить галочку: вошёл и есть MAX или Telegram.
 *  POST { action: 'save', token?, comment, title?, recontact_consent }
 *       { action: 'submitted', token }
 *
 * AUTH: только вошедший (в реестре публичных маршрутов НЕТ — Edge требует JWT,
 * и здесь же authenticateUser). Третий исход: база не ответила — 503.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateUser } from '@/lib/auth';
import { createRateLimiter } from '@/lib/rate-limit';
import { COMMENT_MAX, markDraftSubmitted, readUserReach, saveDraft } from '@/lib/requests/request-drafts';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const Token = z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/);
const Schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), token: Token.nullable().optional(), comment: z.string().max(COMMENT_MAX), title: z.string().max(120).nullable().optional(), recontact_consent: z.boolean() }),
  z.object({ action: z.literal('submitted'), token: Token }),
]);

export async function GET(req: NextRequest) {
  const userId = await authenticateUser(req);
  if (!userId) return NextResponse.json({ eligible: false });
  try {
    const reach = await readUserReach(userId);
    return NextResponse.json({ eligible: !!reach.channel, channel: reach.channel });
  } catch {
    return NextResponse.json({ eligible: false }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const userId = await authenticateUser(req);
  if (!userId) return NextResponse.json({ success: false, error: 'Нужен вход' }, { status: 401 });
  if (!limiter.check(userId)) return NextResponse.json({ success: false, error: 'Слишком много запросов' }, { status: 429 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 }); }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Неверные данные запроса' }, { status: 400 });
  try {
    if (parsed.data.action === 'submitted') {
      await markDraftSubmitted(userId, parsed.data.token);
      return NextResponse.json({ success: true });
    }
    const d = parsed.data;
    const out = await saveDraft({ userId, token: d.token ?? null, comment: d.comment, title: d.title ?? null, consent: d.recontact_consent });
    return NextResponse.json({ success: true, token: out.token, channel: out.channel });
  } catch {
    return NextResponse.json({ success: false, error: 'База недоступна' }, { status: 503 });
  }
}

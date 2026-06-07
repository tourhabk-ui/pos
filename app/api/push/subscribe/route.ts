import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const SubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export async function POST(req: Request) {
  const auth = await requireAuth(req as never);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => null);
  const parsed = SubscribeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Неверные данные подписки' }, { status: 400 });
  }

  const { endpoint, keys } = parsed.data;
  const ua = (req as Request & { headers: Headers }).headers.get('user-agent') ?? null;

  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, last_used = NOW()`,
    [auth.userId, endpoint, keys.p256dh, keys.auth, ua],
  );

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const auth = await requireAuth(req as never);
  if (auth instanceof NextResponse) return auth;

  const { endpoint } = await req.json().catch(() => ({}));
  if (endpoint) {
    await pool.query(
      `DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`,
      [endpoint, auth.userId],
    );
  }

  return NextResponse.json({ ok: true });
}

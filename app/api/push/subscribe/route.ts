import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserFromRequest } from '@/lib/auth/jwt';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

// Подписка на push НЕ требует логина. Повод: канал существует для опасных
// алертов (цунами, сейсмо, вулканы, перекрытия дорог), а их аудитория — турист,
// впервые открывший публичную /safety, чаще всего без аккаунта. Кнопка опт-ина
// живёт на публичной /safety с 02.08, но эндпоинт оставался за requireAuth: жал
// «Включить» → браузер подписывался → POST отдавал 401 → подписка не сохранялась.
// Ровно поэтому подписок было 0, а safety-ingest слал broadcast в пустоту.
// user_id в схеме NULLABLE (миграция 672), sendPushBroadcast шлёт ВСЕМ подпискам
// независимо от user_id — анонимную подписку и создать можно, и достучаться до неё.
// Залогинен — связываем с пользователем; аноним — user_id NULL.

const SubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export async function POST(req: Request) {
  const auth = await getUserFromRequest(req);

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
     -- COALESCE: анонимный повтор подписки НЕ обнуляет ранее связанного
     -- пользователя (аноним подписался → потом вошёл → снова подписался анонимно).
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = COALESCE($1, push_subscriptions.user_id), last_used = NOW()`,
    [auth?.userId ?? null, endpoint, keys.p256dh, keys.auth, ua],
  );

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  // Отписка тоже без логина: endpoint — это секретная capability-ссылка,
  // известная только самому браузеру-владельцу, поэтому владение endpoint и
  // авторизует отписку. Чужой endpoint удалить нельзя — его неоткуда взять.
  const { endpoint } = await req.json().catch(() => ({}));
  if (endpoint) {
    await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
  }

  return NextResponse.json({ ok: true });
}

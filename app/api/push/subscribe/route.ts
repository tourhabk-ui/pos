import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserFromRequest } from '@/lib/auth/jwt';
import { pool } from '@/lib/db-pool';
import { createRateLimiter } from '@/lib/rate-limit';

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
//
// ── 02.09, #1485: тот же ноль, этажом выше ──────────────────────────────────
//
// Хендлер открыли 02.08, а Edge — нет: '/api/push/subscribe' не было в
// PUBLIC_API_ROUTES, и middleware отвечал гостю 401 ДО этого файла. Правило
// «подписка анонимна» было объявлено здесь и не работало там. Реестр поправлен
// (lib/auth/public-api-routes.ts), сторож — tests/unit/alert-delivery.test.ts.
//
// Заодно два места, где отказ прятался:
//   - INSERT без catch отдавал 500 без единой строки в логе — теперь SQLSTATE в
//     лог и 503 с человеческим текстом (§4.0: ловить можно, молчать нельзя);
//   - анонимный INSERT без лимита — теперь лимит на IP, как у остальных
//     анонимных маяков.

const SubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });

function ipOf(req: Request): string {
  const h = req.headers;
  return h.get('x-real-ip')
    || h.get('cf-connecting-ip')
    || h.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
}

export async function POST(req: Request) {
  if (!limiter.check(ipOf(req))) {
    return NextResponse.json({ ok: false, error: 'Слишком много запросов, попробуйте позже' }, { status: 429 });
  }

  const auth = await getUserFromRequest(req);

  const body = await req.json().catch(() => null);
  const parsed = SubscribeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Неверные данные подписки' }, { status: 400 });
  }

  const { endpoint, keys } = parsed.data;
  const ua = req.headers.get('user-agent') ?? null;

  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       -- COALESCE: анонимный повтор подписки НЕ обнуляет ранее связанного
       -- пользователя (аноним подписался → потом вошёл → снова подписался анонимно).
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = COALESCE($1, push_subscriptions.user_id), last_used = NOW()`,
      [auth?.userId ?? null, endpoint, keys.p256dh, keys.auth, ua],
    );
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err ? String((err as { code: unknown }).code) : '?';
    console.error('[push/subscribe] INSERT push_subscriptions failed, SQLSTATE', code, err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, error: 'Не удалось сохранить подписку — попробуйте позже' },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  // Отписка тоже без логина: endpoint — это секретная capability-ссылка,
  // известная только самому браузеру-владельцу, поэтому владение endpoint и
  // авторизует отписку. Чужой endpoint удалить нельзя — его неоткуда взять.
  if (!limiter.check(ipOf(req))) {
    return NextResponse.json({ ok: false, error: 'Слишком много запросов, попробуйте позже' }, { status: 429 });
  }
  const { endpoint } = await req.json().catch(() => ({}));
  if (typeof endpoint === 'string' && endpoint) {
    try {
      await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
    } catch (err) {
      console.error('[push/subscribe] DELETE failed:', err instanceof Error ? err.message : err);
      return NextResponse.json({ ok: false, error: 'Не удалось отписать — попробуйте позже' }, { status: 503 });
    }
  }

  return NextResponse.json({ ok: true });
}

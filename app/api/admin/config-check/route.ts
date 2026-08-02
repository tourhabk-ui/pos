/**
 * GET /api/admin/config-check — что деплой РЕАЛЬНО видит из env (admin).
 *
 * Всю ночь повторялось: владелец добавляет переменную на Timeweb, а взялась ли
 * она — неизвестно (Telegram-диагностик /testpush зависит от вебхука, который
 * сам может быть не настроен). Этот эндпоинт отвечает из самого рабочего
 * процесса: булевы «задан/нет» + счётчики, БЕЗ значений секретов. Один хит в
 * браузере (под админом) — и видно, что подхватилось после передеплоя.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { isS3Configured } from '@/lib/storage/s3';

export const dynamic = 'force-dynamic';

const set = (v: string | undefined | null) => !!(v && v.trim());

async function countOrNull(sql: string): Promise<number | null> {
  try { const { rows } = await pool.query<{ n: string }>(sql); return Number(rows[0]?.n ?? 0); }
  catch { return null; }
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const [subscriptions, undelivered] = await Promise.all([
    countOrNull('SELECT COUNT(*)::text AS n FROM push_subscriptions'),
    countOrNull(
      `SELECT COUNT(*)::text AS n FROM external_alerts
        WHERE (severity >= 2 OR alert_type IN ('tsunami_warning','road_closure'))
          AND push_sent_at IS NULL`,
    ),
  ]);

  return NextResponse.json({
    success: true,
    checked_at: new Date().toISOString(),
    // Push: нужны ОБА ключа + хотя бы одна подписка, чтобы кого-то достичь.
    vapid: {
      public_set: set(process.env.NEXT_PUBLIC_VAPID_KEY),
      private_set: set(process.env.VAPID_PRIVATE_KEY),
      email: process.env.VAPID_EMAIL ?? 'mailto:info@vedarai.ru (default)',
      subscriptions,
      undelivered_alerts: undelivered,
      verdict:
        !set(process.env.NEXT_PUBLIC_VAPID_KEY) || !set(process.env.VAPID_PRIVATE_KEY)
          ? 'VAPID ключи не видны процессу — проверь имена/передеплой'
          : subscriptions === 0
            ? 'ключи ок, но подписок нет — push летит в пустоту, нужны подписавшиеся туристы'
            : 'ок',
    },
    // S3: активен, только если заданы все три (endpoint/region имеют дефолты).
    s3: {
      configured: isS3Configured,
      access_key_set: set(process.env.S3_ACCESS_KEY),
      secret_key_set: set(process.env.S3_SECRET_KEY),
      bucket_set: set(process.env.S3_BUCKET),
      endpoint: process.env.S3_ENDPOINT ?? 'https://s3.twcstorage.ru (default)',
      region: process.env.S3_REGION ?? 'ru-1 (default)',
      verdict: isS3Configured ? 'ок' : 'не активен — нужны S3_ACCESS_KEY + S3_SECRET_KEY + S3_BUCKET',
    },
    // AI-провайдеры: только факт наличия ключа (доступность — /api/admin/ai/probe-relay и health-крон).
    ai: {
      deepseek_key: set(process.env.DEEPSEEK_API_KEY),
      qwen_key: set(process.env.DASHSCOPE_API_KEY),
      moonshot_key: set(process.env.MOONSHOT_API_KEY),
      openrouter_key: set(process.env.OPENROUTER_API_KEY) || set(process.env.OR_API_KEY),
      anthropic_key: set(process.env.ANTHROPIC_API_KEY),
      openrouter_relay: process.env.OPENROUTER_BASE_URL ?? '(прямой openrouter.ai — из РФ гео-блок)',
      anthropic_relay: process.env.ANTHROPIC_BASE_URL ?? '(прямой api.anthropic.com — из РФ гео-блок)',
      brightdata_key: set(process.env.BRIGHTDATA_API_KEY),
      brightdata_zone: process.env.BRIGHTDATA_ZONE ?? 'web_unlocker2 (default)',
    },
  });
}

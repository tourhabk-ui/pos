/**
 * GET /api/cron/health
 * Проверка здоровья системы — AI-провайдеры, БД, зависшие платежи, необработанные лиды.
 * При проблемах — алерт в Telegram admin.
 *
 * Запуск: cron-job.org каждый час
 *   URL: https://vedarai.ru/api/cron/health?secret=<CRON_SECRET>
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { callAnthropic, callOpenrouter, callDeepSeek, callFugu } from '@/lib/ai/providers';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import type { ChatMessage } from '@/lib/ai/prompts';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';

// ── Telegram helper ───────────────────────────────────────────────────────────

async function tgAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(() => {});
}

// ── AI probe ──────────────────────────────────────────────────────────────────

const PING: ChatMessage[] = [
  { role: 'system', content: 'Ты помощник. Отвечай одним словом.' },
  { role: 'user', content: 'Скажи: ок' },
];

async function probeAI(fn: (m: ChatMessage[]) => Promise<string | null>): Promise<boolean> {
  try {
    const res = await Promise.race([
      fn(PING),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    return !!res;
  } catch {
    return false;
  }
}

// ── DB checks ─────────────────────────────────────────────────────────────────

interface HealthIssue {
  level: 'warn' | 'crit';
  text: string;
}

async function checkDB(): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = [];

  try {
    // Зависшие HELD-платежи: release_after > 2ч назад, всё ещё HELD
    const held = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) as cnt FROM tour_payments
       WHERE status = 'HELD' AND release_after < NOW() - INTERVAL '2 hours'`
    );
    const heldCnt = parseInt(held.rows[0]?.cnt ?? '0', 10);
    if (heldCnt > 0) {
      issues.push({ level: 'crit', text: `${heldCnt} HELD-платежей просрочены (cron/payouts завис?)` });
    }
  } catch { /* DB недоступна — поймаем ниже */ }

  try {
    // Необработанные лиды старше 6 часов
    const leads = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) as cnt FROM leads
       WHERE status = 'new' AND created_at < NOW() - INTERVAL '6 hours'`
    );
    const leadsCnt = parseInt(leads.rows[0]?.cnt ?? '0', 10);
    if (leadsCnt > 3) {
      issues.push({ level: 'warn', text: `${leadsCnt} лидов без обработки > 6ч (leads-followup?)` });
    }
  } catch { /* skip */ }

  try {
    // Последний пост Кузьмича — должен быть не старше 26 часов.
    // ВАЖНО: action_type должен совпадать с тем, что реально пишет telegram-channel.ts:
    // kuzmich_post (маршрут), kuzmich_tip (совет), kuzmich_safety_post (безопасность).
    const lastPost = await pool.query<{ created_at: Date }>(
      `SELECT created_at FROM ai_actions_log
       WHERE action_type IN ('kuzmich_post','kuzmich_tip','kuzmich_safety_post')
       ORDER BY created_at DESC LIMIT 1`
    );
    if (lastPost.rows.length > 0) {
      const diffH = (Date.now() - lastPost.rows[0].created_at.getTime()) / 3_600_000;
      if (diffH > 26) {
        issues.push({ level: 'warn', text: `Кузьмич молчит ${Math.round(diffH)}ч — cron/kuzmich не срабатывает` });
      }
    }
  } catch { /* ai_actions_log может не существовать */ }

  // OCTO: expire ON_HOLD bookings (hold_expires_at < NOW).
  // booked_slots не трогаем: OCTO больше не пишет счётчик (единственный
  // писатель — payment-webhook, семантика «оплаченные»); смена статуса на
  // 'cancelled' сама освобождает место в честной занятости. Старый декремент
  // вдобавок выбирал ПРОИЗВОЛЬНЫЙ слот (WHERE booked_slots > 0 LIMIT 1),
  // а не дату брони — портил чужие дни.
  try {
    const expiredBkgResult = await pool.query<{ id: string; octo_uuid: string; participants: number }>(
      `SELECT id, octo_uuid, participants
       FROM operator_bookings
       WHERE booking_status = 'new' AND hold_expires_at < NOW() AND deleted_at IS NULL
       LIMIT 1000`
    );

    if (expiredBkgResult.rows.length > 0) {
      const { notifyOctoWebhooks } = await import('@/lib/octo/webhooks');
      const { getBookingByUuid } = await import('@/lib/octo/service');

      for (const booking of expiredBkgResult.rows) {
        // Mark as cancelled
        await pool.query(
          `UPDATE operator_bookings SET booking_status = 'cancelled', updated_at = NOW()
           WHERE id = $1`,
          [booking.id]
        );

        // Webhook notification
        const fullBooking = await getBookingByUuid(booking.octo_uuid);
        notifyOctoWebhooks('booking:expired', booking.id, fullBooking ?? {}).catch(() => {});
      }

      issues.push({ level: 'warn', text: `${expiredBkgResult.rows.length} OCTO hold'ы истекли, marked cancelled` });
    }
  } catch { /* OCTO tables могут не существовать */ }

  return issues;
}

// ── Operator registration spike detection ─────────────────────────────────────

interface RegistrationSpikeResult {
  today: number;
  baseline_median: number;
  is_spike: boolean;
}

async function checkOperatorRegistrationSpike(): Promise<RegistrationSpikeResult> {
  const result = await pool.query<{ day: string; cnt: string }>(
    `SELECT
       DATE_TRUNC('day', created_at)::date::text AS day,
       COUNT(*)::int                              AS cnt
     FROM partners
     WHERE category = 'operator'
       AND created_at >= NOW() - INTERVAL '14 days'
     GROUP BY DATE_TRUNC('day', created_at)
     ORDER BY day DESC`,
  );

  const rows = result.rows;
  if (rows.length === 0) return { today: 0, baseline_median: 0, is_spike: false };

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayRow = rows.find(r => r.day === todayStr);
  const today    = Number(todayRow?.cnt ?? 0);

  const historyCounts = rows
    .filter(r => r.day !== todayStr)
    .map(r => Number(r.cnt))
    .sort((a, b) => a - b);

  let baseline_median = 0;
  if (historyCounts.length > 0) {
    const mid = Math.floor(historyCounts.length / 2);
    baseline_median = historyCounts.length % 2 === 0
      ? (historyCounts[mid - 1] + historyCounts[mid]) / 2
      : historyCounts[mid];
  }

  const is_spike = baseline_median > 0 && today > baseline_median * 3;
  return { today, baseline_median, is_spike };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  // SECURITY: CRON_SECRET must be configured - unauthenticated access is critical risk
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured on server' },
      { status: 500 }
    );
  }

  const secret = getCronSecret(request);

  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const started = Date.now();
  const issues: HealthIssue[] = [];

  // AI-провайдеры + registration spike (параллельно).
  // MiMo (прямой api.xiaomimimo.com) отключён 04.07.2026 — эндпоинт не отвечал,
  // провайдер убран из живых гонок (см. providers.ts). Поэтому и не мониторим.
  const [openrouterOk, anthropicOk, deepseekOk, fuguOk, regSpike] = await Promise.all([
    probeAI(callOpenrouter),
    probeAI(callAnthropic),
    probeAI(callDeepSeek),
    probeAI(callFugu),
    checkOperatorRegistrationSpike().catch(() => ({ today: 0, baseline_median: 0, is_spike: false })),
  ]);

  const anyOk = openrouterOk || anthropicOk || deepseekOk || fuguOk;
  if (!anyOk) {
    issues.push({ level: 'crit', text: 'Все AI-провайдеры недоступны (OpenRouter + Anthropic + DeepSeek + Fugu)' });
  } else {
    // Предупреждаем только о РЕАЛЬНЫХ проблемах, а не об ожидаемом:
    // — провайдеры без ключа = не настроены, это не сбой
    // — Anthropic-direct блокируется регионом, но Claude доступен через OpenRouter,
    //   поэтому это проблема, только если и OpenRouter лёг
    if (!deepseekOk) issues.push({ level: 'warn', text: 'DeepSeek недоступен' });
    if (!openrouterOk) issues.push({ level: 'warn', text: 'OpenRouter недоступен' });
    if (process.env.ANTHROPIC_API_KEY && !anthropicOk && !openrouterOk) {
      issues.push({ level: 'warn', text: 'Anthropic недоступен напрямую и через OpenRouter' });
    }
    if (process.env.FUGU_API_KEY && !fuguOk) {
      issues.push({ level: 'warn', text: 'Fugu недоступен (ключ задан, но провайдер не отвечает)' });
    }
  }

  // Всплеск регистраций операторов
  if (regSpike.is_spike) {
    issues.push({
      level: 'warn',
      text: `Всплеск регистраций операторов: сегодня ${regSpike.today} (медиана 14д: ${regSpike.baseline_median}) — возможен спам/бот-импорт`,
    });
  }

  // БД
  const dbIssues = await checkDB();
  issues.push(...dbIssues);

  // Отправить алерт если есть проблемы
  if (issues.length > 0) {
    const crits = issues.filter(i => i.level === 'crit');
    const warns = issues.filter(i => i.level === 'warn');

    const lines: string[] = [
      crits.length > 0
        ? '<b>TourHab ALERT</b> — критические проблемы'
        : '<b>TourHab</b> — предупреждения системы',
      '',
      ...crits.map(i => `CRIT: ${i.text}`),
      ...warns.map(i => `WARN: ${i.text}`),
      '',
      `Проверено: ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Kamchatka' })} (KMT)`,
    ];

    await tgAlert(lines.join('\n'));
  }

  return NextResponse.json({
    ok: issues.filter(i => i.level === 'crit').length === 0,
    ms: Date.now() - started,
    ai: { openrouter: openrouterOk, anthropic: anthropicOk, deepseek: deepseekOk, fugu: fuguOk },
    integrations: { github_token: !!process.env.GITHUB_TOKEN },
    operator_registration: regSpike,
    issues,
  });
}

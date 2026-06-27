/**
 * GET /api/admin/net-diag?secret=CRON_SECRET
 *
 * Факты о проде с самого сервера Timeweb (а не догадки снаружи):
 *   1. Какие env-переменные реально заданы (да/нет + длина, БЕЗ раскрытия значений).
 *      Значения НЕ секретных полей (ID каналов, TELEGRAM_API_BASE) показываются.
 *   2. Реальная сетевая доступность ключевых хостов с этого сервера:
 *      Telegram (напрямую и через прокси), Anthropic, OpenRouter, Sakana, DeepSeek.
 *      Возвращает HTTP-статус или текст сетевой ошибки.
 *
 * Auth: CRON_SECRET (header Bearer или ?secret=). Ничего не пишет.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';

interface Probe {
  target: string;
  url: string;
  status: number | null;
  ok: boolean | null;
  body: string | null;
  error: string | null;
  ms: number;
}

async function probe(target: string, url: string, opts?: RequestInit): Promise<Probe> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000), ...opts });
    const text = (await res.text().catch(() => '')).slice(0, 300);
    return { target, url, status: res.status, ok: res.ok, body: text, error: null, ms: Date.now() - t0 };
  } catch (e) {
    return {
      target, url, status: null, ok: null, body: null,
      error: e instanceof Error ? `${e.name}: ${e.message}` : 'fetch error',
      ms: Date.now() - t0,
    };
  }
}

function keyInfo(name: string): { set: boolean; len: number } {
  const v = process.env[name];
  return { set: !!v, len: v?.length ?? 0 };
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 1. Какие ключи заданы (без значений)
  const keys = {
    ANTHROPIC_API_KEY:        keyInfo('ANTHROPIC_API_KEY'),
    OPENROUTER_API_KEY:       keyInfo('OPENROUTER_API_KEY'),
    DEEPSEEK_API_KEY:         keyInfo('DEEPSEEK_API_KEY'),
    XIAOMI_API_KEY:           keyInfo('XIAOMI_API_KEY'),
    GEMINI_API_KEY:           keyInfo('GEMINI_API_KEY'),
    FUGU_API_KEY:             keyInfo('FUGU_API_KEY'),
    TELEGRAM_BOT_TOKEN:       keyInfo('TELEGRAM_BOT_TOKEN'),
    CRON_SECRET:              keyInfo('CRON_SECRET'),
  };

  // Не секретные значения — показываем как есть (нужно для диагностики)
  const config = {
    TELEGRAM_API_BASE:       process.env.TELEGRAM_API_BASE ?? '(не задан → прямой api.telegram.org)',
    TELEGRAM_CHANNEL_ID:     process.env.TELEGRAM_CHANNEL_ID ?? '(не задан)',
    TELEGRAM_AI_CHANNEL_ID:  process.env.TELEGRAM_AI_CHANNEL_ID ?? '(не задан)',
    TELEGRAM_CHAT_ID:        process.env.TELEGRAM_CHAT_ID ?? '(не задан)',
    NEXT_PUBLIC_APP_URL:     process.env.NEXT_PUBLIC_APP_URL ?? '(не задан)',
  };

  // 2. Реальная сетевая доступность с сервера
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgBase = process.env.TELEGRAM_API_BASE?.replace(/\/$/, '') || 'https://api.telegram.org';

  const probes = await Promise.all([
    // Telegram напрямую (минуя TELEGRAM_API_BASE) — главный вопрос: блокируется ли egress
    probe('telegram_direct', `https://api.telegram.org/bot${tgToken ?? '000'}/getMe`),
    // Telegram через настроенный base (прокси, если задан)
    probe('telegram_via_base', `${tgBase}/bot${tgToken ?? '000'}/getMe`),
    // Другие хосты — понять, это блокировка только Telegram или вся сеть
    probe('anthropic', 'https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
    }),
    probe('openrouter', 'https://openrouter.ai/api/v1/models'),
    probe('sakana_fugu', 'https://api.sakana.ai/v1/models', {
      headers: { Authorization: `Bearer ${process.env.FUGU_API_KEY ?? ''}` },
    }),
    probe('deepseek', 'https://api.deepseek.com/v1/models', {
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY ?? ''}` },
    }),
    probe('google_dns', 'https://dns.google/resolve?name=telegram.org'),
  ]);

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    keys,
    config,
    network: probes,
  });
}

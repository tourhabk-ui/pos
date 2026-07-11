/**
 * GET /api/cron/ssr-sentinel — еженедельный SSR-сторож листингов.
 *
 * Скачивает первый HTML публичных листингов (как его видит бот, без JS) и
 * проверяет сигналы SSR-контента (lib/seo/ssr-sentinel.ts). Провал любой
 * пробы — Telegram-алерт админу: тихая регрессия шага 3 поймана за неделю,
 * а не через месяц по просевшему трафику.
 *
 * Bearer CRON_SECRET. Запускается workflow cron-ssr-sentinel.yml.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { SSR_PROBES, formatSentinelAlert, type SsrProbeResult } from '@/lib/seo/ssr-sentinel';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

async function tgSend(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch {
    // Не роняем сторож из-за недоступного Telegram — результат виден в логе Actions.
  }
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const started = Date.now();
  const results: SsrProbeResult[] = [];

  for (const probe of SSR_PROBES) {
    try {
      const res = await fetch(`${BASE}${probe.path}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
        headers: { 'User-Agent': 'VedarSsrSentinel/1.0' },
      });
      if (!res.ok) {
        results.push({ name: probe.name, path: probe.path, ok: false, detail: `HTTP ${res.status}` });
        continue;
      }
      const html = await res.text();
      const { ok, detail } = probe.check(html);
      results.push({ name: probe.name, path: probe.path, ok, detail });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'сетевая ошибка';
      results.push({ name: probe.name, path: probe.path, ok: false, detail: message });
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    await tgSend(formatSentinelAlert(failed, BASE));
  }

  return NextResponse.json({
    success: true,
    ok: failed.length === 0,
    probes: results,
    duration_ms: Date.now() - started,
  });
}

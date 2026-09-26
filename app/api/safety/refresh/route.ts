/**
 * POST /api/safety/refresh — кнопка «Обновить данные» на экране безопасности.
 *
 * Публичный. Запускает ТОТ ЖЕ сбор, что каждые 5 минут зовёт супервизор
 * (GET /api/cron/safety-ingest), — не копию обхода. Правило «когда можно»
 * и исходы — lib/safety/manual-refresh.ts.
 *
 * Потолок общий на инстанс: сбор, прошедший меньше двух минут назад (по
 * журналу или от самой кнопки), не повторяется; одновременные нажатия ждут
 * один и тот же сбор. Секрет крона из процесса не уходит: запрос к сбору
 * собирается здесь же и в сеть не выходит.
 *
 * Зоны риска кнопка НЕ пересчитывает: это AI-оценка danger-analysis с
 * арендой окна 30 минут, и публичный палец её не заказывает.
 */
import { NextResponse } from 'next/server';
import { GET as runIngest } from '@/app/api/cron/safety-ingest/route';
import { lastIngestAt } from '@/lib/safety/ingest-run';
import { allowFresh } from '@/lib/safety/refresh-throttle';
import {
  MANUAL_REFRESH_MIN_INTERVAL_MS,
  MANUAL_REFRESH_WAIT_MS,
  manualRefreshDecision,
  manualRefreshNote,
  type ManualRefreshOutcome,
} from '@/lib/safety/manual-refresh';

export const dynamic = 'force-dynamic';

interface RunResult {
  outcome: Exclude<ManualRefreshOutcome, 'recent' | 'timeout'>;
  at: number;
}

/** Последний сбор, запущенный кнопкой в этом процессе. */
let lastButtonRunMs: number | null = null;
/** Идущий сбор: второе нажатие ждёт его, а не запускает свой. */
let inflight: Promise<RunResult> | null = null;

interface SourceEntry { fetched?: boolean; errors?: unknown[] }

async function collect(): Promise<RunResult> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[safety-refresh] CRON_SECRET не задан — сбор с кнопки невозможен');
    return { outcome: 'failed', at: Date.now() };
  }
  try {
    const res = await runIngest(new Request('http://127.0.0.1/api/cron/safety-ingest', {
      headers: { authorization: `Bearer ${secret}` },
    }));
    const at = Date.now();
    if (!res.ok) {
      console.error(`[safety-refresh] сбор ответил HTTP ${res.status}`);
      return { outcome: 'failed', at };
    }
    const body = (await res.json().catch(() => null)) as { sources?: Record<string, SourceEntry> } | null;
    const sources = Object.values(body?.sources ?? {});
    const anyFailed = sources.some((s) => s.fetched === true && Array.isArray(s.errors) && s.errors.length > 0);
    return { outcome: anyFailed ? 'partial' : 'ran', at };
  } catch (err) {
    console.error('[safety-refresh] сбор упал:', err instanceof Error ? err.message : err);
    return { outcome: 'failed', at: Date.now() };
  }
}

function reply(outcome: ManualRefreshOutcome, checkedAt: string | null) {
  return NextResponse.json({ outcome, checked_at: checkedAt, note: manualRefreshNote(outcome) });
}

export async function POST() {
  const now = Date.now();
  const journal = await lastIngestAt();
  const journalMs = journal ? Date.parse(journal) : null;
  const lastMs = Math.max(journalMs ?? 0, lastButtonRunMs ?? 0) || null;

  if (!inflight) {
    if (manualRefreshDecision(lastMs, now) === 'recent' || !allowFresh('safety-ingest-button', MANUAL_REFRESH_MIN_INTERVAL_MS, now)) {
      return reply('recent', lastMs ? new Date(lastMs).toISOString() : null);
    }
    inflight = collect().then((r) => {
      lastButtonRunMs = r.at;
      return r;
    }).finally(() => { inflight = null; });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = await Promise.race([
    inflight,
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MANUAL_REFRESH_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  // Сбор не отменяется: он допишет базу сам, экран подтянет данные позже.
  if (waited === null) return reply('timeout', lastMs ? new Date(lastMs).toISOString() : null);
  return reply(waited.outcome, waited.outcome === 'failed' ? (lastMs ? new Date(lastMs).toISOString() : null) : new Date(waited.at).toISOString());
}

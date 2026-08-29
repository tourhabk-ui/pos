/**
 * Разведчик: почему он молчит — ЧТЕНИЕ.
 *
 * Владелец 22.08: «разведчика почини». Последний дайджест 01.08, двадцать
 * один день. Монитор здоровья называет причину ПОСЛЕДНЕГО прогона — одну
 * строку из двадцати одной, и по ней нельзя отличить стену от череды
 * случайностей. А отличать надо: одна и та же причина двадцать раз подряд
 * означает сломанные ворота, а разные причины — что молчат разные вещи.
 *
 * В тот же день выяснилось, чего стоит диагноз по одной строке: алерт
 * двадцать один день утверждал «сбой в промпте, НЕ в провайдере», а на деле
 * заглушка отказа всех провайдеров читалась как ответ модели.
 *
 * READ-ONLY: ничего не запускает и не публикует. Отдаёт историю прогонов с
 * причинами, сводку «сколько раз какая» и дату последнего выпуска.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { SKIP_REASON_LABELS } from '@/lib/agents/scout-digest';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RunRow {
  started_at: Date;
  status: string;
  items_processed: number | null;
  llm_calls: number | null;
  metadata: unknown;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ success: false, error: 'CRON_SECRET не задан' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const rawLimit = parseInt(request.nextUrl.searchParams.get('limit') ?? '30', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 30;

  try {
    const { rows } = await pool.query<RunRow>(
      `SELECT started_at, status, items_processed, llm_calls, metadata
         FROM agent_run_history
        WHERE agent_id = 'scout-digest'
        ORDER BY started_at DESC
        LIMIT $1`,
      [limit],
    );

    const runs = rows.map(r => {
      const meta = r.metadata as {
        digest_skip_reason?: string | null;
        digest_skip_detail?: string | null;
        ai_channel_sent?: boolean | null;
        ai_channel_skip_reason?: string | null;
      } | null;
      const code = meta?.digest_skip_reason ?? null;
      // Судьба ВТОРОГО канала (@ai_hub_money) — отдельный вопрос, и до
      // 29.08 этот разбор на него не отвечал вовсе: читались только поля
      // основного дайджеста. Из-за этого по успешному прогону нельзя было
      // сказать, ушёл ли пост в канал, — а владелец спрашивал именно про
      // канал («из-за него нет и новостей в тг канале»).
      //
      // Три состояния, и они разные: true — ушёл; false с причиной — не
      // ушёл, вот почему; null — прогон старше того дня, когда исход стали
      // записывать, и сказать нечего. Последнее НЕ равно «не ушёл».
      const aiCode = meta?.ai_channel_skip_reason ?? null;
      return {
        ai_channel_sent: meta?.ai_channel_sent ?? null,
        ai_channel_skip_reason: aiCode,
        ai_channel_skip_label: aiCode ? (SKIP_REASON_LABELS[aiCode] ?? aiCode) : null,
        at: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
        status: r.status,
        signals: r.items_processed,
        llm_calls: r.llm_calls,
        // Причина может отсутствовать по двум РАЗНЫМ поводам: выпуск ушёл
        // (причины нет) или прогон старше того дня, когда причину начали
        // записывать (причина стёрта). Различаем статусом, не пустотой.
        skip_reason: code,
        skip_label: code ? (SKIP_REASON_LABELS[code] ?? code) : null,
        // Начало неразобранного ответа. Класс беды называет код, саму беду —
        // эта строка; без неё чинят наугад.
        skip_detail: meta?.digest_skip_detail ?? null,
      };
    });

    // Сводка: одна причина двадцать раз — стена; двадцать разных — россыпь.
    const byReason: Record<string, number> = {};
    for (const r of runs) {
      const key = r.status === 'success' ? '(выпуск ушёл)' : (r.skip_reason ?? '(причина не записана)');
      byReason[key] = (byReason[key] ?? 0) + 1;
    }

    // Сводка по ВТОРОМУ каналу отдельной таблицей: «дайджест ушёл» и «пост в
    // канал ушёл» — разные события, и сливать их в один счёт значит потерять
    // ровно тот вопрос, ради которого разбор и открывают.
    const aiByReason: Record<string, number> = {};
    for (const r of runs) {
      const key = r.ai_channel_sent === true
        ? '(пост в канал ушёл)'
        : (r.ai_channel_skip_reason ?? '(исход канала не записан)');
      aiByReason[key] = (aiByReason[key] ?? 0) + 1;
    }
    const lastAiSent = runs.find(r => r.ai_channel_sent === true) ?? null;

    const lastSent = runs.find(r => r.status === 'success') ?? null;

    // Последний ОПУБЛИКОВАННЫЙ выпуск: журнал прогонов и знание агента —
    // разные источники, и расхождение между ними само по себе улика.
    const digest = await pool.query<{ slug: string; created_at: Date }>(
      `SELECT slug, created_at FROM agent_knowledge
        WHERE agent_id = 'scout' AND type = 'intel' AND slug LIKE 'intel/scout/%'
        ORDER BY created_at DESC LIMIT 1`,
    );

    return NextResponse.json({
      success: true,
      probe: 'scout_diagnose_v1',
      runs_read: runs.length,
      by_reason: byReason,
      ai_channel_by_reason: aiByReason,
      ai_channel_last_sent_at: lastAiSent?.at ?? null,
      last_success_at: lastSent?.at ?? null,
      last_published_slug: digest.rows[0]?.slug ?? null,
      last_published_at: digest.rows[0]?.created_at ?? null,
      runs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка чтения журнала';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}

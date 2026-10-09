/**
 * GET /api/cron/crm-contacts-sync — задел клиентов партнёров из того, что уже
 * лежит в базе (CRM фаза 1, шаг 1а, #2325).
 *
 * Хуки на создание источников (`linkContactQuietly`) заводят клиента для
 * каждой НОВОЙ брони, заказа, лида. Всё, что создано до них, и всё, где хук
 * отказал (он не роняет бронь и только пишет в лог), подбирает этот роут.
 *
 *   ?apply=1   — привязать; без него СУХОЙ прогон: только числа непривязанного.
 *   ?kind=...  — один вид источника (operator_booking, lead, ...).
 *
 * Отбор и чтение строки — те же, что у хука (`UNLINKED_PAGE_SQL` и
 * `SOURCE_SQL` строятся из одного описания источника), поэтому задел не
 * заводит клиентов, которых хук бы не завёл. Идемпотентно: привязанное не
 * трогается повторно. Ответ — только числа, без ПД.
 *
 * Bearer CRON_SECRET.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import {
  SOURCE_KINDS, UNLINKED_COUNT_SQL, UNLINKED_PAGE_SQL,
  cursorStart, isSourceKind, linkContactFromSource, type SourceKind,
} from '@/lib/crm/contacts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PAGE = 200;
/** Запас до maxDuration: прогон останавливается сам и говорит, где. */
const BUDGET_MS = 50_000;

interface KindTally {
  scanned: number;
  created: number;
  attached: number;
  no_contact: number;
  no_source: number;
  failed: number;
}

function sqlstate(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет SQLSTATE';
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ success: false, error: 'Не авторизован' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const apply = sp.get('apply') === '1';
  const kindParam = sp.get('kind');
  if (kindParam !== null && !isSourceKind(kindParam)) {
    return NextResponse.json(
      { success: false, error: `Неизвестный вид источника; известны: ${SOURCE_KINDS.join(', ')}` },
      { status: 400 },
    );
  }
  const kinds: readonly SourceKind[] = kindParam ? [kindParam] : SOURCE_KINDS;

  if (!apply) {
    const unlinked: Partial<Record<SourceKind, number | null>> = {};
    const failed: Array<{ kind: SourceKind; sqlstate: string }> = [];
    for (const kind of kinds) {
      try {
        const { rows } = await pool.query<{ n: number }>(UNLINKED_COUNT_SQL[kind]);
        unlinked[kind] = rows[0]?.n ?? 0;
      } catch (err) {
        console.error('[crm-contacts-sync] не сосчитано:', kind, 'SQLSTATE', sqlstate(err));
        unlinked[kind] = null;
        failed.push({ kind, sqlstate: sqlstate(err) });
      }
    }
    // «Не смог сосчитать» — не ноль: такой вид в сумму не входит и назван.
    const total = Object.values(unlinked).reduce<number>((s, n) => s + (n ?? 0), 0);
    return NextResponse.json(
      { success: failed.length === 0, apply: false, unlinked, total, failed },
      { status: failed.length === 0 ? 200 : 503 },
    );
  }

  const started = Date.now();
  const byKind: Partial<Record<SourceKind, KindTally>> = {};
  let stoppedAt: SourceKind | null = null;

  outer: for (const kind of kinds) {
    const tally: KindTally = { scanned: 0, created: 0, attached: 0, no_contact: 0, no_source: 0, failed: 0 };
    byKind[kind] = tally;
    let cursor = cursorStart(kind);
    for (;;) {
      if (Date.now() - started > BUDGET_MS) { stoppedAt = kind; break outer; }
      let ids: string[];
      try {
        const { rows } = await pool.query<{ id: string }>(UNLINKED_PAGE_SQL[kind], [cursor, PAGE]);
        ids = rows.map((r) => r.id);
      } catch (err) {
        console.error('[crm-contacts-sync] порция не прочитана:', kind, 'SQLSTATE', sqlstate(err));
        tally.failed++;
        break;
      }
      if (ids.length === 0) break;
      for (const id of ids) {
        if (Date.now() - started > BUDGET_MS) { stoppedAt = kind; break outer; }
        tally.scanned++;
        const r = await linkContactFromSource(kind, id);
        if (r.outcome === 'linked') {
          if (r.created) tally.created++; else tally.attached++;
        } else if (r.outcome === 'no_contact') tally.no_contact++;
        else if (r.outcome === 'no_source') tally.no_source++;
        else tally.failed++;
        cursor = id;
      }
      if (ids.length < PAGE) break;
    }
  }

  const failedTotal = Object.values(byKind).reduce((s, t) => s + (t?.failed ?? 0), 0);
  return NextResponse.json({
    success: failedTotal === 0,
    apply: true,
    // Не дошёл до конца — повторить вызов: привязанное не тронется.
    complete: stoppedAt === null,
    stopped_at: stoppedAt,
    by_kind: byKind,
    elapsed_ms: Date.now() - started,
  }, { status: failedTotal === 0 ? 200 : 503 });
}

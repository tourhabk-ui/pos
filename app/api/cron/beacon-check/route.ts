/**
 * GET /api/cron/beacon-check?secret=<CRON_SECRET>
 *
 * Отвечает на ОДИН вопрос: способен ли приёмник маяка записать событие.
 *
 * ЗАЧЕМ. Перепись воронки 24.08 показала: `funnel_events` пуста за всё
 * время — ни одной строки с момента заведения таблицы. Это одинаково
 * объясняется двумя противоположными вещами:
 *   - посетители действительно не трогали ни форму брони, ни планировщик;
 *   - приёмник теряет события молча (INSERT падает, витрине уходит 204).
 * Первое чинится продуктом, второе — кодом. Пока их не различить, любая
 * работа по воронке делается вслепую, а «ноль касаний формы» звучит как
 * факт о туристах, будучи фактом о нас.
 *
 * ПОЧЕМУ НЕЛЬЗЯ ПРОСТО ПОСЛАТЬ СОБЫТИЕ. Можно — но тогда в аналитике
 * навсегда останется выдуманное касание, и следующий, кто будет считать
 * воронку, посчитает нашу пробу за туриста. Врать в собственные данные
 * ради диагностики нельзя: это то же самое, за что мы правим Editor.
 *
 * КАК УСТРОЕНО. Тот же INSERT, что в `app/api/funnel/route.ts`, на
 * отдельном соединении, в транзакции, которая ОТКАТЫВАЕТСЯ всегда — и на
 * успехе, и на ошибке. Строка не остаётся. Проверяется настоящий путь
 * записи: право на таблицу, наличие колонок, типы, дедуп-подзапрос.
 *
 * ЧЕГО ПРОБА НЕ ЗНАЕТ. Долетает ли `navigator.sendBeacon` из браузера
 * туриста до роута. Зелёный ответ означает «БД принимает запись», а не
 * «маяк работает целиком». Красный — что дальше можно не искать.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic     = 'force-dynamic';
export const maxDuration = 30;

/** Тот же INSERT, что у приёмника. Расходиться им нельзя — иначе проба врёт. */
const RECEIVER_INSERT = `
  INSERT INTO funnel_events (step, entity_id, visitor_hash)
  SELECT $1, $2, $3
   WHERE NOT EXISTS (
     SELECT 1 FROM funnel_events
      WHERE step = $1
        AND entity_id IS NOT DISTINCT FROM $2
        AND visitor_hash = $3
        AND created_at > NOW() - INTERVAL '60 minutes'
   )`;

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  let writePath: 'ok' | 'failed' = 'failed';
  let error: { message: string; sqlstate: string | null } | null = null;
  let insertedRows: number | null = null;

  const client = await pool.connect().catch(() => null);
  if (!client) {
    return NextResponse.json({
      ok: true,
      probe: 'beacon_check_v1',
      write_path: 'failed',
      error: { message: 'не удалось взять соединение из пула', sqlstate: null },
      note: 'Отказ пула — это отказ проверки, а не «запись работает».',
      duration_ms: Date.now() - startedAt,
    });
  }

  try {
    await client.query('BEGIN');
    const res = await client.query(RECEIVER_INSERT, [
      'booking_start',
      // Заведомо несуществующий тур: если откат вдруг не сработает, строка
      // будет опознаваема как проба, а не притворится касанием карточки.
      'beacon-check-rollback',
      'beacon-check-rollback',
    ]);
    insertedRows = res.rowCount ?? 0;
    writePath = 'ok';
  } catch (err) {
    const e = err as { message?: string; code?: string };
    error = { message: e?.message ?? 'неизвестная ошибка', sqlstate: e?.code ?? null };
    console.error('[beacon-check] запись маяка невозможна:', error.message, `SQLSTATE=${error.sqlstate}`);
  } finally {
    // Откат в finally: он обязан случиться и на успехе тоже — проба не
    // оставляет следов по построению, а не по удаче.
    await client.query('ROLLBACK').catch((err) => {
      console.error('[beacon-check] откат не удался:', err instanceof Error ? err.message : err);
    });
    client.release();
  }

  return NextResponse.json({
    ok: true,
    probe: 'beacon_check_v1',
    write_path: writePath,
    inserted_rows_in_rollback: insertedRows,
    error,
    // Что именно доказано, а что нет — словами, чтобы зелёный ответ не
    // прочитали шире, чем он есть.
    proves: 'БД принимает запись события: таблица, права, колонки, дедуп.',
    does_not_prove: 'Долетает ли sendBeacon из браузера туриста до этого роута.',
    duration_ms: Date.now() - startedAt,
  });
}

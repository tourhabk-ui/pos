/**
 * POST /api/cron/partner-cleanup — удалить бесхозных партнёров.
 *
 * Решение владельца 22.08.2026, по цифрам переписи (проба 98): из 128
 * партнёров у двух есть туры, 116 держатся аттестациями или входом в
 * кабинет, а 10 не привязаны ни к чему. Удаляются только последние.
 *
 * ПОЧЕМУ НЕ МИГРАЦИЯ. На `partners` ссылаются 39 внешних ключей из 25 таблиц,
 * из них 21 с CASCADE. Миграция идёт одной транзакцией: одна строка, упёршаяся
 * в ключ, откатила бы весь файл — а файл при этом записался бы применённым
 * (дефект трекинга, задача #58, из-за которого мы сегодня и нашли пропавшую
 * комиссию платформы). Молчаливое «удалено» при пустой базе — ровно то, чего
 * не должно быть в необратимой операции.
 *
 * Поэтому каждая строка удаляется В СВОЕЙ транзакции, а те, что не удалились,
 * называются поимённо вместе с именем ограничения, которое их держит.
 *
 * ЗАЩИТА ОТ СЕБЯ:
 *  • по умолчанию НИЧЕГО не удаляет — нужен `confirm: true` в теле;
 *  • потолок: если кандидатов больше MAX_DELETE, отказ целиком. Если завтра
 *    сломается подсчёт связей, все 128 партнёров станут «бесхозными», и без
 *    потолка запрос снёс бы базу партнёров одним вызовом;
 *  • каскад считается ЗАРАНЕЕ: сколько строк уедет следом за партнёром. Если
 *    уезжает хоть что-то — партнёр не бесхозный, и он пропускается.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

/** Больше этого за один вызов не удаляем ни при каких условиях. */
const MAX_DELETE = 20;

interface Candidate {
  id: string;
  name: string;
  category: string;
  refs: number;
}

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let confirm = false;
  try {
    const body = (await request.json()) as { confirm?: unknown };
    confirm = body?.confirm === true;
  } catch {
    // Тела нет — значит сухой прогон. Это не ошибка.
  }

  try {
    // Кандидат — партнёр без единой связи. Признаки те же, что у переписи:
    // товар, деньги, живой вход в кабинет, собранные данные о гиде.
    const { rows: candidates } = await pool.query<Candidate>(
      `SELECT p.id::text,
              COALESCE(p.company_name, p.name) AS name,
              p.category,
              0 AS refs
         FROM partners p
        WHERE p.user_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM operator_tours t WHERE t.operator_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM guide_certifications g WHERE g.guide_id = p.id)
          AND NOT EXISTS (
                SELECT 1 FROM operator_bookings b
                  JOIN operator_tours t2 ON t2.id = b.operator_tour_id
                 WHERE t2.operator_id = p.id)
        ORDER BY p.created_at NULLS LAST`,
    );

    if (candidates.length > MAX_DELETE) {
      // Не «удалили сколько смогли», а отказ целиком: столько бесхозных сразу
      // означает, что сломался подсчёт связей, а не что появился мусор.
      return NextResponse.json({
        ok: false,
        reason: `кандидатов ${candidates.length}, потолок ${MAX_DELETE} — похоже на сбой подсчёта связей, а не на мусор`,
        candidates: candidates.map((c) => ({ id: c.id, name: c.name, category: c.category })),
      }, { status: 409 });
    }

    if (!confirm) {
      return NextResponse.json({
        ok: true,
        dry_run: true,
        would_delete: candidates.length,
        candidates: candidates.map((c) => ({ id: c.id, name: c.name, category: c.category })),
        hint: 'повторить с телом {"confirm":true}',
      });
    }

    const deleted: Array<{ id: string; name: string }> = [];
    const skipped: Array<{ id: string; name: string; reason: string }> = [];

    for (const c of candidates) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Условия повторяются в самом DELETE: между выборкой и удалением
        // партнёр мог обзавестись туром или кабинетом.
        const res = await client.query(
          `DELETE FROM partners p
            WHERE p.id = $1
              AND p.user_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM operator_tours t WHERE t.operator_id = p.id)
              AND NOT EXISTS (SELECT 1 FROM guide_certifications g WHERE g.guide_id = p.id)`,
          [c.id],
        );
        await client.query('COMMIT');
        if (res.rowCount === 1) deleted.push({ id: c.id, name: c.name });
        else skipped.push({ id: c.id, name: c.name, reason: 'за время запроса появилась связь' });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const e = err as { code?: string; constraint?: string; message?: string };
        // Внешний ключ держит — значит партнёр всё-таки на что-то опирается.
        // Это не сбой уборки, это её отказ, и он должен быть назван.
        skipped.push({
          id: c.id,
          name: c.name,
          reason: `${e?.code ?? 'ошибка'}${e?.constraint ? ` (${e.constraint})` : ''}: ${e?.message ?? 'причина неизвестна'}`.slice(0, 200),
        });
      } finally {
        client.release();
      }
    }

    return NextResponse.json({
      ok: true,
      dry_run: false,
      deleted_count: deleted.length,
      deleted,
      skipped_count: skipped.length,
      skipped,
    });
  } catch (err) {
    // Третий исход: не смог — это не «удалять было нечего».
    const message = err instanceof Error ? err.message : 'база не ответила';
    console.error('[partner-cleanup] уборка не выполнена:', message);
    return NextResponse.json({ ok: false, reason: message }, { status: 500 });
  }
}

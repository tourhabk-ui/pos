/**
 * POST /api/cron/legacy-tours-cleanup — снести демо-строки из мёртвой `tours`.
 *
 * Решение владельца 23.08.2026 по замеру (проба 101): в таблице 17 строк.
 * Одиннадцать — старые копии туров живого оператора «Камчатская рыбалка», у
 * всех есть двойники по имени в `operator_tours`; их НЕ трогаем, это отдельный
 * разговор. Шесть — демо-туры, заведённые одним заходом 31.03.2026, и именно
 * они внешним ключом `tours_operator_id_fkey` держат пятерых бесхозных
 * партнёров от удаления (уборка 22.08: пять удалено, пять упёрлось).
 *
 * ПОЧЕМУ СПИСОК ID, А НЕ ПРЕДИКАТ. Любое условие вида «где создано 31 марта»
 * или «где оператор без туров» завтра захватит больше, чем задумано: данные
 * меняются, а условие остаётся. Здесь удаляются шесть НАЗВАННЫХ строк и
 * только они. Список нельзя расширить случайно — его можно только переписать
 * руками, и это будет видно диффом.
 *
 * ПОЧЕМУ НЕ МИГРАЦИЯ. Ровно то же, что у уборки партнёров: файл миграции идёт
 * одной транзакцией, одна упёршаяся строка откатила бы весь файл, а файл
 * записался бы применённым (задача #58). В необратимой операции это
 * недопустимо. Каждая строка удаляется в своей транзакции, отказ называется
 * вместе с SQLSTATE и именем ограничения.
 *
 * ЗАЩИТА: без `confirm: true` в теле — сухой прогон, ничего не удаляется.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

/**
 * Шесть демо-строк, снятых переписью 23.08.2026 02:03 UTC.
 * Имя рядом с id — не для запроса, а для человека: по нему видно, что
 * удаляется, без похода в базу.
 */
const DEMO_ROWS: ReadonlyArray<{ id: string; name: string; partner: string }> = [
  { id: '1258cc8d-658d-44e7-a203-2b094d976ba9', name: 'Медведи + Горячие источники (2 дня)', partner: 'Медведи & Природа' },
  { id: 'd4579dfe-4d90-47c5-8f63-3dd863229f43', name: 'Нахлыстовая рыбалка (2 дня)',        partner: 'Рыбалка по-камчатски' },
  { id: 'f043e987-d185-4f3f-94d5-46f7d5cf87f8', name: 'Авачинский вулкан (1 день)',          partner: 'Вулканы Камчатки' },
  { id: '22891614-50e3-4a10-82c4-7ef73eab9050', name: 'Сплав по реке Камчатка (3 дня)',      partner: 'Катерина Сплавы' },
  { id: '1e1a954d-3fd2-469f-af6f-6f57b04d922b', name: 'Geyser Valley & Hot Springs',         partner: 'Медведи и Природа' },
  { id: '9da17d42-87a5-478c-9837-923c77cbfdff', name: 'Медведи Камчатки + горячие источники', partner: 'Медведи и Природа' },
];

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
    // Тела нет — сухой прогон. Это не ошибка.
  }

  if (!confirm) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      would_delete: DEMO_ROWS.length,
      rows: DEMO_ROWS,
      hint: 'повторить с телом {"confirm":true}',
    });
  }

  const deleted: Array<{ id: string; name: string }> = [];
  const skipped: Array<{ id: string; name: string; reason: string }> = [];

  for (const row of DEMO_ROWS) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Имя проверяется В САМОМ DELETE вместе с id: если по этому id за
      // прошедшее время оказалась другая строка, удаления не будет, и это
      // назовётся отказом, а не тихо снесёт чужое.
      const res = await client.query(
        `DELETE FROM tours WHERE id = $1 AND name = $2`,
        [row.id, row.name],
      );
      await client.query('COMMIT');
      if (res.rowCount === 1) deleted.push({ id: row.id, name: row.name });
      else skipped.push({ id: row.id, name: row.name, reason: 'строки с таким id и именем нет — возможно, уже удалена' });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const e = err as { code?: string; constraint?: string; message?: string };
      skipped.push({
        id: row.id,
        name: row.name,
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
    next: 'повторить POST /api/cron/partner-cleanup с confirm — пятеро партнёров должны освободиться',
  });
}

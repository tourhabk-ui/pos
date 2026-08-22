/**
 * GET /api/admin/health/schema-drift
 *
 * Чем боевая схема отличается от объявленной в файлах.
 *
 * ── Зачем ─────────────────────────────────────────────────────────────────
 *
 * За один день 22.08.2026 трижды нашлось одно и то же: таблица объявлена в
 * репозитории ДВАЖДЫ с разными колонками, код написан против той версии,
 * которая к базе не едет, и ошибка живёт до первого вызова.
 * `guide_earnings` и `guide_schedule` — половина кабинета гида обращалась к
 * несуществующим колонкам. `tour_availability` — инструмент оператора и
 * скрейпер дат, причём скрейпер глотал отказ пустым `catch`.
 *
 * Каждый раз разбор упирался в один и тот же вопрос: а что в базе НА САМОМ
 * ДЕЛЕ? Ответить было нечем, и приходилось честно останавливаться на «не
 * знаю» — так в миграции 902 остались неразрешёнными конфликт типа
 * `start_time` и смысла `guide_id`, а в стороже схемы — названное расхождение
 * `chat_sessions.context`.
 *
 * `getTableInfo()` умела спросить боевые колонки и не звалась ниоткуда
 * (перепись). Здесь она отвечает на тот самый вопрос.
 *
 * ── Что считается расхождением ────────────────────────────────────────────
 *
 * Две стороны, и они разного веса:
 *
 *   `missing_in_db`  — файлы обещают колонку, в базе её нет. ОПАСНО: код,
 *                      написанный по файлам, упадёт на первом обращении.
 *   `missing_in_files` — в базе колонка есть, файлы о ней не знают. Тише, но
 *                      это след правки мимо миграций, запрещённой правилами.
 *
 * Отказ запроса — третий исход, а не «расхождений нет».
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { getTableInfo } from '@/lib/database';
import { buildSchemaRegistry } from '@/lib/database/schema-registry';

export const dynamic = 'force-dynamic';

interface TableDrift {
  table: string;
  missing_in_db: string[];
  missing_in_files: string[];
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  let live;
  try {
    live = await getTableInfo();
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Боевую схему прочитать не удалось',
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }

  // Боевая схема: таблица → колонки
  const inDb = new Map<string, Set<string>>();
  for (const row of live.rows) {
    const t = row.table_name.toLowerCase();
    const set = inDb.get(t) ?? new Set<string>();
    set.add(row.column_name.toLowerCase());
    inDb.set(t, set);
  }

  const reg = buildSchemaRegistry();

  const drift: TableDrift[] = [];
  for (const [table, declared] of reg.tables) {
    // Судим только таблицы, чьё тело разобрано целиком: у остальных набор
    // колонок в файлах заведомо неполон, и «расхождение» было бы выдумкой.
    if (!reg.created.has(table)) continue;
    const actual = inDb.get(table);
    if (actual === undefined) continue; // таблицы нет в базе — отдельный разговор ниже

    const missing_in_db = [...declared].filter((c) => !actual.has(c)).sort();
    const missing_in_files = [...actual].filter((c) => !declared.has(c)).sort();
    if (missing_in_db.length > 0 || missing_in_files.length > 0) {
      drift.push({ table, missing_in_db, missing_in_files });
    }
  }

  // Объявлена в файлах, но в базе её нет: на чистом инстансе такая таблица
  // означает упавшую миграцию, на боевом — что до неё просто не дошли.
  const declared_absent = [...reg.tables.keys()]
    .filter((t) => reg.created.has(t) && !inDb.has(t))
    .sort();

  return NextResponse.json({
    success: true,
    data: {
      tables_in_db: inDb.size,
      tables_declared: [...reg.tables.keys()].filter((t) => reg.created.has(t)).length,
      // Сначала то, что опаснее: файлы обещают колонку, которой нет.
      drift: drift.sort((a, b) => b.missing_in_db.length - a.missing_in_db.length),
      declared_absent,
    },
  });
}

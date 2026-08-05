/**
 * GET /api/admin/diagnostics/bystraya  (admin-only, только чтение)
 *
 * Почему правки состава тура «Сплав по реке Быстрая» не доезжают до карточки.
 *
 * Владелец 05.08 третий раз прислал одну и ту же строку — «Рыболовные снасти
 * (аренда 500 руб)» в блоке «не входит», хотя оператор говорит, что снасти
 * входят в стоимость. Две миграции подряд (819, затем 821) писались вслепую:
 * живых данных из среды разработки не видно, прод закрыт сетевой политикой.
 * Обе отчитались «применилась», карточка не изменилась. Ноль изменённых строк
 * неотличим от успеха — и отличить их можно только отсюда.
 *
 * Прошлая версия этого файла отвечала на вопрос, которого уже нет: она искала
 * тур по жёстко вписанному имени «Однодневная экскурсия СПЛАВ ПО РЕКЕ БЫСТРАЯ»
 * (миграция 806 переименовала его в «Сплав по реке Быстрая») и проверяла
 * список миграций, обрывавшийся на 800. То есть на живой базе она сказала бы
 * «тур не найден» — диагностика, которая устарела молча, хуже её отсутствия:
 * она даёт ложную уверенность.
 *
 * Поэтому здесь нет ни одного вписанного руками названия и ни одного списка,
 * который надо помнить обновить:
 *   • туры ищутся по СОДЕРЖАНИЮ и отдаются ВСЕ — без «канонического» выбора.
 *     Гипотеза «правили не тот тур» проверяется только полным списком;
 *   • состояние миграций считается сверкой каталога `migrations/` с таблицей
 *     `_migrations`, а причины падений берутся из `_migration_failures` целиком;
 *   • типы колонок читаются из `information_schema` — это проверка главной
 *     гипотезы: если `included/not_included/what_to_bring` на проде `jsonb`, а
 *     не `text[]`, то все миграции, писавшие в них `ARRAY[...]`, обязаны были
 *     упасть, и падали молча.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readdirSync } from 'fs';
import { join } from 'path';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

/** Колонки, вокруг типа которых крутится весь разбор. */
const CONTENT_COLUMNS = [
  'included', 'not_included', 'what_to_bring',
  'program', 'safety_notes', 'photos',
];

/** Тип, который эти колонки должны иметь по миграции 056. */
const EXPECTED_UDT = '_text';

interface ColumnType {
  column_name: string;
  /** 'ARRAY' для text[], 'jsonb' для jsonb. */
  data_type: string;
  /** '_text' для text[], 'jsonb' для jsonb — точнее, чем data_type. */
  udt_name: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const result: Record<string, unknown> = {};
  const verdict: string[] = [];

  // ── 1. Типы колонок: главная проверяемая гипотеза ───────────────────────────
  let columnTypes: ColumnType[] = [];
  try {
    const { rows } = await pool.query<ColumnType>(
      `SELECT column_name, data_type, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'operator_tours'
          AND column_name = ANY($1)
        ORDER BY column_name`,
      [CONTENT_COLUMNS],
    );
    columnTypes = rows;
    result.column_types = rows;
  } catch (e) {
    result.column_types_error = e instanceof Error ? e.message : String(e);
  }

  const mistyped = columnTypes.filter(
    (c) => ['included', 'not_included', 'what_to_bring'].includes(c.column_name)
      && c.udt_name !== EXPECTED_UDT,
  );

  // ── 2. Все туры сплава, без выбора одного ───────────────────────────────────
  // Никакого LIMIT 1: именно «канонический» выбор через ORDER BY ... LIMIT 1
  // подозревается в том, что правил не тот тур, который видит турист.
  try {
    const { rows } = await pool.query(
      `SELECT ot.id::text,
              ot.title,
              p.slug         AS operator_slug,
              p.name         AS operator_name,
              ot.is_active,
              ot.is_published,
              ot.deleted_at::text,
              ot.base_price::text,
              ot.activity_type,
              ot.included,
              ot.not_included,
              ot.what_to_bring,
              (ot.program IS NOT NULL)      AS has_program,
              (ot.meeting_point IS NOT NULL) AS has_meeting_point,
              COALESCE(array_length(ot.photos, 1), 0) AS photos_count,
              ot.created_at::text,
              ot.updated_at::text
         FROM operator_tours ot
         LEFT JOIN partners p ON p.id = ot.operator_id
        WHERE ot.title ILIKE '%быстр%'
           OR ot.activity_type IN ('rafting', 'boat_trip')
        ORDER BY ot.created_at ASC`,
    );
    result.rafting_tours = rows;
    result.rafting_tours_count = rows.length;
  } catch (e) {
    result.rafting_tours_error = e instanceof Error ? e.message : String(e);
  }

  // ── 3. Миграции: сверка каталога с таблицей, без списков вручную ────────────
  try {
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM _migrations');
    const applied = new Set(rows.map((r) => r.name));

    let files: string[] = [];
    try {
      files = readdirSync(join(process.cwd(), 'migrations'))
        .filter((f) => f.endsWith('.sql'))
        .sort();
    } catch {
      // Каталога нет в образе — тогда про «не применилось» ничего не утверждаем.
      result.migrations_note = 'каталог migrations/ недоступен в образе — сверка пропущена';
    }

    if (files.length > 0) {
      const missing = files.filter((f) => !applied.has(f));
      result.migrations_total = files.length;
      result.migrations_applied_count = files.length - missing.length;
      result.migrations_missing = missing;
    }
  } catch (e) {
    result.migrations_error = e instanceof Error ? e.message : String(e);
  }

  // ── 4. Причины падений — целиком, а не по списку имён ───────────────────────
  try {
    const { rows } = await pool.query(
      `SELECT name, error, attempts, last_failed_at::text
         FROM _migration_failures ORDER BY name`,
    );
    result.migration_failures = rows;
  } catch {
    result.migration_failures = 'таблица _migration_failures недоступна (старый деплой?)';
  }

  // ── 5. Вердикт словами ──────────────────────────────────────────────────────
  if (mistyped.length > 0) {
    verdict.push(
      `Тип колонок расходится с репозиторием: ${mistyped
        .map((c) => `${c.column_name} = ${c.udt_name === 'jsonb' ? 'jsonb' : c.data_type}`)
        .join(', ')}. Миграция 056 объявляет их TEXT[], но ADD COLUMN IF NOT EXISTS молча ничего не делает, если колонка уже есть с другим типом. Все миграции, писавшие в них ARRAY[...] (796, 806, 819), обязаны были упасть — см. migration_failures. По этой же причине сохранение тура из кабинета отдавало пустую пятисотку.`,
    );
  } else if (columnTypes.length > 0) {
    verdict.push(
      'Типы колонок совпадают с репозиторием (text[]). Значит причина не в типе: смотреть rafting_tours — правился ли тот тур, который видит турист, — и migration_failures.',
    );
  }

  const failures = result.migration_failures;
  if (Array.isArray(failures) && failures.length > 0) {
    verdict.push(`Упавших миграций: ${failures.length}. Причина каждой — в поле error.`);
  }

  const tours = result.rafting_tours;
  if (Array.isArray(tours)) {
    const live = tours.filter(
      (t) => (t as { deleted_at: string | null }).deleted_at === null,
    );
    if (live.length > 1) {
      verdict.push(
        `Живых туров сплава ${live.length}, а не один. Любая миграция, выбиравшая один «канонический» тур подзапросом, могла править не тот, который открывает турист.`,
      );
    }
  }

  result.verdict = verdict;
  return NextResponse.json(result);
}

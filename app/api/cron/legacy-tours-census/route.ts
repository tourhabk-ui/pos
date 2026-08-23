/**
 * GET /api/cron/legacy-tours-census — что лежит в устаревшей таблице `tours`.
 * ТОЛЬКО ЧТЕНИЕ.
 *
 * Повод (уборка партнёров 22.08). Пять из десяти бесхозных партнёров не
 * удалились с одинаковой причиной:
 *
 *   23503 (tours_operator_id_fkey): update or delete on table "partners"
 *   violates foreign key constraint "tours_operator_id_fkey" on table "tours"
 *
 * То есть на проде живут строки в таблице, читать которую платформе запрещено
 * (CLAUDE.md §4: `FROM tours` → только `operator_tours`). Они ничего не
 * показывают пользователю и никем не обслуживаются — но держат пятерых
 * партнёров от удаления и потому существуют.
 *
 * ПОЧЕМУ НЕ ПО ФАЙЛУ СХЕМЫ. `tours` объявлена ТОЛЬКО в
 * `lib/database/schema.sql`; ни одной миграции с `CREATE TABLE tours` нет.
 * Этот файл — мёртвый реестр (задача #69), источником истины он не признан, и
 * строить по нему список колонок значит спрашивать у того, кто не знает.
 * Поэтому набор колонок берётся из `information_schema` живой базы, а
 * проекция собирается ТОЛЬКО из пересечения с явным списком кандидатов ниже:
 * имена приходят из системного каталога, а не снаружи, и сверяются с
 * зашитым перечнем — подстановки извне нет по построению.
 *
 * ТРЕТЬЕ СОСТОЯНИЕ. Таблицы может не быть вовсе — тогда ответ говорит
 * `table_present: false`, и это ОТВЕТ, а не ноль строк. «Нет таблицы» и «в
 * таблице пусто» — разные факты, и второй нельзя выдавать за первый (§4.0).
 *
 * Наружу уходят имена туров, счётчики и флаги. Контакты и цены партнёров не
 * отдаются: ответ читают в логах Actions.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

/**
 * Колонки, которые перепись готова показать, если они на проде есть.
 * Живой набор берётся из каталога и пересекается с этим списком — так ответ
 * не падает на отсутствующей колонке и не показывает ничего сверх задуманного.
 */
const WANTED_COLUMNS = [
  'id', 'name', 'title', 'category', 'difficulty', 'duration',
  'operator_id', 'guide_id', 'is_active', 'is_published',
  'deleted_at', 'created_at', 'updated_at',
] as const;

/** Чем назвать строку в отчёте: первая существующая из этих. */
const TITLE_CANDIDATES = ['name', 'title'] as const;

interface ColumnRow { column_name: string; data_type: string }
interface KindRow { table_type: string }
interface OperatorRow { operator_id: string | null; partner_name: string | null; rows: number }
interface SampleRow { [key: string]: unknown }

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows: columns } = await pool.query<ColumnRow>(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tours'
        ORDER BY ordinal_position`,
    );

    if (columns.length === 0) {
      // Не «нулевая перепись», а прямой ответ: таблицы нет. Значит и ключа,
      // упёршегося в уборку, быть не может — искать надо в другом месте.
      return NextResponse.json({
        ok: true,
        collected_at: new Date().toISOString(),
        table_present: false,
        note: 'таблицы public.tours на этой базе нет — внешний ключ tours_operator_id_fkey пришёл бы не отсюда',
      });
    }

    /**
     * Род отношения решает судьбу семи расхождений из девятнадцати.
     *
     * `ALTER TABLE` по ПРЕДСТАВЛЕНИЮ падает, а файл миграции идёт одной
     * транзакцией: отказ на первой строке откатывает весь файл, и файл всё
     * равно записывается применённым (дефект #58). Миграция 114 первой
     * строкой делает `ALTER TABLE tours ADD includes` — если `tours` тут
     * представление, из 114 не легло НИЧЕГО, и это ровно то, что видно в
     * данных: `operator_tours.includes` есть (пришёл позже из 690, и уже
     * TEXT вместо TEXT[]), а `excludes` и `itinerary` — нет.
     *
     * Колонку в представление не «дочинить»: доигрывать старый DDL здесь
     * нельзя, надо признать невозможным. Поэтому род называется вслух.
     */
    const { rows: kind } = await pool.query<KindRow>(
      `SELECT table_type FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'tours'`,
    );

    const present = new Set(columns.map((c) => c.column_name));
    const projection = WANTED_COLUMNS.filter((c) => present.has(c));
    const titleColumn = TITLE_CANDIDATES.find((c) => present.has(c)) ?? null;

    const { rows: totals } = await pool.query<{ rows_total: number }>(
      `SELECT COUNT(*)::int AS rows_total FROM tours`,
    );

    // Кто держится за эти строки. Партнёр может быть уже удалён — тогда
    // operator_id указывает в пустоту, и это тоже факт, который надо назвать.
    const { rows: byOperator } = present.has('operator_id')
      ? await pool.query<OperatorRow>(
          `SELECT t.operator_id::text,
                  COALESCE(p.company_name, p.name) AS partner_name,
                  COUNT(*)::int AS rows
             FROM tours t
             LEFT JOIN partners p ON p.id = t.operator_id
            GROUP BY t.operator_id, COALESCE(p.company_name, p.name)
            ORDER BY COUNT(*) DESC`,
        )
      : { rows: [] as OperatorRow[] };

    // Имена колонок — из системного каталога, пересечённые с WANTED_COLUMNS.
    // Кавычки на случай регистра; значения снаружи в запрос не попадают.
    const cols = projection.map((c) => `"${c}"`).join(', ');
    const { rows: sample } = await pool.query<SampleRow>(
      `SELECT ${cols} FROM tours ORDER BY ${present.has('created_at') ? '"created_at" DESC NULLS LAST' : '1'} LIMIT 50`,
    );

    // Есть ли у старой строки двойник в живой таблице — по имени. Совпадение
    // имени не доказывает, что это тот же тур, поэтому поле называется
    // `same_title_in_operator_tours`, а не «дубль».
    let sameTitle = 0;
    if (titleColumn) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM tours t
          WHERE EXISTS (
                SELECT 1 FROM operator_tours ot
                 WHERE lower(btrim(ot.title)) = lower(btrim(t."${titleColumn}")))`,
      );
      sameTitle = rows[0]?.n ?? 0;
    }

    return NextResponse.json({
      ok: true,
      collected_at: new Date().toISOString(),
      table_present: true,
      // BASE TABLE или VIEW. Если VIEW — миграции 114 и 03 не могли лечь по
      // построению, и три расхождения по `tours` не чинятся, а объясняются.
      table_kind: kind[0]?.table_type ?? 'не определён',
      rows_total: totals[0]?.rows_total ?? 0,
      columns: columns.map((c) => `${c.column_name}:${c.data_type}`),
      title_column: titleColumn,
      same_title_in_operator_tours: titleColumn ? sameTitle : null,
      by_operator: byOperator,
      sample,
    });
  } catch (err) {
    // Третий исход: не смог посчитать — это не «в старой таблице пусто».
    const e = err as { code?: string; message?: string };
    console.error(
      '[legacy-tours-census] перепись не выполнена:',
      `sqlstate=${e?.code ?? 'нет'}`,
      e?.message ?? String(err),
    );
    return NextResponse.json(
      { ok: false, reason: e?.message ?? 'база не ответила', sqlstate: e?.code ?? null },
      { status: 500 },
    );
  }
}

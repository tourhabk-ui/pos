/**
 * GET /api/cron/operator-screens-check — разбираются ли запросы экранов
 * кабинета оператора на НАСТОЯЩЕЙ базе прода.
 *
 * ЗАЧЕМ. 10.09 прогулка оператором (#1794) нашла пять экранов, отвечавших 500
 * на любой запрос: колонок `ot.transportation`, `tp.amount`, `g.specializations`
 * не существует, алиас CTE `cs` употреблялся внутри собственного определения.
 * Починка (#1807) доказана интеграционным тестом на базе, собранной ИЗ
 * МИГРАЦИЙ репозитория. Это не то же самое, что прод: в `schema-coverage`
 * заморожен список таблиц, у которых `CREATE TABLE` в репозитории нет вовсе, —
 * значит схема прода и схема из миграций совпадают не везде, и «у меня
 * зелено» про прод не говорит ничего.
 *
 * То есть до этой пробы исход был третий (§4.0): не «работает» и не
 * «сломано», а «проверено не там». Проба выносит приговор оттуда, где
 * экраны и живут.
 *
 * КАК ПРОВЕРЯЕТСЯ. `PREPARE` — и всё, по образцу `sql-shape-check`. Разбор
 * запроса проверяет имена таблиц и колонок, их типы и вывод типов
 * параметров; выполнения нет, строк не читается и не пишется ни одной,
 * чужие данные не трогаются. `DEALLOCATE ALL` возвращает соединение чистым.
 *
 * ПОЧЕМУ SQL НЕ СКОПИРОВАН. В отличие от `sql-shape-check`, копии здесь нет:
 * запросы импортируются из `lib/operator/screen-queries.ts` — того самого
 * модуля, который читают сами роуты. Расходиться нечему по построению.
 *
 * ЧЕГО ПРОБА НЕ ДОКАЗЫВАЕТ. Что экран отдаёт ПРАВИЛЬНЫЕ числа, что права
 * оператора проверены и что у оператора есть данные. Разбор — про форму, не
 * про смысл.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import {
  COMPLETENESS_TOURS_SQL,
  ANALYTICS_SQL,
  GUIDES_SQL,
  buildClientsSql,
} from '@/lib/operator/screen-queries';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface ScreenQuery {
  /** Экран кабинета, который сломается, если запрос не разберётся. */
  screen: string;
  name: string;
  sql: string;
}

/**
 * «Клиенты» собирают SQL во время работы (поиск и фильтр статуса
 * необязательны), поэтому проверяются ВСЕ четыре сочетания: запрос без
 * фильтров и запрос с фильтрами — разные тексты, и разобраться может один,
 * а другой нет.
 */
function clientsQueries(): ScreenQuery[] {
  const out: ScreenQuery[] = [];
  for (const search of [false, true]) {
    for (const status of [false, true]) {
      const { countSql, dataSql } = buildClientsSql({
        search,
        status,
        sortCol: 'total_spent',
        order: 'DESC',
      });
      const suffix = `поиск=${search ? 'да' : 'нет'}, статус=${status ? 'да' : 'нет'}`;
      out.push({ screen: 'clients', name: `Клиенты: счёт (${suffix})`, sql: countSql });
      out.push({ screen: 'clients', name: `Клиенты: страница (${suffix})`, sql: dataSql });
    }
  }
  return out;
}

function allQueries(): ScreenQuery[] {
  return [
    { screen: 'completeness', name: 'Полнота туров', sql: COMPLETENESS_TOURS_SQL },
    ...clientsQueries(),
    { screen: 'analytics', name: 'Аналитика: выручка по месяцам', sql: ANALYTICS_SQL.revenueByMonth },
    { screen: 'analytics', name: 'Аналитика: топ туров', sql: ANALYTICS_SQL.topTours },
    { screen: 'analytics', name: 'Аналитика: конверсия', sql: ANALYTICS_SQL.conversion },
    { screen: 'analytics', name: 'Аналитика: разбивка по статусам', sql: ANALYTICS_SQL.statusBreakdown },
    { screen: 'analytics', name: 'Аналитика: сводка', sql: ANALYTICS_SQL.summary },
    { screen: 'guides', name: 'Гиды', sql: GUIDES_SQL },
  ];
}

interface QueryResult {
  screen: string;
  name: string;
  prepares: boolean;
  sqlstate: string | null;
  error: string | null;
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });
  }

  const startedAt = Date.now();
  const queries = allQueries();

  const client = await pool.connect().catch(() => null);
  if (!client) {
    // Отказ соединения — это отказ ПРОВЕРКИ, а не «все экраны целы» (§4.0).
    return NextResponse.json({
      ok: false,
      probe: 'operator_screens_check_v1',
      verdict: 'could_not_check',
      checked: 0,
      note: 'Соединение с базой не получено. Это «не смог проверить», а не «нарушений нет».',
      duration_ms: Date.now() - startedAt,
    });
  }

  const results: QueryResult[] = [];
  try {
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      try {
        await client.query(`PREPARE operator_screen_probe_${i} AS ${q.sql}`);
        results.push({ screen: q.screen, name: q.name, prepares: true, sqlstate: null, error: null });
      } catch (err) {
        const e = err as { message?: string; code?: string };
        console.error(
          `[operator-screens-check] «${q.name}» не разбирается:`,
          `sqlstate=${e?.code ?? 'нет'}`,
          e?.message ?? String(err),
        );
        results.push({
          screen: q.screen,
          name: q.name,
          prepares: false,
          sqlstate: e?.code ?? null,
          error: e?.message ?? 'неизвестная ошибка',
        });
      }
    }
  } finally {
    await client.query('DEALLOCATE ALL').catch((err) => {
      console.error('[operator-screens-check] очистка не удалась:', err instanceof Error ? err.message : err);
    });
    client.release();
  }

  const broken = results.filter((r) => !r.prepares);
  const brokenScreens = [...new Set(broken.map((r) => r.screen))];

  return NextResponse.json({
    ok: broken.length === 0,
    probe: 'operator_screens_check_v1',
    verdict: broken.length === 0 ? 'all_parse' : 'broken_on_prod',
    checked: results.length,
    broken_count: broken.length,
    broken_screens: brokenScreens,
    broken,
    // Разобравшиеся — одними именами: ответ читается из аннотации прогона,
    // а она берёт голову и хвост тела. Разбор целиком утопил бы вердикт.
    parsed_ok: results.filter((r) => r.prepares).map((r) => r.name),
    proves: 'Разбираются ли запросы пяти экранов кабинета на схеме прода: имена таблиц и колонок, типы, вывод типов параметров.',
    does_not_prove: 'Что числа на экране верны, что права проверены и что у оператора есть данные.',
    reads_or_writes: 'Ни одной строки: только PREPARE и DEALLOCATE ALL.',
    duration_ms: Date.now() - startedAt,
  });
}

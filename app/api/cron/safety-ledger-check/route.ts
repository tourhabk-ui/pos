/**
 * GET /api/cron/safety-ledger-check — триада приёмки Safety Decision Ledger.
 *
 * Только чтение: ни один запрос здесь не пишет и не мутирует данные.
 *
 * Зачем роут, если те же пять запросов уже были в workflow. Первая версия
 * диагностики (PR #1472) ходила в прод-базу напрямую через `psql` с раннера
 * GitHub — по аналогии с tochka-check/ai-channel-check. Аналогия оказалась
 * ложной: те ходят по HTTPS на публичный vedarai.ru, а PostgreSQL Timeweb
 * закрыт по IP, и у раннеров они плавающие. Первый же прогон 31.08 ответил
 *
 *   psql: error: connection to server at "…twc1.net" (94.228.112.62),
 *   port 5432 failed: Connection timed out
 *
 * то есть инструмент не мог сработать ни при каких обстоятельствах, а ждали
 * его полтора суток. Достижимо из раннера приложение — значит спрашивать
 * надо приложение: у него доступ к базе есть по построению.
 *
 * У КАЖДОГО пункта триады три исхода, а не два (§4.0): найдено, не найдено,
 * не смогли спросить. Диагностика, которая на отказ запроса отвечает пустотой,
 * бесполезна ровно там, где нужна.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Исход одного вопроса: ответ либо названная причина, почему его нет. */
type Probe<T> = { ok: true; value: T } | { ok: false; error: string };

async function probe<T>(fn: () => Promise<T>): Promise<Probe<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const e = err as { message?: string; code?: string };
    // Код SQLSTATE важнее текста: 42P01 «нет таблицы» и отказ соединения —
    // разные беды с разной починкой.
    return { ok: false, error: `${e.code ? `[${e.code}] ` : ''}${e.message ?? String(err)}` };
  }
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  // 1. Существует ли таблица — то есть применилась ли миграция 925.
  const table = await probe(async () => {
    const { rows } = await pool.query<{ reg: string | null }>(
      `SELECT to_regclass('public.safety_decision_events')::text AS reg`,
    );
    return rows[0]?.reg ?? null;
  });
  const tableExists = table.ok && table.value !== null;

  // 2. Падала ли ИМЕННО эта миграция. Watchdog её не называл, но там
  //    ORDER BY last_failed_at DESC LIMIT 5 без хвоста (находка W-7):
  //    «не называл» и «не падала» — разные утверждения.
  const failures = await probe(async () => {
    const { rows } = await pool.query(
      `SELECT name, error, attempts, first_failed_at, last_failed_at
         FROM _migration_failures
        WHERE name LIKE '925_safety%'
        ORDER BY last_failed_at DESC`,
    );
    return rows;
  });

  // 3-4. Пишет ли конвейер вообще, и что именно. Спрашиваем ТОЛЬКО если
  //      таблица есть: иначе получили бы 42P01 и выдали отсутствие таблицы
  //      за отсутствие записей — две разные беды под одним ответом.
  const total = tableExists
    ? await probe(async () => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM safety_decision_events`,
        );
        return parseInt(rows[0]?.n ?? '0', 10);
      })
    : null;

  const recent = tableExists
    ? await probe(async () => {
        const { rows } = await pool.query(
          `SELECT id::text, entity_id, event_type, actor_type, actor_id,
                  decision_reason, created_at
             FROM safety_decision_events
            ORDER BY id DESC
            LIMIT 20`,
        );
        return rows;
      })
    : null;

  // 5. Какие из двух 925-х вообще применились (коллизия номера с
  //    925_zelenovskie_ozerki_and_razdolie.sql, PR #1468).
  const applied = await probe(async () => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM _migrations WHERE name LIKE '925%' ORDER BY name`,
    );
    return rows.map((r) => r.name);
  });

  // Вердикт словами, а не только цифрами: читающему нужен следующий шаг.
  let verdict: string;
  if (!table.ok) {
    verdict = 'НЕ СМОГЛИ ПРОВЕРИТЬ: запрос к базе не выполнился, см. table.error';
  } else if (!tableExists) {
    verdict = 'Таблицы нет — миграция 925_safety_decision_events не применилась. Смотреть migration_failures ниже.';
  } else if (total?.ok && total.value === 0) {
    verdict = 'Таблица есть, записей ноль — конвейер до неё не доходит либо appendSafetyEvent молча отказывает (он fail-soft). Искать [safety-ledger] в логах контейнера.';
  } else if (total?.ok) {
    verdict = `Таблица есть, записей ${total.value} — критерий приёмки фазы 1 достижим, сверять цепочку по recent.`;
  } else {
    verdict = 'Таблица есть, но счётчик не выполнился — см. total.error';
  }

  return NextResponse.json({
    success: true,
    checked_at: new Date().toISOString(),
    verdict,
    table,
    table_exists: tableExists,
    migration_failures: failures,
    total_events: total,
    recent,
    applied_925_migrations: applied,
  });
}

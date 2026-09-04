/**
 * GET /api/cron/alerts-census — течёт ли поток тревог региона.
 * Bearer CRON_SECRET, только чтение.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Дайджест 04.09 напечатал в разделе «Камчатка»: «Нет значимых сигналов за
 * сегодня». Раздел кормится не из RSS (ленты у региона нет с 01.08), а из
 * НАШЕЙ таблицы `external_alerts` — сейсмика КБГС, МЧС, пожары FIRMS. То
 * есть строка означает буквально: за 25 часов не записано ни одной тревоги.
 *
 * Для Камчатки это неправдоподобно, и та же беда уже была видна с другой
 * стороны: 30.08 Watchdog доложил отставание сейсмо-канала на 250 минут и
 * ноль push-подписчиков (#1485). Но «тихо в регионе» и «конвейер молчит»
 * из дайджеста неотличимы, а стоят разного.
 *
 * ── Что различает перепись ─────────────────────────────────────────────────
 *
 * Пустая таблица сама по себе ничего не доказывает. Приговор даёт ПАРА
 * фактов: были ли тревоги И ходил ли ингест.
 *
 *   тревоги есть                        → flowing   поток жив
 *   тревог нет, ингест отработал        → quiet     в регионе правда тихо
 *   тревог нет, ингест не запускался    → stalled   молчит конвейер, не край
 *   не смогли посчитать                 → unknown   (§4.0) не выдаём за «тихо»
 *
 * Третий исход — тот, ради которого перепись и написана: он выглядит как
 * второй и означает противоположное.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Кто мог записать тревогу. Список берётся ИЗ РЕЕСТРА, а не набирается здесь
 * руками: свой перечень назвал бы агентов, которых нет (первая редакция этого
 * файла придумала `seismic-monitor` и `wildfire-firms` — таких agentId в
 * реестре не существует), и «ингест не отмечался» означало бы всего лишь
 * «я спрашивал не тех».
 */
const INGEST_AGENTS = CRON_REGISTRY
  .filter((e) => e.tier === 'safety' && e.agentId)
  .map((e) => e.agentId as string);

interface TypeRow { alert_type: string | null; n: number; newest_age_min: number | null }
interface RunRow { agent_id: string; status: string; started_at: string; age_min: number }

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Тревоги за сутки и за неделю: одни сутки пустые бывают, неделя — нет.
    const { rows: byType } = await pool.query<TypeRow>(
      `SELECT alert_type,
              COUNT(*)::int                                                        AS n,
              MIN(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60)::int              AS newest_age_min
         FROM external_alerts
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY alert_type
        ORDER BY COUNT(*) DESC`,
    );

    const { rows: window } = await pool.query<{ last_25h: number; last_7d: number; newest_age_min: number | null }>(
      `SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '25 hours')::int AS last_25h,
              COUNT(*)::int                                                          AS last_7d,
              MIN(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60)::int                AS newest_age_min
         FROM external_alerts
        WHERE created_at > NOW() - INTERVAL '7 days'`,
    );
    const w = window[0] ?? { last_25h: 0, last_7d: 0, newest_age_min: null };

    // Ходил ли тот, кто наполняет таблицу. Без этого «тревог нет» неотличимо
    // от «некому было их записать».
    const { rows: runs } = await pool.query<RunRow>(
      `SELECT DISTINCT ON (agent_id)
              agent_id, status, started_at::text,
              (EXTRACT(EPOCH FROM (NOW() - started_at)) / 60)::int AS age_min
         FROM agent_run_history
        WHERE agent_id = ANY($1::text[])
          AND started_at > NOW() - INTERVAL '7 days'
        ORDER BY agent_id, started_at DESC`,
      [INGEST_AGENTS],
    );

    const ingestRanRecently = runs.some((r) => r.age_min <= 25 * 60);
    const verdict = w.last_25h > 0
      ? 'flowing'
      : ingestRanRecently ? 'quiet' : 'stalled';

    return NextResponse.json({
      probe: 'alerts_census_v1',
      checked_at: new Date().toISOString(),
      alerts: {
        last_25h: w.last_25h,
        last_7d: w.last_7d,
        newest_age_min: w.newest_age_min,
        by_type: byType,
      },
      // Пусто — ни один из наполняющих агентов не отметился за неделю. Это
      // не «агентов нет», а «телеметрии нет»: имена ниже названы явно.
      ingest_runs: runs,
      ingest_agents_watched: INGEST_AGENTS,
      ingest_ran_within_25h: ingestRanRecently,
      verdict,
      note: verdict === 'flowing'
        ? 'Тревоги приходят — раздел «Камчатка» в дайджесте пуст не из-за конвейера'
        : verdict === 'quiet'
          ? 'Тревог нет, но наполняющий агент отработал: похоже, в регионе правда тихо'
          : 'Тревог нет И наполняющий агент не отмечался за сутки — молчит конвейер, а не край',
    });
  } catch (err) {
    // Отказ переписи — «не смог посчитать», а не «тихо» (§4.0). Молчание в
    // ответе на вопрос о тревогах опаснее любого другого молчания.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[alerts-census] перепись не выполнена:', message);
    return NextResponse.json(
      { probe: 'alerts_census_v1', verdict: 'unknown', error: message },
      { status: 500 },
    );
  }
}

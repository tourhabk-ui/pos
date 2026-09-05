/**
 * GET /api/cron/passport-flag-census — у скольких живых маршрутов есть
 * официальный паспорт, но флаг «регистрация в МЧС обязательна» стоит в
 * false. Bearer CRON_SECRET, только чтение.
 *
 * Зачем. Слияния 04-05.09 (пробы 437 и 440) показали одно и то же дважды:
 * выживший маршрут пришёл скрейпом, где флага нет вовсе, и несёт DEFAULT
 * false (baseline); дубль прошёл через импортёр паспортов и нёс true. По
 * базе «сказано false» и «дефолт false» неотличимы. Значит перепись НЕ
 * выносит вердикт — она называет ПОДОЗРЕВАЕМЫХ: паспорт есть, флаг false.
 * Каждого разбирает человек по паспорту, партиями; общего правила
 * «паспорт ⇒ true» здесь нет намеренно — паспорт может честно говорить
 * «не требуется».
 *
 * Три исхода: список пуст (подозреваемых нет), список непуст (есть кого
 * смотреть), перепись не выполнена (verdict unknown, 500).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Row {
  id: string;
  title: string;
  pdf_url: string;
  flag: boolean | null;
  has_mchs_phone: boolean;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<Row>(
      `SELECT r.id::text AS id, r.title, r.pdf_url,
              r.mchs_registration_required AS flag,
              (r.mchs_phone IS NOT NULL AND btrim(r.mchs_phone) <> '') AS has_mchs_phone
         FROM kamchatka_routes r
        WHERE r.is_visible = true AND r.merged_into_id IS NULL
          AND r.pdf_url IS NOT NULL AND btrim(r.pdf_url) <> ''
        ORDER BY r.title`,
    );

    const withPassport = rows.length;
    const flagTrue = rows.filter((r) => r.flag === true).length;
    const suspects = rows.filter((r) => r.flag !== true);

    return NextResponse.json({
      probe: 'passport_flag_census_v1',
      checked_at: new Date().toISOString(),
      live_with_passport: withPassport,
      flag_true: flagTrue,
      // Паспорт есть, флаг не true. Это не «флаг неверен», а «надо открыть
      // паспорт и прочитать»: ответ даёт документ, не перепись.
      suspects_total: suspects.length,
      suspects: suspects.map((r) => ({
        id: r.id, title: r.title, pdf_url: r.pdf_url,
        flag: r.flag, has_mchs_phone: r.has_mchs_phone,
      })),
      verdict: withPassport === 0
        ? 'no_passports'
        : suspects.length === 0 ? 'all_stated' : 'suspects',
    });
  } catch (err) {
    // Отказ переписи — «не смог посчитать», а не «подозреваемых нет» (§4.0).
    const message = err instanceof Error ? err.message : String(err);
    console.error('[passport-flag-census] перепись не выполнена:', message);
    return NextResponse.json(
      { probe: 'passport_flag_census_v1', verdict: 'unknown', error: message },
      { status: 500 },
    );
  }
}

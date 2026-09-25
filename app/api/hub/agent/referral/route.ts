/**
 * GET  /api/hub/agent/referral — список реф. ссылок агента + статистика
 * POST /api/hub/agent/referral — создать новую реф. ссылку
 *
 * ── Ставку назначает ВЛАДЕЛЕЦ, а не агент и не автомат (20.09) ────────────
 *
 * До этой правки процент приходил ТЕЛОМ ЗАПРОСА от самого агента (Zod:
 * нижняя граница 1, верхняя 30, умолчание 10) и писался в ссылку, а GET ниже
 * показывал ему «заработано» = оплаченные брони × эта же ставка. Сторона
 * сделки назначала себе вознаграждение, и до тридцати процентов.
 *
 * Правило платформы однозначно и оплачено делом (§7, разбор денежного пути
 * 11.09): ставку назначает владелец, её не меняет никакой автомат. Там был
 * автомат; здесь — контрагент, то есть хуже.
 *
 * Теперь ссылка создаётся БЕЗ ставки. NULL здесь — «не назначена», и это не
 * ноль и не десять: умолчание снято миграцией 1005 именно потому, что
 * молчаливая десятка была денежным решением, принятым без человека.
 * Назначает ставку ВЛАДЕЛЕЦ своей рукой — POST /api/admin/agent-referral/rate,
 * с автором и основанием. Не «платформа»: платформа ничего не решает, она
 * записывает решение человека. Слово здесь важно ровно настолько же, как в
 * §7, где сказано «назначает владелец», а не «назначается».
 *
 * Присланная ставка не игнорируется, а ОТКЛОНЯЕТСЯ. Молча выбросить поле
 * значило бы оставить у клиента впечатление, что он её задал: он ждал бы
 * тридцать процентов, а получил бы пустоту — ровно то расхождение между
 * показанным и сделанным, ради которого вся правка.
 *
 * ── Заработок не считается, пока ставки нет ───────────────────────────────
 *
 * `Number(null)` в JavaScript равен нулю, и этим уже был испорчен денежный
 * путь однажды: `/api/bookings/tour` брал так комиссию платформы и молча
 * получал НОЛЬ (§7). Здесь та же ловушка с другой стороны: показать агенту
 * «заработано 0 ₽» при неназначенной ставке значит соврать числом. Поэтому
 * `earned_total` остаётся null, итог считается только по ссылкам со ставкой,
 * а число ссылок без неё идёт рядом.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAgent } from '@/lib/auth/middleware';
import { requireApprovedAgent } from '@/lib/auth/agent-approval';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';
import { randomBytes } from 'crypto';

export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  tourId:    z.coerce.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAgent(request);
  if (auth instanceof NextResponse) return auth;

  // Конверсии и заработок считаем ЖИВО из источника истины
  // operator_bookings.referral_link_id (миграция 727), а не из сломанного
  // прежде join к agent_bookings (UUID vs BIGINT). rl.conversions — легаси-кэш.
  // conversions — все атрибутированные брони (воронка); earned_total — только
  // оплаченные (payment_status='paid'), чтобы отменённые/неоплаченные не раздували заработок.
  let rows;
  try {
    ({ rows } = await pool.query(
    `SELECT
       rl.id, rl.code, rl.tour_id, rl.clicks,
       rl.commission_rate, rl.expires_at, rl.is_active, rl.created_at,
       ot.title AS tour_title,
       (SELECT COUNT(*) FROM operator_bookings ob WHERE ob.referral_link_id = rl.id)::int AS conversions,
       COALESCE(
         (SELECT SUM(ob.final_price) FROM operator_bookings ob
           WHERE ob.referral_link_id = rl.id AND ob.payment_status = 'paid'), 0
       ) * rl.commission_rate / 100 AS earned_total,
       (rl.commission_rate IS NULL) AS rate_unset
     FROM agent_referral_links rl
     LEFT JOIN operator_tours ot ON ot.id = rl.tour_id
     WHERE rl.agent_id = $1
     ORDER BY rl.created_at DESC`,
    [auth.userId]
    ));
  } catch (err) {
    console.error(`[hub/agent/referral] ссылки не прочитаны, SQLSTATE ${sqlstateOf(err)}:`,
      err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить ссылки. Попробуйте позже.' },
      { status: 500 },
    );
  }

  // Итог по деньгам считается ТОЛЬКО по ссылкам со ставкой. Ссылка без
  // ставки не даёт нуля — она не даёт ничего, и её число выносится рядом,
  // чтобы «заработано 0 ₽» не читалось как «вы ничего не заработали», когда
  // верный ответ — «ставка ещё не назначена».
  const withRate = rows.filter(r => r.commission_rate !== null);
  const stats = {
    totalClicks:      rows.reduce((s, r) => s + Number(r.clicks), 0),
    totalConversions: rows.reduce((s, r) => s + Number(r.conversions), 0),
    totalEarned:      withRate.reduce((s, r) => s + Number(r.earned_total ?? 0), 0),
    linksWithoutRate: rows.length - withRate.length,
  };

  return NextResponse.json({ success: true, data: rows, stats });
}

function sqlstateOf(err: unknown): string {
  return (err as { code?: string }).code ?? 'нет SQLSTATE';
}

export async function POST(request: NextRequest) {
  // Ссылку — то есть право на продажи — выдаём только одобренному агенту
  // (решение владельца 26.09). Смотреть свои ссылки (GET) можно и до одобрения.
  const auth = await requireApprovedAgent(request);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message },
      { status: 400 }
    );
  }

  // Ставку в теле не принимаем и не глушим: отказ громче тихого выбрасывания.
  if (body !== null && typeof body === 'object' && 'commissionRate' in body) {
    return NextResponse.json(
      { success: false, error: 'Ставку вознаграждения назначает владелец платформы, а не агент' },
      { status: 400 },
    );
  }

  const { tourId, expiresAt } = parsed.data;

  // Генерируем код: KH-AGT-XXXX
  const code = `KH-AGT-${randomBytes(3).toString('hex').toUpperCase()}`;

  try {
    const { rows } = await pool.query(
      // commission_rate пишется ЯВНЫМ NULL, а не опускается: пропуск колонки
      // вернул бы умолчание, если его когда-нибудь заведут обратно.
      `INSERT INTO agent_referral_links
         (agent_id, tour_id, code, commission_rate, expires_at)
       VALUES ($1, $2, $3, NULL, $4)
       RETURNING id, code, tour_id, commission_rate, expires_at, created_at`,
      [auth.userId, tourId ?? null, code, expiresAt ?? null]
    );
    return NextResponse.json({ success: true, data: rows[0] }, { status: 201 });
  } catch (err) {
    const sqlstate = sqlstateOf(err);
    console.error(`[hub/agent/referral] ссылка не создана, SQLSTATE ${sqlstate}:`,
      err instanceof Error ? err.message : err);
    // 23503 — тура с таким id нет; 23505 — код совпал с существующим (редко).
    const message = sqlstate === '23503'
      ? 'Тур не найден'
      : sqlstate === '23505'
        ? 'Не удалось выдать код — попробуйте ещё раз'
        : 'Не удалось создать ссылку. Попробуйте позже.';
    return NextResponse.json({ success: false, error: message }, { status: sqlstate === '23503' ? 400 : 500 });
  }
}

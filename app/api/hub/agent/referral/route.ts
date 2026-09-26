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
 * Назначает ставку ВЛАДЕЛЕЦ своей рукой — с 26.09 одну на агента, а не на
 * ссылку: POST /api/admin/agent-commission/rate, с автором и основанием
 * (у брони, оформленной агентом за клиента, ссылки нет вовсе). Не «платформа»: платформа ничего не решает, она
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
 * без ставки агента `earned_total` и `totalEarned` — null.
 *
 * ── Деньги — из одной функции (26.09) ─────────────────────────────────────
 *
 * Прежде GET считал «заработано» как все оплаченные брони × ставку ссылки —
 * включая ОТМЕНЁННЫЕ. Теперь ссылка даёт только воронку (клики, брони), а
 * рубли приходят из lib/payments/agent-commission.ts — той же функции, что
 * у экрана комиссий и заявки на выплату: оплачено, не отменено.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAgent } from '@/lib/auth/middleware';
import { requireApprovedAgent } from '@/lib/auth/agent-approval';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { loadAgentMoney, logAgentMoneyFailure, sqlstateOf, type SaleState } from '@/lib/payments/agent-commission';

/** Продажа начислена: оплачена и не отменена (ждёт, к выплате, запрошена, выплачена). */
const EARNED_STATES: ReadonlySet<SaleState> = new Set<SaleState>(['waiting', 'payable', 'requested', 'paid_out']);

interface LinkRow {
  id: string;
  code: string;
  tour_id: number | null;
  clicks: number | null;
  expires_at: string | null;
  is_active: boolean | null;
  created_at: string;
  tour_title: string | null;
  conversions: number;
}

export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  tourId:    z.coerce.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAgent(request);
  if (auth instanceof NextResponse) return auth;

  try {
    // Воронка по ссылке — все атрибутированные брони (operator_bookings.
    // referral_link_id, миграция 727); rl.conversions — легаси-кэш.
    const { rows } = await pool.query<LinkRow>(
      `SELECT
         rl.id, rl.code, rl.tour_id, rl.clicks,
         rl.expires_at, rl.is_active, rl.created_at,
         ot.title AS tour_title,
         (SELECT COUNT(*) FROM operator_bookings ob WHERE ob.referral_link_id = rl.id)::int AS conversions
       FROM agent_referral_links rl
       LEFT JOIN operator_tours ot ON ot.id = rl.tour_id
       WHERE rl.agent_id = $1
       ORDER BY rl.created_at DESC`,
      [auth.userId]
    );

    // Деньги — ТОЛЬКО из единственной функции денег агента: начислено с
    // оплаченных и не отменённых продаж по текущей ставке агента (снимок —
    // у запрошенных и выплаченных). Прежде здесь суммировались все
    // оплаченные брони × ставку ссылки, включая отменённые.
    const money = await loadAgentMoney(pool, auth.userId);
    const earnedFor = (linkId: string): number | null => {
      if (money.rate === null) return null;
      const amounts = money.sales
        .filter((s) => s.referralLinkId === linkId && EARNED_STATES.has(s.state))
        .map((s) => s.amount ?? 0);
      return Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100;
    };
    const data = rows.map((r) => ({
      ...r,
      paid_sales: money.sales.filter((s) => s.referralLinkId === r.id && EARNED_STATES.has(s.state)).length,
      earned_total: earnedFor(r.id),
    }));

    const stats = {
      totalClicks:      rows.reduce((s, r) => s + Number(r.clicks ?? 0), 0),
      totalConversions: rows.reduce((s, r) => s + Number(r.conversions), 0),
      // null — ставка агента не назначена: считать нечем, это не ноль.
      totalEarned:      money.rate === null
        ? null
        : Math.round(data.reduce((s, r) => s + (r.earned_total ?? 0), 0) * 100) / 100,
      rate:             money.rate,
    };

    return NextResponse.json({ success: true, data, stats });
  } catch (err) {
    logAgentMoneyFailure('GET /api/hub/agent/referral', err);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить реферальные ссылки', sqlstate: sqlstateOf(err) },
      { status: 503 },
    );
  }
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

/**
 * GET /api/cron/referral-census — агентские реферальные ссылки в числах.
 * ТОЛЬКО ЧТЕНИЕ: ни UPDATE, ни INSERT, ни DELETE ни при каком аргументе.
 *
 * ── Повод (20.09) ─────────────────────────────────────────────────────────
 *
 * Владелец попросил запустить программу креаторов (issue #1978). Читая, на
 * чём её строить, нашлись две вещи на денежном пути, и обе — про обещание
 * без исполнения:
 *
 *   • ставку своей комиссии агент задаёт САМ, телом запроса, до 30%
 *     (`POST /api/hub/agent/referral`);
 *   • кабинет показывает ему «заработано» = оплаченные брони × эта ставка,
 *     а пути выплаты агенту в платформе нет вовсе — выплаты есть только
 *     оператору. Ровно случай «обещанный тираж без тиража», как с возвратом
 *     50%, который никогда не переводился (§7).
 *
 * Прежде чем чинить, надо знать РАЗМЕР: заведена ли хоть одна ссылка, с
 * какими ставками, сколько броней ими атрибутировано и сколько из них
 * оплачено. «Наверное, их нет» — не ответ; такое предположение в этом
 * репозитории уже дважды оказывалось втрое неверным («778 мест», «20 туров»).
 *
 * ── Что считается и почему именно так ─────────────────────────────────────
 *
 * `promised_total` — та самая сумма, которую кабинет показывает агентам как
 * начисленную по ссылкам. С 26.09 кабинет считает её единственной функцией
 * денег агента (lib/payments/agent-commission.ts): ставка АГЕНТА
 * (partners.agent_commission_rate), только оплаченные и не отменённые брони.
 * Перепись повторяет то же правило, а не своё: считающая по-своему меряет не
 * то, что видит человек. Ставки ссылок ниже (`links.rate_*`, `by_rate`) —
 * историческая колонка: деньги её больше не читают.
 *
 * Ставка NULL — это «не назначена», и она НЕ приводится к нулю и не к
 * десяти. Такие ссылки идут отдельным счётчиком: ноль процентов и «процент
 * не назначен» — разные состояния (§4.0).
 *
 * Имена и контакты агентов наружу НЕ отдаются: ответ читают в логах Actions,
 * а это персональные данные. Агент виден числом («агентов со ссылками») и,
 * в списке, только идентификатором ссылки.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { CANCELLED_STATUS_PARAM } from '@/lib/payments/release-eligibility';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

/** Потолок списка: ответ читает человек через пробу, а она отдаёт первые байты. */
const MAX_LIMIT     = 200;
const DEFAULT_LIMIT = 50;

interface TotalsRow {
  links_total: string;
  links_active: string;
  links_expired: string;
  links_with_clicks: string;
  links_rate_unset: string;
  agents_total: string;
  clicks_total: string;
  rate_min: string | null;
  rate_max: string | null;
}

interface BookingsRow {
  attributed_total: string;
  attributed_paid: string;
  paid_amount: string;
  promised_total: string;
}

interface RateRow { rate: string | null; links: string }

interface ItemRow {
  code: string;
  rate: string | null;
  clicks: string;
  attributed: string;
  paid: string;
  is_active: boolean | null;
  expired: boolean;
}

async function totals() {
  const { rows } = await pool.query<TotalsRow>(
    `SELECT COUNT(*)::text                                                        AS links_total,
            COUNT(*) FILTER (WHERE is_active)::text                               AS links_active,
            COUNT(*) FILTER (WHERE expires_at IS NOT NULL
                               AND expires_at <= NOW())::text                     AS links_expired,
            COUNT(*) FILTER (WHERE COALESCE(clicks, 0) > 0)::text                 AS links_with_clicks,
            -- Ставка не назначена — отдельное состояние, не ноль и не десять.
            COUNT(*) FILTER (WHERE commission_rate IS NULL)::text                 AS links_rate_unset,
            COUNT(DISTINCT agent_id)::text                                        AS agents_total,
            COALESCE(SUM(clicks), 0)::text                                        AS clicks_total,
            MIN(commission_rate)::text                                            AS rate_min,
            MAX(commission_rate)::text                                            AS rate_max
       FROM agent_referral_links`,
  );
  return rows[0];
}

async function bookings() {
  const { rows } = await pool.query<BookingsRow>(
    `SELECT COUNT(*)::text                                                         AS attributed_total,
            COUNT(*) FILTER (WHERE ob.payment_status = 'paid')::text               AS attributed_paid,
            COALESCE(SUM(ob.final_price)
                     FILTER (WHERE ob.payment_status = 'paid'), 0)::text           AS paid_amount,
            -- ТО ЖЕ правило, что у денег агента (lib/payments/agent-commission):
            -- ставка агента, только оплаченные и НЕ отменённые. Ставка NULL
            -- даёт NULL в сумме и не складывается — «не назначена» не ноль.
            COALESCE(SUM(ob.final_price * p.agent_commission_rate / 100)
                     FILTER (WHERE ob.payment_status = 'paid'
                               AND NOT (ob.booking_status = ANY($1::text[]))), 0)::text AS promised_total
       FROM operator_bookings ob
       JOIN agent_referral_links rl ON rl.id = ob.referral_link_id
       LEFT JOIN partners p ON p.user_id = ob.agent_user_id AND p.category = 'agent'
      WHERE ob.referral_link_id IS NOT NULL`,
    [CANCELLED_STATUS_PARAM],
  );
  return rows[0];
}

async function byRate() {
  const { rows } = await pool.query<RateRow>(
    `SELECT commission_rate::text AS rate, COUNT(*)::text AS links
       FROM agent_referral_links
      GROUP BY commission_rate
      ORDER BY commission_rate NULLS FIRST`,
  );
  return rows;
}

async function items(limit: number, offset: number) {
  const { rows } = await pool.query<ItemRow>(
    `SELECT rl.code,
            rl.commission_rate::text AS rate,
            COALESCE(rl.clicks, 0)::text AS clicks,
            (SELECT COUNT(*) FROM operator_bookings ob
              WHERE ob.referral_link_id = rl.id)::text AS attributed,
            (SELECT COUNT(*) FROM operator_bookings ob
              WHERE ob.referral_link_id = rl.id AND ob.payment_status = 'paid')::text AS paid,
            rl.is_active,
            (rl.expires_at IS NOT NULL AND rl.expires_at <= NOW()) AS expired
       FROM agent_referral_links rl
      ORDER BY rl.commission_rate DESC NULLS LAST, rl.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ ok: false, error: 'Доступ запрещён' }, { status: 401 });
  }

  const url    = new URL(request.url);
  const part   = url.searchParams.get('part') ?? 'both';
  const limit  = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  try {
    const [t, b, rates] = await Promise.all([totals(), bookings(), byRate()]);
    const list = part === 'summary' ? [] : await items(limit, offset);
    const linksTotal = Number(t?.links_total ?? 0);

    return NextResponse.json({
      ok: true,
      probe: 'referral_census_v1',
      method: 'GET',
      links: {
        total:       linksTotal,
        active:      Number(t?.links_active ?? 0),
        expired:     Number(t?.links_expired ?? 0),
        with_clicks: Number(t?.links_with_clicks ?? 0),
        // Ставка не назначена — своё состояние, не ноль.
        rate_unset:  Number(t?.links_rate_unset ?? 0),
        rate_min:    t?.rate_min === null || t?.rate_min === undefined ? null : Number(t.rate_min),
        rate_max:    t?.rate_max === null || t?.rate_max === undefined ? null : Number(t.rate_max),
      },
      agents_total: Number(t?.agents_total ?? 0),
      clicks_total: Number(t?.clicks_total ?? 0),
      by_rate: rates.map(r => ({
        rate:  r.rate === null ? null : Number(r.rate),
        links: Number(r.links),
      })),
      bookings: {
        attributed:      Number(b?.attributed_total ?? 0),
        attributed_paid: Number(b?.attributed_paid ?? 0),
        paid_amount:     Number(b?.paid_amount ?? 0),
        // Сумма, которую кабинет ПОКАЗЫВАЕТ агентам как заработанную. Пути
        // выплаты агенту в платформе нет — значит это обещание, а не долг,
        // и знать его размер надо до того, как оно станет долгом.
        promised_total:  Number(b?.promised_total ?? 0),
      },
      page: part === 'summary' ? undefined : {
        limit, offset, returned: list.length, has_more: offset + list.length < linksTotal,
      },
      // Строкой на ссылку: список читает человек через пробу, а она отдаёт
      // первые N байт. Имён и контактов агента здесь нет намеренно (152-ФЗ):
      // ответ уходит в лог GitHub Actions.
      items: part === 'summary' ? undefined : list.map(r => {
        const rate = r.rate === null ? 'ставка не назначена' : `${Number(r.rate)}%`;
        const state = r.expired ? 'истекла' : r.is_active ? 'активна' : 'выключена';
        return `${r.code} · ${rate} · ${state} · кликов ${r.clicks} · броней ${r.attributed} (оплачено ${r.paid})`;
      }),
      write_note: 'только перепись, роут не пишет вовсе',
      scope_note: 'ставка NULL не приводится ни к нулю, ни к десяти: «не назначена» — отдельное состояние',
      // Ноль строк при ненулевом числе ссылок — отказ выборки, а не «пусто».
      meaningful: part === 'summary' ? linksTotal >= 0 : list.length > 0 || linksTotal === 0,
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[referral-census] перепись не выполнена, SQLSTATE ${code}:`, err);
    return NextResponse.json(
      { ok: false, probe: 'referral_census_v1', error: 'перепись не выполнена', sqlstate: code },
      { status: 503 },
    );
  }
}

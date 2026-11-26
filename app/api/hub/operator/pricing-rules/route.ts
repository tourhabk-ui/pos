/**
 * Скидки оператора на СВОИ туры.
 *
 *   GET    /api/hub/operator/pricing-rules            — правила всех своих туров
 *   POST   /api/hub/operator/pricing-rules            — завести или заменить правило
 *   DELETE /api/hub/operator/pricing-rules?id=X       — снять правило
 *
 * ── Зачем (владелец 27.09: «нужно чтоб всё работало, а не театр») ──────────
 *
 * Движок скидок в платформе был, применялся, и с 27.09 его видит турист на
 * форме брони. Только назначить скидку не мог НИКТО, кроме администратора:
 * единственный экран правил жил под `/hub/admin/pricing`, а у оператора —
 * того, кто владеет туром и решает его цену, — такого экрана не было вовсе.
 * Значит правил на проде ноль, и турист видел ту же цену, что и до всей
 * работы: механизм без производителя (§10.09).
 *
 * ── Что здесь НАРОЧНО проще админского экрана ─────────────────────────────
 *
 * Оператору отданы ДВА рода правил из семи:
 *
 *   last_minute    — «скидка на последние места»: за сколько дней до выезда и
 *                    сколько процентов. Это то, что нужно жителю края,
 *                    который может выехать завтра;
 *   group_discount — «скидка группе»: от сколько человек и сколько процентов.
 *
 * Сезонные окна, надбавка за заполненность и раннее бронирование остаются у
 * администратора: они меняют цену ВВЕРХ или на длинных окнах, и отдавать их
 * без разговора с владельцем нельзя. Список расширяется решением, а не
 * случайно — `OPERATOR_RULE_TYPES` заморожен сторожем.
 *
 * Оператор задаёт ПРОЦЕНТ СКИДКИ (1..50), а не множитель: множитель 0.85 —
 * язык кода, «−15%» — язык человека, и путаница между ними стоила бы денег
 * (0.15 вместо 0.85 — это скидка 85%). Перевод один, в одну сторону, здесь.
 *
 * ── Своё и чужое ──────────────────────────────────────────────────────────
 *
 * Каждый запрос проверяет, что тур принадлежит ЭТОМУ оператору
 * (`getOperatorPartnerId` + сверка `operator_tours.operator_id`). Иначе
 * оператор назначал бы скидки на чужие туры — то есть распоряжался чужой
 * выручкой. Проверка стоит и на удалении: id правила сам по себе ничего о
 * владельце не говорит.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { managerMay, permissionDenied, requireOperatorTeam } from '@/lib/operators/team-access';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';
import { proposePricingRule, requestRuleRemoval } from '@/lib/tours/pricing-rule-door';
import { z } from 'zod';
import {
  OPERATOR_RULE_TYPES, discountToMultiplier, type OperatorRuleType,
} from '@/lib/tours/operator-discount';

export const dynamic = 'force-dynamic';

const SaveSchema = z.object({
  tourId: z.coerce.number().int().positive(),
  ruleType: z.enum(OPERATOR_RULE_TYPES as unknown as [OperatorRuleType, ...OperatorRuleType[]]),
  /** Процент скидки: 1..50. Ноль — это «скидки нет», и для него есть DELETE. */
  percent: z.coerce.number().int().min(1).max(50),
  /** Для last_minute: за сколько дней до выезда скидка действует. */
  daysBefore: z.coerce.number().int().min(1).max(60).optional(),
  /** Для group_discount: от какого числа человек. */
  guestsMin: z.coerce.number().int().min(2).max(50).optional(),
});

/** Что сказать владельцу после просьбы — словами исхода, а не общим «сохранено». */
const RULE_ASKED_WORDS = {
  pending: 'Скидка отправлена на проверку. Туристы увидят её после одобрения администратором.',
  already_live: 'Такая скидка уже действует.',
  already_pending: 'Такая скидка уже ждёт проверки.',
} as const;

const RULE_REMOVED_WORDS = {
  withdrawn: 'Скидка убрана: на цену она не влияла.',
  removal_pending: 'Просьба снять скидку отправлена на проверку. До решения администратора скидка действует.',
} as const;

export async function GET(request: NextRequest) {
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;
  const operatorId = await getOperatorPartnerId(auth.userId);
  if (!operatorId) {
    return NextResponse.json({ success: false, error: 'Профиль оператора не найден' }, { status: 403 });
  }

  try {
    // Проверка правила (1514): действует только «approved»; остальное владелец
    // видит со своим статусом и причиной отказа. На тур и род строк теперь
    // может быть две: действующее правило и просьба о новом.
    const { rows } = await pool.query(
      `SELECT ot.id::text AS tour_id, ot.title, ot.base_price, ot.price_unit,
              pr.id::text AS rule_id, pr.rule_type, pr.multiplier,
              pr.days_before_max, pr.guests_min, pr.is_active,
              pr.moderation_status, pr.moderation_reason,
              pr.removal_requested_at IS NOT NULL AS removal_asked
         FROM operator_tours ot
         LEFT JOIN tour_pricing_rules pr
           ON pr.operator_tour_id = ot.id AND pr.is_active = TRUE
          AND pr.rule_type = ANY($2::text[])
        WHERE ot.operator_id = $1 AND ot.deleted_at IS NULL AND ot.is_active = TRUE
        ORDER BY ot.title, pr.rule_type, pr.id`,
      [operatorId, [...OPERATOR_RULE_TYPES]],
    );
    return NextResponse.json({ success: true, data: rows });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '?';
    console.error(`[hub/operator/pricing-rules] список не отдан (SQLSTATE ${code}): ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ success: false, error: 'Не удалось прочитать скидки' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  // Скидки — это цены: менеджеру команды — только с правом can_edit_prices,
  // которое даёт владелец кабинета (CRM 2г, решение владельца 11.10).
  const auth = await requireOperatorTeam(request);
  if (auth instanceof NextResponse) return auth;
  if (!managerMay(auth.access, 'can_edit_prices')) return permissionDenied('can_edit_prices');
  const operatorId = auth.partnerId;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }
  const parsed = SaveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message }, { status: 400 });
  }
  const d = parsed.data;

  // Условие рода обязательно: правило `last_minute` без окна дней сработало бы
  // ВСЕГДА и превратило скидку на последние места в постоянную.
  if (d.ruleType === 'last_minute' && d.daysBefore === undefined) {
    return NextResponse.json(
      { success: false, error: 'Укажите, за сколько дней до выезда действует скидка' },
      { status: 400 },
    );
  }
  if (d.ruleType === 'group_discount' && d.guestsMin === undefined) {
    return NextResponse.json(
      { success: false, error: 'Укажите, от какого числа человек действует скидка' },
      { status: 400 },
    );
  }

  try {
    const multiplier = discountToMultiplier(d.percent);
    // Скидка меняет цену, которую видит турист, — на сайт она выходит только
    // после проверки администратором (слово владельца 23.11; дверь одна —
    // lib/tours/pricing-rule-door). Одно правило рода на тур: новая просьба
    // заменяет прежнюю неодобренную, действующая скидка действует до решения.
    const asked = await transaction((client) => proposePricingRule(client, {
      operatorId,
      requestedBy: z.string().uuid().safeParse(auth.userId).success ? auth.userId : null,
      tourId: d.tourId,
      ruleType: d.ruleType,
      multiplier,
      daysBeforeMin: d.ruleType === 'last_minute' ? 0 : null,
      daysBeforeMax: d.ruleType === 'last_minute' ? d.daysBefore ?? null : null,
      guestsMin: d.ruleType === 'group_discount' ? d.guestsMin ?? null : null,
    }));
    if (asked.outcome === 'not_found') {
      return NextResponse.json({ success: false, error: 'Тур не найден' }, { status: 404 });
    }
    return NextResponse.json({
      success: true,
      id: asked.ruleId,
      multiplier,
      state: asked.outcome,
      message: RULE_ASKED_WORDS[asked.outcome],
    }, { status: asked.outcome === 'pending' ? 201 : 200 });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '?';
    console.error(`[hub/operator/pricing-rules] скидка не сохранена (SQLSTATE ${code}): ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ success: false, error: 'Не удалось сохранить скидку' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  // Скидки — это цены: менеджеру команды — только с правом can_edit_prices,
  // которое даёт владелец кабинета (CRM 2г, решение владельца 11.10).
  const auth = await requireOperatorTeam(request);
  if (auth instanceof NextResponse) return auth;
  if (!managerMay(auth.access, 'can_edit_prices')) return permissionDenied('can_edit_prices');
  const operatorId = auth.partnerId;
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ success: false, error: 'id обязателен' }, { status: 400 });

  try {
    if (!/^\d{1,18}$/.test(id)) return NextResponse.json({ success: false, error: 'Скидка не найдена' }, { status: 404 });
    // Владение проверяется в самой двери: id правила сам по себе не говорит,
    // чей это тур. Действующую скидку снимает администратор по просьбе —
    // снятие поднимает цену на сайте; неодобренную владелец убирает сам.
    const removed = await transaction((client) => requestRuleRemoval(client, { operatorId, ruleId: id }));
    if (removed.outcome === 'not_found') {
      return NextResponse.json({ success: false, error: 'Скидка не найдена' }, { status: 404 });
    }
    return NextResponse.json({ success: true, state: removed.outcome, message: RULE_REMOVED_WORDS[removed.outcome] });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '?';
    console.error(`[hub/operator/pricing-rules] скидка не снята (SQLSTATE ${code}): ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ success: false, error: 'Не удалось снять скидку' }, { status: 500 });
  }
}

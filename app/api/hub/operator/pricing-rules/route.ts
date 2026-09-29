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
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { pool } from '@/lib/db-pool';
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

async function ownTourOrNull(operatorId: string, tourId: number): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM operator_tours
      WHERE id = $1 AND operator_id = $2 AND deleted_at IS NULL`,
    [tourId, operatorId],
  );
  return rows.length > 0;
}

export async function GET(request: NextRequest) {
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;
  const operatorId = await getOperatorPartnerId(auth.userId);
  if (!operatorId) {
    return NextResponse.json({ success: false, error: 'Профиль оператора не найден' }, { status: 403 });
  }

  try {
    const { rows } = await pool.query(
      `SELECT ot.id::text AS tour_id, ot.title, ot.base_price, ot.price_unit,
              pr.id::text AS rule_id, pr.rule_type, pr.multiplier,
              pr.days_before_max, pr.guests_min, pr.is_active
         FROM operator_tours ot
         LEFT JOIN tour_pricing_rules pr
           ON pr.operator_tour_id = ot.id AND pr.is_active = TRUE
          AND pr.rule_type = ANY($2::text[])
        WHERE ot.operator_id = $1 AND ot.deleted_at IS NULL AND ot.is_active = TRUE
        ORDER BY ot.title, pr.rule_type`,
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
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;
  const operatorId = await getOperatorPartnerId(auth.userId);
  if (!operatorId) {
    return NextResponse.json({ success: false, error: 'Профиль оператора не найден' }, { status: 403 });
  }

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
    if (!await ownTourOrNull(operatorId, d.tourId)) {
      return NextResponse.json({ success: false, error: 'Тур не найден' }, { status: 404 });
    }

    const multiplier = discountToMultiplier(d.percent);

    // Одно правило одного рода на тур: две «скидки на последние места»
        // перемножились бы, и −15% с −15% дали бы −27,75%.
    const saved = await pool.query<{ id: string }>(
      `WITH off AS (
         UPDATE tour_pricing_rules SET is_active = FALSE
          WHERE operator_tour_id = $1 AND rule_type = $2 AND is_active = TRUE
         RETURNING id
       )
       INSERT INTO tour_pricing_rules
         (operator_tour_id, rule_type, multiplier, days_before_min, days_before_max, guests_min, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING id::text AS id`,
      [
        d.tourId,
        d.ruleType,
        multiplier,
        d.ruleType === 'last_minute' ? 0 : null,
        d.ruleType === 'last_minute' ? d.daysBefore : null,
        d.ruleType === 'group_discount' ? d.guestsMin : null,
      ],
    );
    return NextResponse.json({ success: true, id: saved.rows[0]?.id, multiplier }, { status: 201 });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '?';
    console.error(`[hub/operator/pricing-rules] скидка не сохранена (SQLSTATE ${code}): ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ success: false, error: 'Не удалось сохранить скидку' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;
  const operatorId = await getOperatorPartnerId(auth.userId);
  if (!operatorId) {
    return NextResponse.json({ success: false, error: 'Профиль оператора не найден' }, { status: 403 });
  }
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ success: false, error: 'id обязателен' }, { status: 400 });

  try {
    // Владение проверяется В ЗАПРОСЕ: id правила сам по себе не говорит, чей
    // это тур, а отдельная проверка до удаления оставила бы окно.
    const { rowCount } = await pool.query(
      `UPDATE tour_pricing_rules pr SET is_active = FALSE
         WHERE pr.id = $1
           AND EXISTS (
             SELECT 1 FROM operator_tours ot
              WHERE ot.id = pr.operator_tour_id AND ot.operator_id = $2
           )`,
      [id, operatorId],
    );
    if (!rowCount) {
      return NextResponse.json({ success: false, error: 'Скидка не найдена' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '?';
    console.error(`[hub/operator/pricing-rules] скидка не снята (SQLSTATE ${code}): ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ success: false, error: 'Не удалось снять скидку' }, { status: 500 });
  }
}

/**
 * POST /api/admin/agent-referral/rate — назначить ставку агентской ссылке.
 *
 * Это рука ВЛАДЕЛЬЦА, а не механизм платформы: процент назначает человек и
 * применяет его своим решением. Платформа тут только записывает — кто, что,
 * когда и на каком основании.
 *
 * ── Зачем отдельный роут ──────────────────────────────────────────────────
 *
 * До 20.09 ставку задавал сам агент телом запроса при создании ссылки
 * (`POST /api/hub/agent/referral`), до тридцати процентов. Это убрано:
 * ссылка теперь создаётся БЕЗ ставки, а NULL читается как «не назначена»
 * (миграция 1005 сняла и умолчание `DEFAULT 10` — молчаливая десятка была
 * денежным решением, принятым без человека).
 *
 * Но снять и не дать взамен — значит завести обещание без механизма: ссылки
 * создавались бы, и ни одна не могла бы принести агенту ничего, навсегда.
 * Поэтому правка приходит парой: рука, которой владелец назначает ставку.
 *
 * ── Почему основание обязательно ──────────────────────────────────────────
 *
 * Тот же довод, что у отметки возврата (`/api/admin/finance/refunds`):
 * ставка — денежное решение, и через месяц никто не вспомнит, откуда взялись
 * эти проценты. `reason` обязан называть договорённость, а не быть галочкой;
 * нижняя граница отсекает «ок», не отсекая короткое «по договору от 12.09».
 *
 * Автор и время пишутся рядом со ставкой (`rate_set_by`, `rate_set_at`) —
 * ставка без автора это то же объявленное без источника.
 *
 * ── Чего роут НЕ делает ───────────────────────────────────────────────────
 *
 * Не платит. Пути выплаты агенту в платформе нет вовсе — выплаты есть только
 * оператору (`operator_payouts`). Назначенная ставка означает «столько
 * причитается», а не «столько переведено»; как и с возвратами туристу, до
 * появления выплатного пути перевод делает человек вне платформы.
 *
 * Не трогает ставку комиссии ПЛАТФОРМЫ С ОПЕРАТОРА — ту, что живёт в
 * таблице партнёров и разбирается §7. Это другая величина другой стороны, и
 * путать их нельзя. Имя той колонки здесь намеренно не упоминается дословно:
 * сторож `commission-rate-decided` ищет её по тексту файла и потребовал бы
 * от этого роута объявить, что он делает при пустой ставке, — а он с ней
 * дела не имеет вовсе. Запись в реестр читателей была бы неправдой.
 *
 * Гейт `/api/admin/*` — admin-JWT либо `CRON_SECRET` в заголовке (§7).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const SetRateSchema = z.object({
  code: z.string().trim().min(4).max(32),
  // Верхняя граница та же, что стояла у агента, — но теперь её выбирает не
  // он. Ноль разрешён намеренно: «вознаграждения нет» — законное решение
  // владельца, и оно не равно «ставка не назначена» (§7, «ноль — не пустота»).
  rate: z.number().min(0).max(30),
  reason: z.string().trim()
    .min(8, 'Назовите основание: договорённость, письмо, дату — не галочку')
    .max(500),
});

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = SetRateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  const { code, rate, reason } = parsed.data;

  try {
    const { rows } = await pool.query<{ code: string; commission_rate: string | null }>(
      `UPDATE agent_referral_links
          SET commission_rate = $2,
              rate_set_by     = $3,
              rate_set_at     = NOW(),
              rate_reason     = $4
        WHERE code = $1
        RETURNING code, commission_rate::text`,
      [code.toUpperCase(), rate, auth.userId, reason],
    );

    // Ссылки с таким кодом нет — это отказ, а не тихий ноль изменённых строк.
    if (rows.length === 0) {
      return NextResponse.json(
        { success: false, error: `Ссылки с кодом ${code.toUpperCase()} нет — ставка не назначена` },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: { code: rows[0].code, rate: Number(rows[0].commission_rate) },
      note: 'ставка назначена; выплата агенту платформой не выполняется — путь выплаты не подключён',
    });
  } catch (err) {
    // Отказ не глушится: имя проверки и SQLSTATE в лог (§4.0).
    const sqlstate = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[agent-referral/rate] ставка не назначена, SQLSTATE ${sqlstate}:`, err);
    return NextResponse.json(
      { success: false, error: 'Не удалось назначить ставку', sqlstate },
      { status: 503 },
    );
  }
}

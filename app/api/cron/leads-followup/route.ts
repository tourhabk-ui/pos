/**
 * GET /api/cron/leads-followup
 *
 * Кроn: повторные уведомления по лидам из всех источников.
 *
 * Логика:
 *   1. Находим все лиды со статусом 'new', старше 2 часов.
 *   2. Для каждого лида ищем следующего оператора с подходящими активностями,
 *      ещё не получавшего уведомление об этом лиде.
 *      Если интересы не указаны — берём любого оператора.
 *   3. Если оператор найден — отправляем повторное уведомление.
 *   4. Если операторов больше нет — эскалация к admin + смена статуса на 'contacted'.
 *
 * Защита: заголовок Authorization: Bearer <CRON_SECRET>
 *          или query-параметр ?secret=<CRON_SECRET>
 *
 * Запуск: cron-job.org каждые 30 минут
 *   URL:  https://vedarai.ru/api/cron/leads-followup?secret=<CRON_SECRET>
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

// ── Типы данных ───────────────────────────────────────────────────────────────

interface LeadSourceData {
  source?: string;
  interests?: string[];
  date_from?: string;
  date_to?: string;
  arrival?: string;    // TripPlanner alias for date_from
  departure?: string;  // TripPlanner alias for date_to
  trip_days?: number;
  chat_id?: string;
  notified_operators?: string[];
  followup_count?: number;
  last_followup?: string;
  escalated_to_admin?: boolean;
}

interface FollowupLead {
  id: string;
  name: string;
  phone: string;
  source_data: LeadSourceData;
}

interface OperatorMatch {
  name: string;
  slug: string;
  /** ПД оператору идут сюда. NULL — значит адреса в MAX у него нет. */
  max_chat_id: string | null;
  /** Только для заглушки без ПД, если MAX недоступен. */
  telegram_chat_id: string | null;
}

// ── Утилиты ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Основной обработчик ───────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  // ── Проверка секрета ─────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    // Наружу — общий отказ: чужому знать состав переменных окружения незачем.
    // Внутрь — причина: ненастроенный секрет означает, что followup лидов не
    // работает вовсе, и молчаливый 500 оставил бы это без объяснения.
    console.error('[leads-followup] CRON_SECRET не настроен: крон не выполнится');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Посимвольное сравнение отвечает тем быстрее, чем раньше расходятся строки,
  // и по времени ответа секрет подбирается. В соседних крон-роутах уже
  // timingSafeCompare — здесь оставалось обычное `!==`.
  if (!timingSafeCompare(getCronSecret(request) ?? '', cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }


  try {
    // ── Выбираем лиды, требующие followup ───────────────────────────────────
    // Условия:
    //   - статус 'new' (ещё не обработан)
    //   - источник 'telegram_bot'
    //   - создан более 2 часов назад
    //   - либо ещё не было followup, либо последний followup был > 2 часов назад
    const leadsRes = await pool.query<FollowupLead>(`
      SELECT id::text, name, phone, source_data
      FROM leads
      WHERE status = 'new'
        AND created_at < NOW() - INTERVAL '2 hours'
        AND (
          source_data->>'last_followup' IS NULL
          OR (source_data->>'last_followup')::timestamptz < NOW() - INTERVAL '2 hours'
        )
        AND COALESCE((source_data->>'escalated_to_admin')::boolean, false) = false
      ORDER BY created_at ASC
      LIMIT 20
    `);

    if (leadsRes.rows.length === 0) {
      return NextResponse.json({ ok: true, processed: 0, message: 'Нет лидов для обработки' });
    }

    // Диагностика: у скольких операторов есть адрес в MAX (ПД идут туда) и у
    // скольких — только Telegram (тогда придёт заглушка без имени и телефона).
    const diagRes = await pool.query<{ total: string; with_telegram: string; with_max: string }>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE contacts->>'telegram_chat_id' IS NOT NULL) AS with_telegram,
              COUNT(*) FILTER (WHERE max_chat_id IS NOT NULL) AS with_max
       FROM partners WHERE is_public = TRUE`
    );
    const diag = diagRes.rows[0];

    let processed = 0;
    let escalated = 0;
    let noOperators = 0;

    for (const lead of leadsRes.rows) {
      const sd: LeadSourceData = lead.source_data ?? {};
      const interests = sd.interests ?? [];
      const alreadyNotified = sd.notified_operators ?? [];
      const followupCount = sd.followup_count ?? 0;

      // ── Ищем следующего операторa с подходящими активностями ──────────────
      let nextOperator: OperatorMatch | null = null;

      if (interests.length > 0) {
        const opRes = await pool.query<OperatorMatch>(
          `SELECT p.name, p.slug, p.max_chat_id::text AS max_chat_id,
                  p.contacts->>'telegram_chat_id' AS telegram_chat_id
           FROM partners p
           JOIN operator_tours ot ON ot.operator_id = p.id
           WHERE ot.activity_type = ANY($1)
             AND ot.is_active = TRUE
             AND p.is_public = TRUE
             AND (p.max_chat_id IS NOT NULL OR (p.contacts->>'telegram_chat_id') IS NOT NULL)
             AND NOT (p.slug = ANY($2))
           GROUP BY p.name, p.slug, p.max_chat_id, p.contacts->>'telegram_chat_id'
           LIMIT 1`,
          [interests, alreadyNotified]
        );
        nextOperator = opRes.rows[0] ?? null;
      }

      // Fallback: если нет интересов или не нашли по интересам — любой оператор не из списка
      if (!nextOperator) {
        const fallbackRes = await pool.query<OperatorMatch>(
          `SELECT name, slug, max_chat_id::text AS max_chat_id,
                  contacts->>'telegram_chat_id' AS telegram_chat_id
           FROM partners
           WHERE is_public = TRUE
             AND (max_chat_id IS NOT NULL OR (contacts->>'telegram_chat_id') IS NOT NULL)
             AND NOT (slug = ANY($1))
           LIMIT 1`,
          [alreadyNotified]
        );
        nextOperator = fallbackRes.rows[0] ?? null;
      }

      if (nextOperator) {
        // ── Уведомляем следующего оператора ───────────────────────────────
        const attempt = followupCount + 1;
        const head = attempt === 1
          ? '<b>Напоминание: горячий лид</b>'
          : `<b>Повторное уведомление (попытка ${attempt})</b>`;
        const facts = [
          interests.length > 0 ? `<b>Интересы:</b> ${interests.join(', ')}` : '',
          (sd.date_from ?? sd.arrival) ? `<b>Даты:</b> ${sd.date_from ?? sd.arrival} — ${sd.date_to ?? sd.departure}` : '',
        ].filter(Boolean);

        const msgLines = [
          head,
          '',
          `<b>Имя:</b> ${esc(lead.name)}`,
          `<b>Телефон:</b> ${esc(lead.phone)}`,
          ...facts,
          '',
          'Турист ещё не получил ответа — свяжитесь с ним.',
        ].join('\n');

        const stubLines = [
          head,
          '',
          `Заявка <code>${esc(lead.id)}</code> ждёт ответа.`,
          ...facts,
          '',
          'Имя и телефон — в MAX и в кабинете: в Telegram они не передаются.',
        ].join('\n');

        const opRes2 = await sendPdAlert({
          text: msgLines,
          stub: stubLines,
          buttons: [{ text: 'Открыть в CRM', url: `${getPublicBaseUrl()}/hub/operator/leads/${lead.id}` }],
          to: { maxChatId: nextOperator.max_chat_id, telegramChatId: nextOperator.telegram_chat_id },
        });
        if (!opRes2.delivered) {
          console.error(`[cron/leads-followup] ${nextOperator.slug}: ПД не доставлены (${opRes2.channel}) — ${opRes2.reason}`);
        }

        // ── Обновляем source_data ──────────────────────────────────────────
        const newNotified = [...alreadyNotified, nextOperator.slug];
        await pool.query(
          `UPDATE leads
           SET source_data = source_data || $1::jsonb,
               updated_at  = NOW()
           WHERE id = $2`,
          [
            JSON.stringify({
              notified_operators: newNotified,
              followup_count: attempt,
              last_followup: new Date().toISOString(),
            }),
            lead.id,
          ]
        );

      } else {
        // ── Операторы кончились — эскалация к admin ────────────────────────
        noOperators++;
        escalated++;
        const admFacts = [
          interests.length > 0 ? `<b>Интересы:</b> ${interests.join(', ')}` : '',
          (sd.date_from ?? sd.arrival) ? `<b>Даты:</b> ${sd.date_from ?? sd.arrival} — ${sd.date_to ?? sd.departure}` : '',
          `<b>Уведомлений отправлено:</b> ${followupCount}`,
        ].filter(Boolean);

        const admRes = await sendPdAlert({
          text: [
            '<b>Лид без ответа — нужна ручная обработка</b>',
            '',
            `<b>Имя:</b> ${esc(lead.name)}`,
            `<b>Телефон:</b> ${esc(lead.phone)}`,
            ...admFacts,
            '',
            'Свободных операторов не осталось.',
            `<code>${esc(lead.id)}</code>`,
          ].join('\n'),
          stub: [
            '<b>Лид без ответа — нужна ручная обработка</b>',
            '',
            `Заявка <code>${esc(lead.id)}</code>.`,
            ...admFacts,
            '',
            'Свободных операторов не осталось. Имя и телефон — в MAX и в кабинете.',
          ].join('\n'),
          buttons: [{ text: 'CRM лиды', url: `${getPublicBaseUrl()}/hub/operator/leads/${lead.id}` }],
        });
        if (!admRes.delivered) {
          console.error(`[cron/leads-followup] эскалация ${lead.id}: ПД не доставлены (${admRes.channel}) — ${admRes.reason}`);
        }

        // Меняем статус на 'contacted' + помечаем как обработанный кроном
        await pool.query(
          `UPDATE leads
           SET status      = 'contacted',
               source_data = source_data || $1::jsonb,
               updated_at  = NOW()
           WHERE id = $2`,
          [
            JSON.stringify({
              followup_count: followupCount + 1,
              last_followup: new Date().toISOString(),
              escalated_to_admin: true,
            }),
            lead.id,
          ]
        );
      }

      processed++;
    }

    return NextResponse.json({
      ok: true,
      processed,
      escalated_to_admin: escalated,
      no_operator_found: noOperators,
      leads_found: leadsRes.rows.length,
      operators_total: Number(diag.total),
      operators_with_telegram: Number(diag.with_telegram),
      operators_with_max: Number(diag.with_max),
      warning: Number(diag.with_max) === 0
        ? 'Ни у одного оператора нет max_chat_id — имя и телефон туриста им не уходят, приходит только заглушка. Привяжите оператора к MAX.'
        : Number(diag.with_max) + Number(diag.with_telegram) === 0
          ? 'Ни один оператор не достижим ни в MAX, ни в Telegram — все лиды эскалируются к admin.'
          : null,
    });

  } catch (err) {
    return NextResponse.json({ ok: false, error: 'Internal error' }, { status: 500 });
  }
}

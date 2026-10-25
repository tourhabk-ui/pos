/**
 * Списки кабинета прокатчика: его заявки и его черновики.
 * Партнёр — из привязанного чата. Чужие строки запрос не видит.
 * Отказ базы — отдельный исход, с SQLSTATE в логе, без персональных данных.
 */

import { pool } from '@/lib/db-pool';
import { escapeHtml } from '@/lib/text/escape-html';
import { formatRub } from '@/lib/transfers/charter-format';
import { offerEditFormatHint } from '@/lib/rental/offer-edit';
import { rentalAnswerButtons } from '@/lib/rental/request-answer';
import type { CabinetButton } from '@/lib/rental/cabinet-bar';

export interface CabinetRequestRow {
  leadId: string;
  name: string;
  phone: string;
  title: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  answer: 'take' | 'decline' | null;
}

export type CabinetRequests = { outcome: 'ok'; rows: CabinetRequestRow[] } | { outcome: 'db_error' };

export interface CabinetEditRow {
  title: string;
  livePrice: number;
  priceIsFrom: boolean;
  draftPrice: number | null;
  draftConditions: string | null;
}

export type CabinetEdits = { outcome: 'ok'; rows: CabinetEditRow[] } | { outcome: 'db_error' };

/** Пять с кнопками и одна лишняя, чтобы честно сказать «есть старше». */
const REQUEST_LIMIT = 6;
const EDIT_LIMIT = 20;

function sqlState(err: unknown): string {
  return (err as { code?: string }).code ?? 'нет';
}

function asAnswer(value: string | null): 'take' | 'decline' | null {
  if (value === 'take' || value === 'decline') return value;
  return null;
}

const REQUESTS_SQL = `SELECT l.id::text AS id,
          COALESCE(l.name, '') AS name,
          COALESCE(l.phone, '') AS phone,
          NULLIF(btrim(l.source_data->>'offer_title'), '') AS title,
          NULLIF(btrim(l.source_data->>'date_from'), '') AS date_from,
          NULLIF(btrim(l.source_data->>'date_to'), '') AS date_to,
          (
            SELECT a.details->>'answer'
              FROM lead_activity_log a
             WHERE a.lead_id = l.id AND a.action = 'partner_answered'
             ORDER BY a.id DESC
             LIMIT 1
          ) AS answer
     FROM leads l
    WHERE l.operator_id = $1::uuid
      AND l.source_data->>'kind' = 'car_rental'
      AND (l.source_data->>'company_id' IS NULL OR l.source_data->>'company_id' = $1::text)
    ORDER BY l.created_at DESC NULLS LAST, l.id DESC
    LIMIT ${REQUEST_LIMIT}`;

export async function loadCabinetRequests(partnerId: string): Promise<CabinetRequests> {
  try {
    const { rows } = await pool.query<{
      id: string; name: string; phone: string; title: string | null;
      date_from: string | null; date_to: string | null; answer: string | null;
    }>(REQUESTS_SQL, [partnerId]);
    return {
      outcome: 'ok',
      rows: rows.map((r) => ({
        leadId: r.id,
        name: r.name,
        phone: r.phone,
        title: r.title,
        dateFrom: r.date_from,
        dateTo: r.date_to,
        answer: asAnswer(r.answer),
      })),
    };
  } catch (err) {
    console.error('[rental-cabinet] заявки не прочитаны, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
}

const EDITS_SQL = `SELECT o.title,
          o.price_rub_per_day AS live_price,
          o.price_is_from,
          e.price_rub_per_day AS draft_price,
          e.conditions AS draft_conditions
     FROM rental_offer_edits e
     JOIN car_rental_offers o ON o.id = e.offer_id AND o.partner_id = e.partner_id
    WHERE e.partner_id = $1::uuid
      AND e.moderation_status = 'pending'
    ORDER BY e.created_at, e.id
    LIMIT ${EDIT_LIMIT}`;

export async function loadCabinetEdits(partnerId: string): Promise<CabinetEdits> {
  try {
    const { rows } = await pool.query<{
      title: string; live_price: number; price_is_from: boolean;
      draft_price: number | null; draft_conditions: string | null;
    }>(EDITS_SQL, [partnerId]);
    return {
      outcome: 'ok',
      rows: rows.map((r) => ({
        title: r.title,
        livePrice: r.live_price,
        priceIsFrom: r.price_is_from === true,
        draftPrice: r.draft_price,
        draftConditions: r.draft_conditions,
      })),
    };
  } catch (err) {
    console.error('[rental-cabinet] правки не прочитаны, SQLSTATE', sqlState(err));
    return { outcome: 'db_error' };
  }
}

/**
 * Список заявок. Имя и телефон — только в MAX: в Telegram их нет,
 * как и в заглушке уведомления. «Беру №N» / «Не могу №N» — у заявки без
 * ответа, с номером её строки.
 */
export function rentalRequestsView(
  loaded: CabinetRequests,
  channel: 'max' | 'telegram',
): { text: string; buttons: CabinetButton[][] } {
  if (loaded.outcome === 'db_error') {
    return {
      text: 'Не удалось прочитать заявки. Не говорю, что их нет. Спросите ещё раз.',
      buttons: [],
    };
  }
  if (loaded.rows.length === 0) {
    return { text: 'Заявок на прокат пока нет.', buttons: [] };
  }
  const shown = loaded.rows.slice(0, REQUEST_LIMIT - 1);
  const lines = [
    'Заявки на прокат. «Беру» отмечает дни занятыми и не закрепляет машину на сайте. «Не могу» дни не занимает.',
  ];
  if (channel === 'telegram') {
    lines.push('Имя и телефон заказчика в Telegram не передаются — они в MAX.');
  }
  const buttons: CabinetButton[][] = [];
  shown.forEach((r, i) => {
    const car = r.title ? escapeHtml(r.title) : 'машина в заявке не названа';
    const dates = r.dateFrom && r.dateTo
      ? `${escapeHtml(r.dateFrom)} — ${escapeHtml(r.dateTo)}`
      : 'даты не записаны';
    const ans = r.answer === 'take' ? 'ответ: беру' : r.answer === 'decline' ? 'ответ: не могу' : 'ответа нет';
    const who = channel === 'max'
      ? ` ${escapeHtml(r.name.trim() || 'имя не записано')}, ${escapeHtml(r.phone.trim() || 'телефон не записан')}.`
      : '';
    lines.push(`${i + 1}. ${car}. ${dates}. ${ans}.${who}`);
    if (!r.answer) {
      // Кнопка называет номер строки: пар под сообщением несколько, ответ необратим.
      const pair = rentalAnswerButtons(r.leadId, i + 1);
      if (pair) buttons.push(pair);
    }
  });
  if (loaded.rows.length > shown.length) {
    lines.push('Есть заявки старше этих. В этом сообщении их нет.');
  }
  return { text: lines.join('\n'), buttons };
}

export function rentalEditsText(loaded: CabinetEdits): string {
  if (loaded.outcome === 'db_error') {
    return 'Не удалось прочитать правки. Не говорю, что черновиков нет. Спросите ещё раз.';
  }
  if (loaded.rows.length === 0) {
    return `Черновиков на модерации нет. На сайте действующий прайс.\n${offerEditFormatHint()}`;
  }
  const lines = ['Правки на модерации. На сайте до одобрения прежняя строка.'];
  for (const r of loaded.rows) {
    const bits = [`«${escapeHtml(r.title)}»`];
    if (r.draftPrice !== null) {
      bits.push(`черновик цены ${formatRub(r.draftPrice)} за сутки, в прайсе сейчас ${formatRub(r.livePrice)}`);
      if (r.priceIsFrom) bits.push('в прайсе цена записана как «от», черновик эту пометку не снимает');
    }
    if (r.draftConditions !== null) bits.push(`черновик описания: ${escapeHtml(r.draftConditions)}`);
    lines.push(`- ${bits.join('. ')}.`);
  }
  lines.push(offerEditFormatHint());
  return lines.join('\n');
}

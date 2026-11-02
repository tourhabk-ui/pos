/**
 * Состояние мессенджеров партнёра для админки (форма «Редактирование
 * партнёра», 02.11: владелец спросил «а где у них подключение макс и тг?»).
 *
 * «Подключён» — по тому же правилу, по которому уходят заявки
 * (`reachForPartner`: колонки партнёра и Telegram аккаунта владельца), а не по
 * contacts JSONB. Наружу — только да/нет и НАЗВАНИЯ других карточек на том же
 * чате (один чат может вести несколько карточек, кабинет в нём — у старшей).
 * Ни chat id, ни телефонов в ответе нет.
 *
 * Исходы (§4.0): состояние / партнёра нет (`null`) / база не ответила (throw —
 * роут отвечает 500, а не «не подключён»).
 */

import { pool } from '@/lib/db-pool';
import { reachForPartner } from '@/lib/partners/reach';

export interface PartnerChannelStatus {
  max: boolean;
  telegram: boolean;
  /** Другие карточки, подключённые к тому же чату MAX или Telegram. */
  sharedWith: string[];
  /** Чей кабинет открывается в общем чате, если не этой карточки. */
  cabinetOf: string | null;
}

interface SharedRow {
  id: string;
  name: string;
  same_max: boolean;
  same_tg: boolean;
  max_first: boolean;
  tg_first: boolean;
}

export async function partnerChannelStatus(partnerId: string): Promise<PartnerChannelStatus | null> {
  const reach = await reachForPartner(partnerId);
  if (!reach) {
    const { rows } = await pool.query(`SELECT 1 FROM partners WHERE id = $1::uuid`, [partnerId]);
    if (rows.length === 0) return null;
    throw new Error('reach_unavailable');
  }
  const { rows } = await pool.query<SharedRow>(
    `WITH me AS (SELECT max_chat_id, telegram_chat_id FROM partners WHERE id = $1::uuid)
     SELECT o.id::text AS id,
            COALESCE(NULLIF(btrim(o.company_name), ''), o.name) AS name,
            (me.max_chat_id IS NOT NULL AND o.max_chat_id = me.max_chat_id) AS same_max,
            (me.telegram_chat_id IS NOT NULL AND o.telegram_chat_id = me.telegram_chat_id) AS same_tg,
            o.id = (SELECT f.id FROM partners f WHERE f.max_chat_id = me.max_chat_id
                     ORDER BY f.created_at ASC NULLS LAST, f.id ASC LIMIT 1) AS max_first,
            o.id = (SELECT f.id FROM partners f WHERE f.telegram_chat_id = me.telegram_chat_id
                     ORDER BY f.created_at ASC NULLS LAST, f.id ASC LIMIT 1) AS tg_first
       FROM partners o, me
      WHERE o.id <> $1::uuid
        AND ((me.max_chat_id IS NOT NULL AND o.max_chat_id = me.max_chat_id)
          OR (me.telegram_chat_id IS NOT NULL AND o.telegram_chat_id = me.telegram_chat_id))
      ORDER BY o.created_at ASC NULLS LAST, o.id ASC`,
    [partnerId],
  );
  const cabinet = rows.find((r) => (r.same_max && r.max_first) || (r.same_tg && r.tg_first));
  return {
    max: reach.maxChatId !== null,
    telegram: reach.telegramChatId !== null,
    sharedWith: rows.map((r) => r.name),
    cabinetOf: cabinet ? cabinet.name : null,
  };
}

/**
 * Чат менеджера команды оператора → его строка команды и кабинет (слово
 * владельца 30.10: «менеджеры оператора» в кабинете в чате; брони, как и
 * прежде, подтверждает только владелец).
 *
 * Чат менеджер привязывает своей ссылкой `om_` (lib/operators/member-channel),
 * адрес лежит в его строке `operator_members` (1230), а не в карточке
 * партнёра. Поэтому `findPartnerByChat` его не находит — и до 30.10 текст
 * менеджера в его чате уходил Кузьмичу туриста, а кнопки кабинета отвечали
 * «чат не подключён». Здесь — обратный поиск: чат → активная строка команды
 * → карточка оператора.
 *
 * Правила:
 *  - только активная строка с аккаунтом (`status = 'active'`, `user_id`):
 *    снятый менеджер чат теряет сразу — статус читается на каждом
 *    сообщении и нажатии, адреса стирает и само снятие (lib/operators/team);
 *  - чат партнёра главнее: вызывающий спрашивает сначала `findPartnerByChat`,
 *    сюда — только когда чат не чат карточки;
 *  - один чат у двух команд — не угадываем, чей он: «не смог проверить»
 *    (§4.0), в лог — без чата и людей;
 *  - аккаунт для записи — менеджера (`userId`): «Готово» по задаче и звонок
 *    клиенту записываются им, а не владельцем.
 */

import { pool } from '@/lib/db-pool';
import { crmCategoryFor } from '@/lib/crm/partner-context';
import type { PartnerChatContext } from '@/lib/kuzmich/operator-chat';

export interface MemberChatContext {
  memberId: string;
  /** Карточка оператора, а `userId` в ней — аккаунт менеджера, не владельца. */
  partner: PartnerChatContext;
  /** Подпись строки команды (`operator_members.label`), если есть. */
  label: string | null;
}

export type MemberChatLookup =
  | { outcome: 'found'; member: MemberChatContext }
  | { outcome: 'none' }
  | { outcome: 'unavailable' };

const CHAT_COLUMN = { telegram: 'telegram_chat_id', max: 'max_chat_id' } as const;

export const MEMBER_BY_CHAT_SQL = {
  telegram: memberSql('telegram_chat_id'),
  max: memberSql('max_chat_id'),
} as const;

function memberSql(column: (typeof CHAT_COLUMN)[keyof typeof CHAT_COLUMN]): string {
  return `
  SELECT m.id::text AS member_id, m.user_id::text AS user_id, NULLIF(btrim(m.label), '') AS label,
         p.id::text AS partner_id, NULLIF(btrim(p.slug), '') AS slug, COALESCE(p.company_name, p.name) AS name,
         p.category, p.profile_status,
         EXISTS (SELECT 1 FROM operator_tours own
                  WHERE own.operator_id = p.id AND own.deleted_at IS NULL) AS sells_tours
    FROM operator_members m
    JOIN partners p ON p.id = m.partner_id AND p.category = 'operator'
   WHERE m.${column} = $1 AND m.status = 'active' AND m.user_id IS NOT NULL
   ORDER BY m.channel_bound_at DESC NULLS LAST, m.id ASC
   LIMIT 2`;
}

interface Row {
  member_id: string;
  user_id: string;
  label: string | null;
  partner_id: string;
  slug: string | null;
  name: string;
  category: string;
  profile_status: string | null;
  sells_tours: boolean | null;
}

export async function findMemberByChat(
  channel: keyof typeof CHAT_COLUMN,
  chatId: number,
  db: Pick<typeof pool, 'query'> = pool,
): Promise<MemberChatLookup> {
  let rows: Row[];
  try {
    ({ rows } = await db.query<Row>(MEMBER_BY_CHAT_SQL[channel], [chatId]));
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error(`[member-chat] менеджер по чату ${channel} не прочитан, SQLSTATE`, code);
    return { outcome: 'unavailable' };
  }
  const [row, second] = rows;
  if (!row) return { outcome: 'none' };
  if (second && second.partner_id !== row.partner_id) {
    console.error(`[member-chat] один чат ${channel} у менеджеров двух команд — кабинет не открыт`);
    return { outcome: 'unavailable' };
  }
  return {
    outcome: 'found',
    member: {
      memberId: row.member_id,
      label: row.label,
      partner: {
        partnerId: row.partner_id,
        partnerName: row.name,
        slug: row.slug,
        category: row.category,
        crmCategory: crmCategoryFor(row.category, row.profile_status),
        userId: row.user_id,
        sellsTours: row.sells_tours === true,
      },
    },
  };
}

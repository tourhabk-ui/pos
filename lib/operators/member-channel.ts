/**
 * Мессенджер менеджера команды оператора (CRM 2г-4, решение владельца 11.10:
 * «уведомления менеджерам — да»).
 *
 * Зачем. До 2г-4 о новой брони, заявке и запросе мест узнавал только чат
 * кабинета (partners.max_chat_id / telegram_chat_id) — то есть владелец.
 * Менеджер работал в кабинете, но о том, что пришла работа, узнавал, только
 * открыв его. Колонка партнёра одна, второй чат её перезаписал бы и увёл
 * заявки владельца (lib/partners/bind-channel) — поэтому у менеджера свой адрес
 * в своей строке команды: operator_members.max_chat_id / telegram_chat_id
 * (миграция 1230).
 *
 * Кто выдаёт ссылку. Только сам менеджер, своим входом
 * (`/api/hub/operator/me/messenger`, POST): id строки команды берётся из гарда, не
 * из запроса — чужую строку не назначить. Владелец свой чат подключает к
 * кабинету прежней ссылкой `op_` (lib/partners/channel-link).
 *
 * Токен — тот же формат, что у ссылки кабинета (HMAC над id и сроком, 43 знака
 * base64url, лимит Telegram на `start`), но своя метка домена
 * `operator-member-channel-link:v1` и свой префикс `om_`: ссылка кабинета здесь
 * не проходит, и наоборот. Без запасного dev-секрета — по той же причине, что у
 * ссылки кабинета: ссылка решает, в чей чат уйдут имя и телефон туриста.
 *
 * Срок — 24 часа, а не 72: ссылку не пересылают другому человеку, менеджер
 * открывает её сам из своего кабинета. Утёкшая должна протухать быстрее.
 *
 * Привязка видна: о ней узнаёт чат кабинета (владелец) и, при перепривязке,
 * прежний чат менеджера. Снятому менеджеру (status = 'revoked') ни привязать,
 * ни получить уже нечего: запись идёт только в активную строку, а снятие
 * стирает адреса (lib/operators/team, revokeMember).
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { pool } from '@/lib/db-pool';
import { escapeHtml } from '@/lib/text/escape-html';
import { maxSendDm } from '@/lib/notifications/max-channel';
import { telegramService } from '@/lib/notifications/telegram';
import { reachForPartner } from '@/lib/partners/reach';
import { sendPartnerNotice } from '@/lib/partners/notice';
import { getPublicBaseUrl } from '@/lib/config';
import { maxBot, telegramBot } from '@/lib/partners/channel-link';

export const MEMBER_LINK_PREFIX = 'om_';
export const MEMBER_LINK_TTL_MS = 24 * 60 * 60 * 1000;

const DOMAIN = 'operator-member-channel-link:v1';
const MAC_BYTES = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secret(): string | null {
  const s = process.env.CONNECT_TOKEN_SECRET || process.env.JWT_SECRET || '';
  return s.length >= 16 ? s : null;
}

function mac(key: string, data: Buffer): Buffer {
  return createHmac('sha256', key).update(DOMAIN).update(data).digest().subarray(0, MAC_BYTES);
}

export type MemberTokenResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: 'no_secret' | 'bad_member_id' };

export function createMemberLinkToken(memberId: string, now: number = Date.now()): MemberTokenResult {
  const key = secret();
  if (!key) return { ok: false, reason: 'no_secret' };
  if (!UUID_RE.test(memberId)) return { ok: false, reason: 'bad_member_id' };
  const expiresMin = Math.ceil((now + MEMBER_LINK_TTL_MS) / 60_000);
  const data = Buffer.alloc(20);
  Buffer.from(memberId.replace(/-/g, ''), 'hex').copy(data, 0);
  data.writeUInt32BE(expiresMin, 16);
  return { ok: true, token: Buffer.concat([data, mac(key, data)]).toString('base64url'), expiresAt: new Date(expiresMin * 60_000) };
}

export type MemberTokenCheck =
  | { ok: true; memberId: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'no_secret' };

export function verifyMemberLinkToken(token: string, now: number = Date.now()): MemberTokenCheck {
  const key = secret();
  if (!key) return { ok: false, reason: 'no_secret' };
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, reason: 'malformed' };
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== 20 + MAC_BYTES) return { ok: false, reason: 'malformed' };
  const data = raw.subarray(0, 20);
  if (!timingSafeEqual(raw.subarray(20), mac(key, data))) return { ok: false, reason: 'bad_signature' };
  if (now > data.readUInt32BE(16) * 60_000) return { ok: false, reason: 'expired' };
  const hex = data.subarray(0, 16).toString('hex');
  return { ok: true, memberId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` };
}

export type MemberLinks =
  | { ok: true; telegram: string; max: string; expiresAt: Date }
  | { ok: false; reason: 'no_secret' | 'bad_member_id' };

export function buildMemberChannelLinks(memberId: string, now: number = Date.now()): MemberLinks {
  const t = createMemberLinkToken(memberId, now);
  if (!t.ok) return t;
  const start = `${MEMBER_LINK_PREFIX}${t.token}`;
  return { ok: true, telegram: `https://t.me/${telegramBot()}?start=${start}`, max: `${maxBot()}?start=${start}`, expiresAt: t.expiresAt };
}

export function memberTokenFromStart(arg: string): string | null {
  return arg.startsWith(MEMBER_LINK_PREFIX) ? arg.slice(MEMBER_LINK_PREFIX.length) : null;
}

// ── Запись чата в строку команды ──────────────────────────────────────────

export type MemberChannel = 'telegram' | 'max';
const CHANNEL_LABEL: Record<MemberChannel, string> = { telegram: 'Telegram', max: 'MAX' };

export type MemberBindResult =
  | { ok: true; partnerId: string; partnerName: string; label: string | null; previousChatId: string | null; rebound: boolean }
  | { ok: false; reason: 'not_active' | 'db_error' };

/**
 * Записать чат менеджеру. Только в АКТИВНУЮ строку команды: снятого или ещё
 * не принявшего приглашение по ссылке не подключить. Прежнее значение
 * читается тем же запросом, что пишет, — окна между чтением и записью нет.
 */
export async function bindMemberChannel(memberId: string, channel: MemberChannel, chatId: number): Promise<MemberBindResult> {
  if (!Number.isSafeInteger(chatId)) return { ok: false, reason: 'db_error' };
  const sql = channel === 'telegram'
    ? `UPDATE operator_members m
          SET telegram_chat_id = $1::bigint, channel_bound_at = NOW(), updated_at = NOW()
         FROM (SELECT id, telegram_chat_id::text AS old FROM operator_members WHERE id = $2::uuid) prev,
              partners p
        WHERE m.id = prev.id AND m.status = 'active' AND p.id = m.partner_id
        RETURNING m.partner_id::text AS partner_id, p.name AS partner_name, m.label, prev.old AS previous`
    : `UPDATE operator_members m
          SET max_chat_id = $1::bigint, channel_bound_at = NOW(), updated_at = NOW()
         FROM (SELECT id, max_chat_id::text AS old FROM operator_members WHERE id = $2::uuid) prev,
              partners p
        WHERE m.id = prev.id AND m.status = 'active' AND p.id = m.partner_id
        RETURNING m.partner_id::text AS partner_id, p.name AS partner_name, m.label, prev.old AS previous`;
  type BindRow = { partner_id: string; partner_name: string; label: string | null; previous: string | null };
  let row: BindRow | undefined;
  try {
    ({ rows: [row] } = await pool.query<BindRow>(sql, [String(chatId), memberId]));
  } catch (err) {
    console.error(`[member-channel] ${CHANNEL_LABEL[channel]} менеджера ${memberId} не записан, SQLSTATE`,
      (err as { code?: string } | null)?.code ?? 'нет');
    return { ok: false, reason: 'db_error' };
  }
  if (!row) return { ok: false, reason: 'not_active' };
  const rebound = row.previous !== null && row.previous !== String(chatId);
  await announceMemberBinding(channel, row, rebound);
  return { ok: true, partnerId: row.partner_id, partnerName: row.partner_name, label: row.label, previousChatId: row.previous, rebound };
}

/**
 * Владелец узнаёт, что заявки кабинета теперь приходят ещё и в чат менеджера
 * (в них имена и телефоны туристов); прежний чат менеджера — что они туда
 * больше не идут. ПД в этих сообщениях нет. Отказ отправки привязку не
 * отменяет, но пишется в лог.
 */
async function announceMemberBinding(
  channel: MemberChannel,
  row: { partner_id: string; partner_name: string; label: string | null; previous: string | null },
  rebound: boolean,
): Promise<void> {
  const who = row.label ? `«${escapeHtml(row.label)}»` : 'команды';
  const reach = await reachForPartner(row.partner_id);
  if (reach?.reachable) {
    const sent = await sendPartnerNotice(
      { maxChatId: reach.maxChatId, telegramChatId: reach.telegramChatId },
      rebound
        ? `Уведомления кабинета для менеджера ${who} перенесены в другой чат ${CHANNEL_LABEL[channel]}. Если вы этого не ждали — снимите менеджера в разделе «Команда».`
        : `К уведомлениям кабинета подключён ${CHANNEL_LABEL[channel]} менеджера ${who}: новые брони, заявки, запросы мест и напоминания о задачах будут приходить и туда.`,
      { text: 'Команда', url: `${getPublicBaseUrl()}/hub/operator/team` },
      `кабинету ${row.partner_id} о канале менеджера`,
    );
    if (!sent) console.error(`[member-channel] владелец кабинета ${row.partner_id} о канале менеджера не уведомлён`);
  } else if (reach === null) {
    console.error(`[member-channel] адрес кабинета ${row.partner_id} не прочитан — владелец о канале менеджера не уведомлён`);
  }
  if (!rebound || row.previous === null) return;
  const notice = `Уведомления кабинета «${escapeHtml(row.partner_name)}» больше не приходят в этот чат — их перенесли в другой. Если это сделали не вы, скажите владельцу кабинета.`;
  if (channel === 'telegram') {
    const res = await telegramService.sendMessage({ chatId: row.previous, text: notice });
    if (!res.success) console.error(`[member-channel] прежний Telegram-чат менеджера не уведомлён: ${res.error ?? 'нет ответа'}`);
  } else {
    const res = await maxSendDm(row.previous, notice);
    if (!res.ok) console.error(`[member-channel] прежний MAX-чат менеджера не уведомлён: ${res.error ?? 'нет ответа'}`);
  }
}

/** Менеджер сам отключает свой мессенджер. false — строки нет; бросает на сбое базы. */
export async function unbindMemberChannel(memberId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE operator_members
        SET max_chat_id = NULL, telegram_chat_id = NULL, channel_bound_at = NULL, updated_at = NOW()
      WHERE id = $1::uuid`,
    [memberId],
  );
  return (rowCount ?? 0) > 0;
}

export function memberBindReplyText(channel: MemberChannel, result: MemberBindResult): string {
  if (!result.ok) {
    return result.reason === 'not_active'
      ? 'Эта ссылка больше не действует: вас нет в команде кабинета. Спросите владельца кабинета.'
      : 'Не удалось сохранить подключение — база не ответила. Откройте ссылку ещё раз через несколько минут.';
  }
  const tail = channel === 'telegram'
    ? 'Сюда будут приходить номера броней и заявок и ссылки в кабинет. Имя и телефон туриста по закону о персональных данных приходят только в MAX — подключите и его.'
    : 'Сюда будут приходить новые брони, заявки, запросы мест и напоминания о задачах кабинета — с именами и телефонами клиентов.';
  return `Готово: ${CHANNEL_LABEL[channel]} подключён к уведомлениям кабинета «${escapeHtml(result.partnerName)}». ${tail} ${MEMBER_CABINET_HINT}`;
}

/**
 * Кабинет в чате у менеджера (30.10): тот же, что у владельца, кроме кнопок
 * ответа на бронь и заявку — они у чата карточки.
 */
export const MEMBER_CABINET_HINT =
  'Напишите «Входящие», «Задачи» или «Клиенты» — откроется кабинет в чате; звонок клиенту и задача запишутся от вас. Брони подтверждает владелец кабинета.';

export function memberBadLinkReplyText(reason: 'malformed' | 'bad_signature' | 'expired' | 'no_secret'): string {
  if (reason === 'expired') return 'Ссылка для подключения устарела (действует сутки). Возьмите новую в своём кабинете.';
  if (reason === 'no_secret') return 'Подключение сейчас недоступно — на платформе не настроена проверка ссылок.';
  return 'Ссылка для подключения недействительна. Возьмите новую в своём кабинете.';
}

/**
 * Аргумент /start — ссылка менеджера? true — обработано (ответ отправлен),
 * false — не наша ссылка. Чей это чат, решает обработчик канала по заверенному
 * источнику апдейта, а не поле тела.
 */
export async function handleMemberStart(
  arg: string,
  channel: MemberChannel,
  chatId: number,
  reply: (text: string) => Promise<unknown>,
): Promise<boolean> {
  const token = memberTokenFromStart(arg);
  if (token === null) return false;
  const check = verifyMemberLinkToken(token);
  if (!check.ok) {
    console.error(`[member-channel] ссылка менеджера (${CHANNEL_LABEL[channel]}) отклонена: ${check.reason}`);
    await reply(memberBadLinkReplyText(check.reason));
    return true;
  }
  const bound = await bindMemberChannel(check.memberId, channel, chatId);
  await reply(memberBindReplyText(channel, bound));
  return true;
}

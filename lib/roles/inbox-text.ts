/**
 * Строка предмета «Входящих» для кабинета в чате (lib/chat-cabinet/screens:
 * список и карточка). Те же предметы, что экран кабинета на сайте
 * (loadInbox): своего отбора нет. Имени и телефона в строке нет — она
 * показывает, что ждёт, а не карточку человека.
 *
 * Имя клиента (`contact_name`) в строку не берётся. Но у заявки два поля
 * пишет сам турист: тур словами (`route_title` формы сайта) и желаемые даты
 * (`desired_dates`) — свободный текст, куда он может вписать телефон или
 * почту. Они проходят `redactPII` в любом канале: список уходит и в Telegram
 * (ПД туриста туда не идут — решение владельца 23.08), и в MAX обычным
 * ответом, а справка меню обещает «Имени и телефона туриста в этом списке
 * нет» в обоих (план «гид в чате», шаг 9).
 */

import { escapeHtml } from '@/lib/text/escape-html';
import { INBOX_KIND_LABELS, type InboxKind } from '@/lib/crm/inbox-kinds';
import { redactPII } from '@/lib/security/pii-redact';
import type { InboxItem } from '@/lib/crm/inbox';

/** Виды, у которых название и дата — свободный текст туриста (lib/crm/inbox-sql). */
const TOURIST_TEXT_KINDS: ReadonlySet<InboxKind> = new Set<InboxKind>(['lead']);

function age(min: number): string {
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} ч`;
  return `${Math.floor(h / 24)} дн`;
}

/**
 * Поле предмета, которое пишет сам турист (тур словами, желаемые даты),
 * — через `redactPII`; остальное как есть. Экранирует вызывающий. Им же
 * пользуется кабинет в чате (lib/chat-cabinet/screens): одно правило на
 * список и карточку.
 */
export function inboxItemField(item: InboxItem, value: string): string {
  return TOURIST_TEXT_KINDS.has(item.kind) ? redactPII(value) : value;
}

/** Сколько ждёт: «40 мин», «3 ч», «2 дн». */
export function waitingAge(min: number): string {
  return age(min);
}

/** Строка предмета без маркера: вид · тур · дата · люди · сколько ждёт. Без имени и телефона. */
export function inboxItemLine(item: InboxItem): string {
  const bits = [INBOX_KIND_LABELS[item.kind]];
  if (item.title) bits.push(escapeHtml(inboxItemField(item, item.title)));
  if (item.date) bits.push(escapeHtml(inboxItemField(item, item.date)));
  if (item.people !== null) bits.push(`${item.people} чел`);
  bits.push(`ждёт ${age(item.waiting_minutes)}`);
  return bits.join(' · ');
}

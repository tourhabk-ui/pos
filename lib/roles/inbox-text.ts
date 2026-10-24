/**
 * Короткий список «Входящих» для кнопки кабинета. Те же предметы, что экран
 * (loadInbox): своего отбора нет. Имени и телефона в тексте нет — кнопка
 * показывает, что ждёт, а не карточку человека.
 */

import { escapeHtml } from '@/lib/text/escape-html';
import { INBOX_KIND_LABELS } from '@/lib/crm/inbox-kinds';
import type { Inbox, InboxItem } from '@/lib/crm/inbox';

const SHOWN = 8;

function age(min: number): string {
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} ч`;
  return `${Math.floor(h / 24)} дн`;
}

function itemLine(item: InboxItem): string {
  const bits = [INBOX_KIND_LABELS[item.kind]];
  if (item.title) bits.push(escapeHtml(item.title));
  if (item.date) bits.push(escapeHtml(item.date));
  if (item.people !== null) bits.push(`${item.people} чел`);
  bits.push(`ждёт ${age(item.waiting_minutes)}`);
  return `• ${bits.join(' · ')}`;
}

export function inboxMenuText(inbox: Inbox): string {
  const lines = [`<b>Входящие</b>`];
  if (inbox.failed.length > 0) {
    const names = inbox.failed.map((k) => INBOX_KIND_LABELS[k]).join(', ');
    lines.push(`Не прочиталось: ${names}. Это не «таких нет».`);
    lines.push(`Среди прочитанного ждут ответа: ${inbox.items.length}.`);
  } else {
    lines.push(inbox.items.length === 0 ? 'Ждут ответа: нет.' : `Ждут ответа: ${inbox.items.length}.`);
  }
  const shown = inbox.items.slice(0, SHOWN);
  for (const item of shown) lines.push(itemLine(item));
  if (inbox.items.length > shown.length) lines.push(`…и ещё ${inbox.items.length - shown.length}.`);
  if (inbox.chat.state === 'ok' && inbox.chat.unread > 0) {
    lines.push(`Непрочитанных сообщений в чате кабинета: ${inbox.chat.unread}.`);
  } else if (inbox.chat.state === 'failed') {
    lines.push('Непрочитанные сообщения чата не посчитались.');
  }
  for (const note of inbox.not_here) lines.push(note);
  return lines.join('\n');
}

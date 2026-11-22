import type { Metadata } from 'next';
import { MessageSquare } from 'lucide-react';
import { ConversationsPanel } from '@/components/chat/ConversationsPanel';
import { OPERATOR_MESSAGES_HINT } from '@/lib/crm/inbox-kinds';

export const metadata: Metadata = {
  title: 'Сообщения | Оператор',
  description: 'Переписка с туристами, которые написали вам с карточки тура',
  robots: 'noindex, nofollow',
};

/**
 * «Сообщения» кабинета туроператора (22.11, #2770). Беседы с туристами здесь,
 * а не в плавающей кнопке: на телефоне она накрывала «Создать тур». Сюда же
 * ведут «Входящие» и «Открыть чат» в уведомлении о сообщении
 * (lib/crm/inbox-kinds, partnerChatPath) — номер беседы приходит в `?c=`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function OperatorMessagesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).c;
  const initialId = typeof raw === 'string' && UUID_RE.test(raw) ? raw : null;
  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center gap-2.5">
        <MessageSquare className="w-4 h-4 text-[var(--text-muted)]" />
        <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Сообщения</h1>
      </div>
      <p className="text-xs text-[var(--text-secondary)]">
        {OPERATOR_MESSAGES_HINT} Ответить можно здесь или кнопкой «Ответить» под уведомлением в мессенджере, если он подключён.
      </p>
      <ConversationsPanel initialId={initialId} emptyHint={OPERATOR_MESSAGES_HINT} />
    </div>
  );
}

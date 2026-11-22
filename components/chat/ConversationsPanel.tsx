'use client';

/**
 * Беседы с туристами на странице, а не в плавающем окне. Первый потребитель —
 * «Сообщения» кабинета туроператора (22.11, #2770, слово владельца «да»):
 * плавающая кнопка чата на телефоне 390 px накрывала «Создать тур», а другого
 * входа в беседы на сайте у оператора не было — «Входящие» отсылали к ней же.
 *
 * Список и переписка — те же компоненты, что у виджета (ConversationList,
 * MessageThread). Исходов у списка три (§4.0): загружается, есть (или пусто),
 * не загрузился — со словами и кнопкой «Повторить», а не пустым «Нет бесед».
 * Беседа из уведомления открывается сразу (`initialId`); чужой номер откроет
 * переписку, которую сервер не отдаст (участие проверяет /api/chat/…).
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, MessageCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { ConversationList, conversationFromApi, type Conversation } from './ConversationList';
import { MessageThread } from './MessageThread';

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; items: Conversation[] }
  | { kind: 'failed' };

export const CONVERSATIONS_FAILED_TEXT = 'Список бесед не загрузился.';

export function ConversationsPanel({ initialId = null, emptyHint }: {
  initialId?: string | null;
  emptyHint: string;
}) {
  const { user } = useAuth();
  const userId = user?.id;
  const [activeId, setActiveId] = useState<string | null>(initialId);
  // Номер загрузки и тихая ли она: после возврата из переписки список
  // обновляется без спиннера, «Повторить» после сбоя — со спиннером.
  const [reload, setReload] = useState({ n: 0, quiet: false });
  const [result, setResult] = useState<{ key: number; state: ListState } | null>(null);
  const list: ListState = result?.key === reload.n
    ? result.state
    : reload.quiet && result?.state.kind === 'ready' ? result.state : { kind: 'loading' };

  useEffect(() => {
    if (!userId) return;
    const ctrl = new AbortController();
    const done = (next: ListState) => { if (!ctrl.signal.aborted) setResult({ key: reload.n, state: next }); };
    fetch('/api/chat/conversations?limit=50', { signal: ctrl.signal })
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null);
        const conversations = typeof body === 'object' && body !== null && (body as { success?: unknown }).success === true
          ? (body as { data?: { conversations?: unknown } }).data?.conversations
          : undefined;
        if (!res.ok || !Array.isArray(conversations)) {
          console.error(`[conversations-panel] список бесед не загрузился: HTTP ${res.status}`);
          done({ kind: 'failed' });
          return;
        }
        done({ kind: 'ready', items: conversations.map((c) => conversationFromApi(c as Record<string, unknown>)) });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        console.error('[conversations-panel] список бесед не загрузился:', err instanceof Error ? err.message : err);
        done({ kind: 'failed' });
      });
    return () => ctrl.abort();
  }, [userId, reload]);

  if (!userId) return null;

  const active = list.kind === 'ready' ? list.items.find((c) => c.id === activeId) : undefined;

  const back = () => {
    setActiveId(null);
    setReload((r) => ({ n: r.n + 1, quiet: true }));
  };

  return (
    <div className="flex h-[70vh] min-h-[420px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <section
        aria-label="Беседы"
        className={`${activeId ? 'hidden md:block' : 'block'} w-full md:w-80 md:shrink-0 overflow-y-auto md:border-r md:border-[var(--border)]`}
      >
        {list.kind === 'failed' ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <AlertTriangle className="w-6 h-6 text-[var(--warning)]" />
            <p className="text-sm text-[var(--text-primary)]">{CONVERSATIONS_FAILED_TEXT}</p>
            <button type="button" onClick={() => setReload((r) => ({ n: r.n + 1, quiet: false }))} className="ds-btn ds-btn-secondary">
              Повторить
            </button>
          </div>
        ) : (
          <ConversationList
            conversations={list.kind === 'ready' ? list.items : []}
            loading={list.kind === 'loading'}
            activeId={activeId}
            onSelect={setActiveId}
            emptyHint={emptyHint}
          />
        )}
      </section>

      <section aria-label="Переписка" className={`${activeId ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
        {activeId ? (
          <MessageThread
            key={activeId}
            conversationId={activeId}
            currentUserId={userId}
            otherParticipantName={active?.otherParticipantName || 'Участник'}
            onBack={back}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
            <MessageCircle className="w-8 h-8 text-[var(--text-muted)]" />
            <p className="text-sm text-[var(--text-muted)]">Выберите беседу слева</p>
          </div>
        )}
      </section>
    </div>
  );
}

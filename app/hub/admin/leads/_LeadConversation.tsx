'use client';

/**
 * Переписка по заявке в карточке лида админки (1350): кто писал, откуда и
 * дошло ли. Сюда отсылает заглушка в Telegram, когда сообщение клиента не
 * дошло до адресата: оператор платформы читает текст здесь и передаёт.
 *
 * Три исхода (§4.0): сообщения есть / переписки нет / не загрузилась (с
 * причиной, а не «сообщений нет»). Текст — ПД клиента, под `Sensitive`.
 */
import { useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { Sensitive } from '@/components/admin/shared/Sensitive';

interface Message {
  author: 'owner' | 'guest';
  door: 'max' | 'page';
  body: string;
  delivery_channel: 'max' | 'no_address' | 'failed' | null;
  delivery_reason: string | null;
  created_at: string;
}

const DELIVERY: Record<string, string> = {
  max: 'дошло в MAX',
  no_address: 'у получателя нет MAX',
  failed: 'MAX не доставил',
};

const kamchatkaTime = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Kamchatka', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

type Load = { state: 'loading' } | { state: 'ok'; messages: Message[] } | { state: 'error'; error: string };

export function LeadConversation({ leadId }: { leadId: string }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/leads/${encodeURIComponent(leadId)}/messages`, { cache: 'no-store' });
        const body = await res.json().catch(() => null) as { success: true; data: Message[] } | { success: false; error?: string } | null;
        if (!alive) return;
        if (!res.ok || !body || !body.success) {
          setLoad({ state: 'error', error: (body && !body.success && body.error) || `Сервер ответил ${res.status}` });
          return;
        }
        setLoad({ state: 'ok', messages: body.data });
      } catch {
        if (alive) setLoad({ state: 'error', error: 'Нет связи с сервером.' });
      }
    })();
    return () => { alive = false; };
  }, [leadId]);

  return (
    <div>
      <p className="text-xs text-[var(--text-muted)] mb-1 flex items-center gap-1">
        <MessageCircle size={12} /> Переписка с адресатом
      </p>
      {load.state === 'loading' && <p className="text-xs text-[var(--text-muted)]">Загружаем…</p>}
      {load.state === 'error' && <p className="text-xs text-[var(--danger)]" role="alert">Переписка не загрузилась: {load.error}</p>}
      {load.state === 'ok' && load.messages.length === 0 && (
        <p className="text-xs text-[var(--text-muted)]">Сообщений по заявке нет.</p>
      )}
      {load.state === 'ok' && load.messages.length > 0 && (
        <ol className="space-y-1 border-l-2 border-[var(--border)] pl-3" aria-label="Переписка">
          {load.messages.map((m, i) => (
            <li key={`${m.created_at}-${i}`} className="text-sm">
              <span className="text-xs text-[var(--text-muted)]">
                {m.author === 'owner' ? 'Адресат' : 'Клиент'} · {m.door === 'page' ? 'страница заявки' : 'MAX'}
                {' · '}{kamchatkaTime.format(new Date(m.created_at))}
                {' · '}{m.delivery_channel ? DELIVERY[m.delivery_channel] ?? m.delivery_channel : 'исход не записан'}
                {m.delivery_channel && m.delivery_channel !== 'max' && m.delivery_reason ? ` (${m.delivery_reason})` : ''}
              </span>
              <p className="text-[var(--text-primary)] whitespace-pre-line"><Sensitive>{m.body}</Sensitive></p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

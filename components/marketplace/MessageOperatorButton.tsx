'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare } from 'lucide-react';

/**
 * «Написать оператору» на карточке тура — вход в диалог с оператором.
 * Раньше пустой стейт сообщений обещал «Начните общение на странице тура»,
 * но точки старта диалога не существовало.
 *
 * POST /api/chat/conversations с operatorPartnerId: user_id оператора
 * резолвится на сервере (не светим его публично). Гость → на логин.
 */
export default function MessageOperatorButton({ operatorPartnerId, tourId, tourTitle }: {
  operatorPartnerId: string;
  tourId: number;
  tourTitle: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');

  const handleClick = async () => {
    setState('loading');
    setError('');
    try {
      const res = await fetch('/api/chat/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operatorPartnerId,
          tourId,
          subject: tourTitle,
        }),
      });

      if (res.status === 401) {
        router.push(`/auth/login?from=${encodeURIComponent(window.location.pathname)}`);
        return;
      }

      const data: unknown = await res.json();
      if (!res.ok) {
        const msg = typeof data === 'object' && data !== null && 'error' in data
          ? String((data as Record<string, unknown>).error)
          : 'Не удалось открыть диалог';
        setState('error');
        setError(msg);
        return;
      }

      router.push('/hub/tourist/messages');
    } catch {
      setState('error');
      setError('Ошибка сети. Попробуйте ещё раз.');
    }
  };

  return (
    <div className="shrink-0 text-right">
      <button
        type="button"
        onClick={handleClick}
        disabled={state === 'loading'}
        className="ds-btn ds-btn-secondary flex items-center gap-1.5 px-3 py-1.5 text-xs"
      >
        {state === 'loading' ? (
          <span className="animate-spin rounded-full h-3.5 w-3.5 border border-[var(--text-secondary)] border-t-transparent" />
        ) : (
          <MessageSquare className="w-3.5 h-3.5" />
        )}
        Написать
      </button>
      {state === 'error' && (
        <p className="mt-1 max-w-48 text-[10px] leading-tight text-[var(--danger)]">{error}</p>
      )}
    </div>
  );
}

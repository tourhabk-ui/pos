'use client';

import { useState } from 'react';
import { Protected } from '@/components/auth/Protected';
import { Bell, Loader2, CheckCheck, AlertTriangle } from 'lucide-react';
import { useApiFetch } from '@/hooks/use-api-fetch';
import { PushSubscribeButton } from '@/components/PWA/PushSubscribeButton';

interface Notification {
  id: string;
  title: string;
  message: string;
  time: string;
  read: boolean;
}

interface NotificationsApiResponse {
  notifications: Array<{
    id: string;
    title: string;
    message: string;
    createdAt: string;
    isRead: boolean;
  }>;
}

type FilterTab = 'all' | 'unread';

export default function NotificationsClient() {
  const [filter, setFilter] = useState<FilterTab>('all');
  // Настроек уведомлений здесь больше нет (решение владельца 24.09): их не
  // читал ни один отправитель — выключатели ничего не выключали, а новому
  // туристу панель не открывалась вовсе. Возвращать — только вместе с
  // отправителем, который их слушается (§10.09).

  const { data: notifications, loading, error, setData } = useApiFetch<
    NotificationsApiResponse,
    Notification[]
  >(
    '/api/notifications?limit=50',
    (d) => (d?.notifications ?? []).map((n) => ({
      id: n.id,
      title: n.title,
      message: n.message,
      time: n.createdAt,
      read: n.isRead,
    })),
    { errorMessage: 'Не удалось загрузить уведомления' },
  );

  const list = notifications ?? [];
  const [markError, setMarkError] = useState('');

  /**
   * Отметка «прочитано» показывается сразу, но если сервер её не принял —
   * откатывается и говорит об этом. Прежний пустой catch с подписью «silent»
   * оставлял экран, уверяющий человека в том, чего на сервере не произошло:
   * после перезагрузки всё снова непрочитано, и непонятно почему (§4.0).
   */
  const handleReadAll = async () => {
    const before = notifications ?? [];
    setData(before.map((n) => ({ ...n, read: true })));
    const res = await fetch('/api/notifications/mark-all-read', { method: 'POST' }).catch(() => null);
    if (!res?.ok) {
      console.error('[tourist/notifications] отметка не сохранена', res?.status ?? 'сеть');
      setData(before);
      setMarkError('Не получилось отметить прочитанными. Проверьте связь и попробуйте ещё раз.');
      return;
    }
    setMarkError('');
  };

  const filtered = filter === 'unread' ? list.filter((n) => !n.read) : list;
  const unreadCount = list.filter((n) => !n.read).length;

  return (
    <Protected roles={['tourist', 'admin']}>
      <div className="max-w-5xl mx-auto px-4 py-6 lg:py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-playfair text-2xl sm:text-3xl font-bold text-[var(--text-primary)]">
            Уведомления
          </h1>

          <div className="flex items-center gap-2">
            <PushSubscribeButton />
            {unreadCount > 0 && (
              <button
                onClick={handleReadAll}
                className="ds-btn ds-btn-secondary flex items-center gap-2"
              >
                <CheckCheck className="w-4 h-4" />
                Прочитать все
              </button>
            )}
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setFilter('all')}
            className={`min-h-[44px] px-5 rounded-lg text-sm font-medium transition-colors ${
              filter === 'all'
                ? 'bg-[var(--accent)] text-[var(--bg-card)]'
                : 'bg-[var(--bg-card)] text-[var(--text-secondary)] border border-[var(--border)]'
            }`}
          >
            Все
          </button>
          <button
            onClick={() => setFilter('unread')}
            className={`min-h-[44px] px-5 rounded-lg text-sm font-medium transition-colors ${
              filter === 'unread'
                ? 'bg-[var(--accent)] text-[var(--bg-card)]'
                : 'bg-[var(--bg-card)] text-[var(--text-secondary)] border border-[var(--border)]'
            }`}
          >
            Непрочитанные ({unreadCount})
          </button>
        </div>

        {markError && (
          <div className="flex items-start gap-2 mb-4 p-3 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--danger)]" />
            <p className="text-sm text-[var(--text-primary)]">{markError}</p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Bell className="w-16 h-16 mb-4 text-[var(--text-muted)]" />
            <p className="text-lg text-[var(--text-muted)]">{error}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Bell className="w-16 h-16 mb-4 text-[var(--text-muted)]" />
            <p className="text-lg text-[var(--text-muted)]">
              Нет новых уведомлений
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((notification) => (
              <div
                key={notification.id}
                className={`flex items-start gap-4 rounded-lg border border-[var(--border)] p-4 ${
                  notification.read ? 'bg-[var(--bg-card)]' : 'bg-[var(--bg-primary)]'
                }`}
              >
                <div className="pt-1 flex-shrink-0">
                  {!notification.read ? (
                    <div className="w-2.5 h-2.5 rounded-full bg-[var(--accent)]" />
                  ) : (
                    <div className="w-2.5 h-2.5" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-sm text-[var(--text-primary)]">
                    {notification.title}
                  </h3>
                  <p className="text-sm mt-1 text-[var(--text-secondary)]">
                    {notification.message}
                  </p>
                  <span className="text-xs mt-2 block text-[var(--text-muted)]">
                    {new Date(notification.time).toLocaleString('ru-RU', {
                      day: 'numeric',
                      month: 'long',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

      </div>
    </Protected>
  );
}

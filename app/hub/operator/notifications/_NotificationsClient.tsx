'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Protected } from '@/components/auth/Protected';
import { Bell, CheckCheck, Loader2, Calendar, XCircle, Star, ChevronRight, RefreshCw } from 'lucide-react';

type NType = 'booking' | 'cancellation' | 'review';

interface Notification {
  id: string; type: NType; title: string;
  message: string; time: string; read: boolean;
  /** Куда ведёт уведомление: бронь или тур с отзывами (#1801). */
  href: string;
}

const TYPE_ICONS: Record<string, typeof Bell> = {
  booking: Calendar, cancellation: XCircle, review: Star,
};

export default function NotificationsClient() {
  const [loading, setLoading] = useState(true);
  const [items, setItems]     = useState<Notification[]>([]);
  const [filter, setFilter]   = useState<'all' | 'unread'>('all');
  const [error, setError]     = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res  = await fetch('/api/hub/operator/notifications');
      const data = await res.json() as { notifications?: Notification[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Ошибка загрузки');
      setItems(data.notifications ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Отметка «прочитано» сохраняется на сервере (#1801): до 11.09 она жила
   * только в useState и терялась при перезагрузке. Показываем сразу, при
   * отказе откатываем и говорим об этом — молчащая кнопка и была находкой.
   */
  const markRead = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const target = new Set(ids);
    setItems(prev => prev.map(n => (target.has(n.id) ? { ...n, read: true } : n)));
    const res = await fetch('/api/hub/operator/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids.length === 1 ? { id: ids[0] } : { all: true, ids }),
    }).catch(() => null);
    if (!res?.ok) {
      console.error('[notifications] отметка не сохранена', res?.status ?? 'сеть');
      setItems(prev => prev.map(n => (target.has(n.id) ? { ...n, read: false } : n)));
      setError('Отметка «прочитано» не сохранилась. Проверьте связь.');
    }
  }, []);

  const unreadCount = items.filter(n => !n.read).length;
  const displayed   = filter === 'unread' ? items.filter(n => !n.read) : items;

  return (
    <Protected roles={['operator', 'admin']}>
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Bell className="w-6 h-6 text-[var(--accent)]" />
            <h1 className="text-2xl font-bold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>
              Уведомления
            </h1>
            {unreadCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--accent)] text-white font-medium">
                {unreadCount}
              </span>
            )}
          </div>
          {unreadCount > 0 && (
            <button
              onClick={() => void markRead(items.filter(n => !n.read).map(n => n.id))}
              className="min-h-[44px] px-3 py-2 text-sm text-[var(--accent)] hover:bg-[var(--bg-hover)] rounded-lg transition-colors inline-flex items-center gap-1.5"
            >
              <CheckCheck className="w-4 h-4" /> Прочитать все
            </button>
          )}
        </div>

        <div className="flex gap-2 mb-4">
          {(['all', 'unread'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`min-h-[44px] px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                filter === f
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }`}>
              {f === 'all' ? 'Все' : 'Непрочитанные'}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" /></div>
        ) : error ? (
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10">
            <p className="flex-1 text-sm text-[var(--text-primary)]">{error}</p>
            <button type="button" onClick={() => void load()}
              className="min-h-[44px] px-4 rounded-lg border border-[var(--border)] text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors inline-flex items-center justify-center gap-2 shrink-0">
              <RefreshCw className="w-4 h-4" /> Повторить
            </button>
          </div>
        ) : displayed.length === 0 ? (
          <div className="text-center py-16">
            <Bell className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-3" />
            <p className="text-[var(--text-secondary)]">
              {filter === 'unread' ? 'Нет непрочитанных' : 'Нет уведомлений'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {displayed.map(n => {
              const Icon = TYPE_ICONS[n.type] ?? Bell;
              return (
                <Link key={n.id}
                  href={n.href}
                  onClick={() => { if (!n.read) void markRead([n.id]); }}
                  className={`w-full text-left bg-[var(--bg-card)] border rounded-lg p-4 flex items-start gap-3 transition-colors hover:bg-[var(--bg-hover)] ${
                    n.read ? 'border-[var(--border)]' : 'border-[var(--accent)]/30'
                  }`}>
                  <Icon className={`w-5 h-5 mt-0.5 shrink-0 ${n.read ? 'text-[var(--text-muted)]' : 'text-[var(--accent)]'}`} />
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${n.read ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>
                      {n.title}
                    </p>
                    <p className="text-sm text-[var(--text-secondary)] mt-0.5">{n.message}</p>
                    <p className="text-xs text-[var(--text-muted)] mt-1">{n.time}</p>
                  </div>
                  {!n.read && <span className="w-2 h-2 rounded-full bg-[var(--accent)] mt-2 shrink-0" />}
                  <ChevronRight className="w-4 h-4 mt-0.5 shrink-0 text-[var(--text-muted)]" />
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </Protected>
  );
}

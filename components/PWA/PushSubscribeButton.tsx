'use client';

import { useEffect, useState } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_KEY ?? '';

function urlB64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

type State = 'loading' | 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed';

export function PushSubscribeButton() {
  const [state, setState] = useState<State>('loading');

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !VAPID_PUBLIC_KEY) {
      setState('unsupported');
      return;
    }
    navigator.serviceWorker.ready.then(async reg => {
      const sub = await reg.pushManager.getSubscription();
      if (sub) { setState('subscribed'); return; }
      if (Notification.permission === 'denied') { setState('denied'); return; }
      setState('unsubscribed');
    });
  }, []);

  const subscribe = async () => {
    setState('loading');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      });
      setState(res.ok ? 'subscribed' : 'unsubscribed');
    } catch {
      setState(Notification.permission === 'denied' ? 'denied' : 'unsubscribed');
    }
  };

  const unsubscribe = async () => {
    setState('loading');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState('unsubscribed');
    } catch {
      setState('subscribed');
    }
  };

  if (state === 'unsupported') return null;

  if (state === 'loading') {
    return (
      <button disabled className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-[var(--text-muted)] bg-[var(--bg-card)] border border-[var(--border)]">
        <Loader2 size={15} className="animate-spin" />
        Загрузка...
      </button>
    );
  }

  if (state === 'denied') {
    return (
      <div className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-[var(--text-muted)] bg-[var(--bg-card)] border border-[var(--border)]">
        <BellOff size={15} />
        Уведомления заблокированы в браузере
      </div>
    );
  }

  if (state === 'subscribed') {
    return (
      <button
        onClick={unsubscribe}
        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-[var(--text-secondary)] bg-[var(--bg-card)] border border-[var(--border)] hover:border-[var(--danger)]/40 hover:text-[var(--danger)] transition-colors"
      >
        <Bell size={15} className="text-[var(--success)]" />
        Уведомления включены
      </button>
    );
  }

  return (
    <button
      onClick={subscribe}
      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-[var(--accent)] hover:opacity-90 transition-opacity"
    >
      <Bell size={15} />
      Включить уведомления
    </button>
  );
}

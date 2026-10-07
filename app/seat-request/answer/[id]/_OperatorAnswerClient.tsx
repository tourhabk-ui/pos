'use client';

/**
 * Ответ оператора на запрос мест с сайта (29.09). Сюда ведёт ссылка из
 * заглушки в Telegram (ПД туда не идут — значит и кнопок-действий нет), из
 * пересланного сообщения и кнопка «Другая дата» в MAX. Контакты туриста здесь
 * не показываются: после «Есть места» они в кабинете и в MAX.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { platformAcceptsPayments } from '@/lib/payments/accepting';

interface View { status: string; tourTitle: string; date: string; participants: number; deadlineAt: string }

export function OperatorAnswerClient({ id, k }: { id: string; k: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ message: string; tone: 'success' | 'warning' } | null>(null);
  const [sending, setSending] = useState(false);
  const [altDate, setAltDate] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/seat-requests/${id}/answer?k=${encodeURIComponent(k)}`, { cache: 'no-store' })
      .then(r => r.json().catch(() => null) as Promise<{ success: true; data: View } | { success: false; error?: string } | null>)
      .then(b => {
        if (cancelled) return;
        if (!b || !b.success) setError((b && !b.success && b.error) || 'Не удалось открыть запрос');
        else setView(b.data);
      })
      .catch(() => { if (!cancelled) setError('Нет связи с сервером'); });
    return () => { cancelled = true; };
  }, [id, k]);

  async function answer(kind: 'yes' | 'no' | 'other_date') {
    if (kind === 'other_date' && !altDate) { setError('Выберите дату, которую предлагаете'); return; }
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/seat-requests/${id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ k, answer: kind, ...(kind === 'other_date' ? { date: altDate } : {}) }),
      });
      const b = await res.json().catch(() => null) as
        | { success: true; data: { message: string; failed?: boolean } }
        | { success: false; error?: string; reason?: string }
        | null;
      if (!b) setError(`Сервер ответил ${res.status}`);
      // Ответ принят, но исход не записан: повторять нельзя, это не ошибка ввода.
      else if (!b.success && b.reason === 'accepted_unfinished') setResult({ message: b.error ?? 'Ответ принят.', tone: 'warning' });
      else if (!b.success) setError(b.error ?? 'Ответ не принят');
      // «Бронь не завелась» — не успех: оператору надо проверить кабинет.
      else setResult({ message: b.data.message, tone: b.data.failed ? 'warning' : 'success' });
    } catch {
      setError('Нет связи с сервером — ответ не отправлен. Попробуйте ещё раз.');
    } finally {
      setSending(false);
    }
  }

  const open = view?.status === 'pending';

  return (
    <main className="ds-page min-h-screen px-4 py-10">
      <div className="max-w-md mx-auto ds-card p-6 space-y-4">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>Запрос свободных мест</h1>
        {!view && !error && <p className="flex items-center gap-2 text-[var(--text-secondary)]"><Loader2 className="w-4 h-4 animate-spin" />Загружаем…</p>}
        {view && (
          <p className="text-[var(--text-primary)]">
            «{view.tourTitle}», {view.date}, {view.participants} чел.
            {open && <span className="block text-sm text-[var(--text-secondary)] mt-1">Ответить до {new Date(view.deadlineAt).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Kamchatka', hour: '2-digit', minute: '2-digit' })} по Камчатке.</span>}
          </p>
        )}
        {result && (
          <p className="text-sm" style={{ color: result.tone === 'success' ? 'var(--success)' : 'var(--warning)' }} aria-live="polite">
            {result.message}
          </p>
        )}
        {error && <p className="text-sm text-[var(--danger)]" role="alert">{error}</p>}
        {view && !open && !result && <p className="text-sm text-[var(--text-secondary)]">На этот запрос ответ уже не принимается.</p>}
        {view && open && !result && (
          <div className="space-y-3">
            <button disabled={sending} onClick={() => answer('yes')} className="ds-btn ds-btn-primary w-full">Есть места — завести бронь</button>
            <button disabled={sending} onClick={() => answer('no')} className="ds-btn ds-btn-secondary w-full">Мест нет</button>
            <div className="flex gap-2 items-end">
              <label className="flex-1">
                <span className="ds-label">Другая дата</span>
                <input type="date" value={altDate} onChange={e => setAltDate(e.target.value)} className="ds-input w-full" />
              </label>
              <button disabled={sending} onClick={() => answer('other_date')} className="ds-btn ds-btn-secondary">Предложить</button>
            </div>
            <p className="text-xs text-[var(--text-muted)]">«Есть места» сразу заводит и подтверждает бронь — {platformAcceptsPayments() ? 'турист получает ссылку на оплату' : 'оплату турист вносит вам напрямую'}, его контакты появятся в кабинете и в MAX.</p>
          </div>
        )}
      </div>
    </main>
  );
}

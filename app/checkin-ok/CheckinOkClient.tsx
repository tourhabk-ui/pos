'use client';

/**
 * «Мы ещё в пути, всё в порядке» — вторая отметка на регистрации маршрута.
 *
 * Не возврат: маршрут остаётся открытым, сторож продолжает следить. Отметка
 * ОТОДВИГАЕТ следующий шаг лестницы, и страница говорит об этом прямо —
 * обещать «уведомления остановлены» здесь нельзя, иначе группа решит, что
 * её больше не ждут.
 */

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle, XCircle, Loader2, ArrowLeft, Clock } from 'lucide-react';
import LeaderPhoneField from '@/components/safety/LeaderPhoneField';

interface RouteInfo {
  id: string;
  name: string;
  leader: string;
  start_date: string;
  end_date: string;
  completed: boolean;
}

export default function CheckinOkClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const registrationId = searchParams.get('id');

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [leaderPhone, setLeaderPhone] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!registrationId) {
      setLoading(false);
      return;
    }
    fetch(`/api/safety/return?registration_id=${registrationId}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) setRoute(data.route);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [registrationId]);

  const handleCheckin = async () => {
    if (!registrationId) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch('/api/safety/route-checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          registration_id: registrationId,
          ...(leaderPhone.trim() ? { leader_phone: leaderPhone.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setDoneMessage(data.message);
      } else {
        setFormError(data.error || 'Отметка не сохранена');
      }
    } catch {
      setFormError('Сеть недоступна — отметка не сохранена. Попробуйте ещё раз.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)] flex items-center justify-center p-6">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  if (doneMessage) {
    return (
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <CheckCircle className="w-16 h-16 text-[var(--success)] mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Отметка принята</h1>
          <p className="text-[var(--text-secondary)] mb-6">{doneMessage}</p>
          <button
            onClick={() => router.push('/map')}
            className="w-full py-3 rounded-lg bg-[var(--accent)] text-white font-semibold text-sm hover:opacity-90"
          >
            К карте
          </button>
        </div>
      </div>
    );
  }

  if (!route) {
    return (
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <XCircle className="w-16 h-16 text-[var(--warning)] mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Маршрут не найден</h1>
          <p className="text-[var(--text-secondary)] mb-6">
            Проверьте ссылку или вернитесь к карте.
          </p>
          <button
            onClick={() => router.push('/map')}
            className="w-full py-3 rounded-lg bg-[var(--accent)] text-white font-semibold text-sm hover:opacity-90"
          >
            К карте
          </button>
        </div>
      </div>
    );
  }

  if (route.completed) {
    return (
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <CheckCircle className="w-16 h-16 text-[var(--success)] mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Маршрут уже закрыт</h1>
          <p className="text-[var(--text-secondary)] mb-6">
            По маршруту «{route.name}» уже отмечено возвращение — напоминания не придут.
          </p>
          <button
            onClick={() => router.push('/map')}
            className="w-full py-3 rounded-lg bg-[var(--accent)] text-white font-semibold text-sm hover:opacity-90"
          >
            К карте
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <div className="max-w-lg mx-auto px-4 py-8">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-[var(--text-secondary)] mb-6 hover:text-[var(--text-primary)]"
        >
          <ArrowLeft className="w-4 h-4" /> Назад
        </button>

        <h1 className="text-2xl font-bold mb-2">Мы в порядке</h1>
        <p className="text-[var(--text-secondary)] mb-6">
          Группа ещё на маршруте и задерживается, но помощь не нужна.
        </p>

        <div className="p-4 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] space-y-3 mb-6">
          <p><span className="text-[var(--text-muted)]">Маршрут:</span> {route.name}</p>
          <p><span className="text-[var(--text-muted)]">Руководитель:</span> {route.leader}</p>
          <p><span className="text-[var(--text-muted)]">Даты:</span> {route.start_date} — {route.end_date}</p>
        </div>

        <LeaderPhoneField
          value={leaderPhone}
          onChange={setLeaderPhone}
          disabled={submitting}
          error={formError}
        />

        <div className="p-4 rounded-lg mb-6 bg-[var(--bg-card)] border border-[var(--border)]">
          <p className="text-sm text-[var(--text-secondary)] flex gap-2">
            <Clock className="w-4 h-4 shrink-0 mt-0.5 text-[var(--ocean)]" />
            <span>
              Маршрут останется открытым. Отметка отодвигает следующее напоминание,
              но не отменяет его: если группа снова не выйдет на связь, экстренный
              контакт получит сообщение опять.
            </span>
          </p>
        </div>

        <button
          onClick={handleCheckin}
          disabled={submitting}
          className="w-full py-4 rounded-lg bg-[var(--accent)] text-white font-bold text-lg
            disabled:opacity-50 hover:opacity-90 transition-opacity
            flex items-center justify-center gap-3"
        >
          {submitting ? <Loader2 className="w-6 h-6 animate-spin" /> : <CheckCircle className="w-6 h-6" />}
          {submitting ? 'Отправляю...' : 'Мы в порядке'}
        </button>

        <p className="text-xs text-[var(--text-muted)] mt-4 text-center">
          Уже вернулись? Тогда отметьте возвращение — оно закрывает маршрут.
        </p>
        <button
          onClick={() => router.push(`/return?id=${registrationId ?? ''}`)}
          className="w-full mt-3 py-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]
            text-[var(--text-primary)] font-semibold text-sm hover:bg-[var(--bg-hover)] transition-colors"
        >
          Отметить возвращение
        </button>
      </div>
    </div>
  );
}

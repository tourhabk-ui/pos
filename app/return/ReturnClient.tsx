'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle, XCircle, Loader2, ArrowLeft } from 'lucide-react';

export default function ReturnClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const registrationId = searchParams.get('id');

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [route, setRoute] = useState<{
    id: string;
    name: string;
    leader: string;
    start_date: string;
    end_date: string;
    completed: boolean;
  } | null>(null);

  const [result, setResult] = useState<'success' | 'error' | null>(null);
  const [resultMessage, setResultMessage] = useState('');

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

  const handleReturn = async () => {
    if (!registrationId) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/safety/return', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registration_id: registrationId }),
      });
      const data = await res.json();
      if (data.success) {
        setResult('success');
        setResultMessage(data.message);
      } else {
        setResult('error');
        setResultMessage(data.error || 'Ошибка');
      }
    } catch {
      setResult('error');
      setResultMessage('Ошибка сети');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  if (result === 'success') {
    return (
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--success)]/10 flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-8 h-8 text-[var(--success)]" />
          </div>
          <h1 className="font-playfair text-2xl font-bold text-[var(--text-primary)] mb-2">С возвращением!</h1>
          <p className="text-[var(--text-secondary)] mb-6">{resultMessage}</p>
          <button onClick={() => router.push('/map')} className="ds-btn ds-btn-primary w-full">
            Вернуться к карте
          </button>
        </div>
      </div>
    );
  }

  if (result === 'error') {
    return (
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--danger)]/10 flex items-center justify-center mx-auto mb-4">
            <XCircle className="w-8 h-8 text-[var(--danger)]" />
          </div>
          <h1 className="font-playfair text-2xl font-bold text-[var(--text-primary)] mb-2">Ошибка</h1>
          <p className="text-[var(--text-secondary)] mb-6">{resultMessage}</p>
          <button onClick={() => setResult(null)} className="ds-btn ds-btn-primary w-full">
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  if (!route) {
    return (
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--warning)]/10 flex items-center justify-center mx-auto mb-4">
            <XCircle className="w-8 h-8 text-[var(--warning)]" />
          </div>
          <h1 className="font-playfair text-2xl font-bold text-[var(--text-primary)] mb-2">Маршрут не найден</h1>
          <p className="text-[var(--text-secondary)] mb-6">Проверьте ссылку или вернитесь к карте.</p>
          <button onClick={() => router.push('/map')} className="ds-btn ds-btn-primary w-full">К карте</button>
        </div>
      </div>
    );
  }

  if (route.completed) {
    return (
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--success)]/10 flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-8 h-8 text-[var(--success)]" />
          </div>
          <h1 className="font-playfair text-2xl font-bold text-[var(--text-primary)] mb-2">Возврат уже отмечен</h1>
          <p className="text-[var(--text-secondary)] mb-6">Маршрут «{route.name}» уже закрыт.</p>
          <button onClick={() => router.push('/map')} className="ds-btn ds-btn-primary w-full">К карте</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-[var(--bg-primary)]">
      <div className="max-w-lg mx-auto px-4 py-8">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-[var(--text-muted)] mb-6 hover:text-[var(--text-primary)] transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Назад
        </button>

        <h1 className="font-playfair text-2xl font-bold text-[var(--text-primary)] mb-6">Отметить возврат</h1>

        <div className="ds-card p-4 space-y-2 text-sm mb-6">
          <p><span className="text-[var(--text-muted)]">Маршрут:</span> <span className="text-[var(--text-primary)]">{route.name}</span></p>
          <p><span className="text-[var(--text-muted)]">Руководитель:</span> <span className="text-[var(--text-primary)]">{route.leader}</span></p>
          <p><span className="text-[var(--text-muted)]">Даты:</span> <span className="text-[var(--text-primary)]">{route.start_date} — {route.end_date}</span></p>
        </div>

        <div className="p-4 rounded-lg bg-[var(--success)]/10 border border-[var(--success)]/30 mb-6">
          <p className="text-sm text-[var(--success)]">
            Нажимая кнопку, вы подтверждаете что <strong>вернулись с маршрута</strong> и
            все участники группы в безопасности.
          </p>
        </div>

        <button
          onClick={handleReturn}
          disabled={submitting}
          className="ds-btn ds-btn-primary w-full py-4 text-lg flex items-center justify-center gap-3 disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="w-6 h-6 animate-spin" />
          ) : (
            <CheckCircle className="w-6 h-6" />
          )}
          {submitting ? 'Отправляю...' : 'Я вернулся'}
        </button>

        <p className="text-xs text-[var(--text-muted)] mt-4 text-center">
          После подтверждения уведомления об эскалации будут остановлены
        </p>
      </div>
    </div>
  );
}

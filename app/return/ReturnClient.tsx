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
        if (data.success) {
          setRoute(data.route);
        }
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
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)] flex items-center justify-center p-6">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  if (result === 'success') {
    return (
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <CheckCircle className="w-16 h-16 text-[var(--success)] mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">С возвращением!</h1>
          <p className="text-[var(--text-secondary)] mb-6">{resultMessage}</p>
          <button
            onClick={() => router.push('/map')}
            className="w-full py-3 rounded-xl bg-[var(--accent)] text-white font-semibold text-sm hover:opacity-90"
          >
            Вернуться к карте
          </button>
        </div>
      </div>
    );
  }

  if (result === 'error') {
    return (
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <XCircle className="w-16 h-16 text-[var(--danger)] mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Ошибка</h1>
          <p className="text-[var(--text-secondary)] mb-6">{resultMessage}</p>
          <button
            onClick={() => { setResult(null); }}
            className="w-full py-3 rounded-xl bg-[var(--accent)] text-white font-semibold text-sm hover:opacity-90"
          >
            Попробовать снова
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
            className="w-full py-3 rounded-xl bg-[var(--accent)] text-white font-semibold text-sm hover:opacity-90"
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
          <h1 className="text-2xl font-bold mb-2">Возврат уже отмечен</h1>
          <p className="text-[var(--text-secondary)] mb-6">
            Маршрут «{route.name}» уже закрыт.
          </p>
          <button
            onClick={() => router.push('/map')}
            className="w-full py-3 rounded-xl bg-[var(--accent)] text-white font-semibold text-sm hover:opacity-90"
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

        <h1 className="text-2xl font-bold mb-6">Отметить возврат</h1>

        <div className="p-4 rounded-xl bg-[var(--bg-hover)] border border-[var(--border)] space-y-3 mb-6">
          <p><span className="text-[var(--text-muted)]">Маршрут:</span> {route.name}</p>
          <p><span className="text-[var(--text-muted)]">Руководитель:</span> {route.leader}</p>
          <p><span className="text-[var(--text-muted)]">Даты:</span> {route.start_date} — {route.end_date}</p>
        </div>

        <div className="p-4 rounded-xl mb-6" style={{ background: 'color-mix(in srgb, var(--success) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--success) 30%, transparent)' }}>
          <p className="text-sm text-[var(--success)]">
            Нажимая кнопку, вы подтверждаете что <strong>вернулись с маршрута</strong> и
            все участники группы в безопасности.
          </p>
        </div>

        <button
          onClick={handleReturn}
          disabled={submitting}
          className="w-full py-4 rounded-xl bg-[var(--success)] text-white font-bold text-lg
            disabled:opacity-50 hover:opacity-90 transition-opacity
            flex items-center justify-center gap-3"
        >
          {submitting ? (
            <Loader2 className="w-6 h-6 animate-spin" />
          ) : (
            <CheckCircle className="w-6 h-6" />
          )}
          {submitting ? 'Отправляю...' : 'Я вернулся'}
        </button>

        <p className="text-xs text-white/30 mt-4 text-center">
          После подтверждения уведомления об эскалации будут остановлены
        </p>
      </div>
    </div>
  );
}

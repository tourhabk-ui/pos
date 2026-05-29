'use client';

import { useState } from 'react';
import { Shield, Clock, User, Phone, CheckCircle, X, AlertTriangle } from 'lucide-react';

type Step = 'form' | 'success' | 'cancel';

interface FormData {
  tourist_name: string;
  route_name: string;
  return_deadline: string;
  emergency_name: string;
  emergency_phone: string;
  emergency_telegram: string;
}

function minDeadline(): string {
  const d = new Date(Date.now() + 31 * 60 * 1000);
  return d.toISOString().slice(0, 16);
}

export default function CheckinClient() {
  const [step, setStep] = useState<Step>('form');
  const [form, setForm] = useState<FormData>({
    tourist_name: '', route_name: '', return_deadline: '',
    emergency_name: '', emergency_phone: '', emergency_telegram: '',
  });
  const [cancelToken, setCancelToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelDone, setCancelDone] = useState(false);

  function set(field: keyof FormData) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm(f => ({ ...f, [field]: e.target.value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!form.emergency_phone && !form.emergency_telegram) {
      setError('Укажите телефон или Telegram экстренного контакта');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/safety/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          return_deadline: new Date(form.return_deadline).toISOString(),
          emergency_phone: form.emergency_phone || undefined,
          emergency_telegram: form.emergency_telegram || undefined,
        }),
      });
      const data = await res.json() as { success?: boolean; cancel_token?: string; error?: string };
      if (!data.success) { setError(data.error ?? 'Ошибка'); return; }
      setCancelToken(data.cancel_token!);
      setStep('success');
    } catch {
      setError('Нет соединения. Попробуйте ещё раз.');
    } finally {
      setLoading(false);
    }
  }

  async function cancel() {
    setCancelLoading(true);
    try {
      const res = await fetch(`/api/safety/checkin?token=${cancelToken}`, { method: 'DELETE' });
      const data = await res.json() as { success?: boolean };
      if (data.success) setCancelDone(true);
    } catch { /* */ } finally {
      setCancelLoading(false);
    }
  }

  if (step === 'success') {
    return (
      <div className="ds-page min-h-screen flex items-center justify-center px-4">
        <div className="ds-card max-w-md w-full p-6 text-center">
          {cancelDone ? (
            <>
              <div className="w-12 h-12 rounded-full bg-[var(--success)]/12 flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-6 h-6 text-[var(--success)]" />
              </div>
              <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Чекин отменён</h2>
              <p className="text-sm text-[var(--text-muted)]">Уведомление не будет отправлено.</p>
            </>
          ) : (
            <>
              <div className="w-12 h-12 rounded-full bg-[var(--success)]/12 flex items-center justify-center mx-auto mb-4">
                <Shield className="w-6 h-6 text-[var(--success)]" />
              </div>
              <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Чекин зарегистрирован</h2>
              <p className="text-sm text-[var(--text-secondary)] mb-1">
                Если вы не вернётесь к{' '}
                <strong className="text-[var(--text-primary)]">
                  {new Date(form.return_deadline).toLocaleString('ru-RU', { timeZone: 'Asia/Kamchatka', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}
                </strong>,
                <br /><strong>{form.emergency_name}</strong> получит уведомление.
              </p>
              <div className="mt-4 p-3 rounded-lg bg-[var(--warning)]/8 border border-[var(--warning)]/20 text-left mb-5">
                <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                  Сохраните эту страницу или скопируйте ссылку — она нужна для отмены чекина.
                </p>
              </div>
              <button
                onClick={cancel}
                disabled={cancelLoading}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-[var(--danger)] text-[var(--danger)] text-sm font-medium hover:bg-[var(--danger)]/8 transition-colors disabled:opacity-50"
              >
                <X className="w-4 h-4" />
                {cancelLoading ? 'Отменяем...' : 'Я вернулся — отменить чекин'}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ds-page min-h-screen px-4 py-10">
      <div className="max-w-md mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2.5 rounded-xl bg-[var(--success)]/12 text-[var(--success)]">
            <Shield className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>
              Чекин туриста
            </h1>
            <p className="text-xs text-[var(--text-muted)]">Страховка на случай если что-то пойдёт не так</p>
          </div>
        </div>

        <div className="p-3 rounded-lg bg-[var(--ocean)]/8 border border-[var(--ocean)]/20 mb-6 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-[var(--ocean)] shrink-0 mt-0.5" />
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            Укажите время возврата и контакт. Если вы не отмените чекин вовремя —
            экстренный контакт получит уведомление с вашим маршрутом.
          </p>
        </div>

        <form onSubmit={submit} className="ds-card p-5 space-y-4">
          {/* Tourist info */}
          <div>
            <label className="ds-label flex items-center gap-1.5 mb-1.5">
              <User className="w-3.5 h-3.5" /> Ваше имя
            </label>
            <input
              className="ds-input w-full"
              placeholder="Иван Петров"
              value={form.tourist_name}
              onChange={set('tourist_name')}
              required minLength={2} maxLength={100}
            />
          </div>

          <div>
            <label className="ds-label flex items-center gap-1.5 mb-1.5">
              Маршрут / место
            </label>
            <input
              className="ds-input w-full"
              placeholder="Вулкан Авача, радиальный выход"
              value={form.route_name}
              onChange={set('route_name')}
              required minLength={2} maxLength={200}
            />
          </div>

          <div>
            <label className="ds-label flex items-center gap-1.5 mb-1.5">
              <Clock className="w-3.5 h-3.5" /> Вернусь не позже
            </label>
            <input
              type="datetime-local"
              className="ds-input w-full"
              min={minDeadline()}
              value={form.return_deadline}
              onChange={set('return_deadline')}
              required
            />
            <p className="text-[11px] text-[var(--text-muted)] mt-1">Минимум через 30 минут</p>
          </div>

          {/* Emergency contact */}
          <div className="border-t border-[var(--border)] pt-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
              Экстренный контакт
            </p>

            <div className="space-y-3">
              <div>
                <label className="ds-label mb-1.5">Имя контакта</label>
                <input
                  className="ds-input w-full"
                  placeholder="Мария Петрова (сестра)"
                  value={form.emergency_name}
                  onChange={set('emergency_name')}
                  required minLength={2} maxLength={100}
                />
              </div>

              <div>
                <label className="ds-label flex items-center gap-1.5 mb-1.5">
                  <Phone className="w-3.5 h-3.5" /> Телефон
                </label>
                <input
                  className="ds-input w-full"
                  placeholder="+7 914 000 00 00"
                  value={form.emergency_phone}
                  onChange={set('emergency_phone')}
                  maxLength={30}
                />
              </div>

              <div>
                <label className="ds-label mb-1.5">Telegram (необязательно)</label>
                <input
                  className="ds-input w-full"
                  placeholder="@username"
                  value={form.emergency_telegram}
                  onChange={set('emergency_telegram')}
                  maxLength={64}
                />
              </div>
            </div>
          </div>

          {error && (
            <p className="text-sm text-[var(--danger)] bg-[var(--danger)]/8 px-3 py-2 rounded-lg">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="ds-btn ds-btn-primary w-full"
          >
            {loading ? 'Регистрируем...' : 'Зарегистрировать чекин'}
          </button>
        </form>

        <p className="text-[11px] text-[var(--text-muted)] text-center mt-4 leading-relaxed">
          Данные хранятся только для цели безопасности. Никакой слежки — только подстраховка.
        </p>
      </div>
    </div>
  );
}

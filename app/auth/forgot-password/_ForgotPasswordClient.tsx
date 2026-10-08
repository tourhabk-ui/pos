'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import Logo from '@/components/shared/Logo';

const INPUT = 'w-full px-3.5 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors';
const LABEL = 'block text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1.5';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'sent'; message: string }
  | { kind: 'error'; error: string };

export default function ForgotPasswordClient() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await res.json().catch(() => null) as
        | { success: true; message: string }
        | { success: false; error?: string }
        | null;
      if (!res.ok || !body || !body.success) {
        setState({ kind: 'error', error: (body && !body.success && body.error) || `Сервер ответил ${res.status}` });
        return;
      }
      setState({ kind: 'sent', message: body.message });
    } catch {
      setState({ kind: 'error', error: 'Нет связи с сервером. Попробуйте ещё раз.' });
    }
  }

  return (
    <main className="min-h-screen bg-[var(--bg-primary)] py-12 px-4">
      <div className="max-w-md mx-auto">
        <div className="text-center mb-6">
          <Link href="/" className="inline-flex items-center justify-center mb-3 text-[var(--text-primary)]" aria-label="Ведар — на главную">
            <Logo size={40} />
          </Link>
          <h1 className="font-playfair text-2xl font-bold text-[var(--text-primary)]">Сброс пароля</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Укажите email аккаунта — пришлём ссылку для нового пароля
          </p>
        </div>

        {state.kind === 'sent' ? (
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 space-y-4">
            <p className="text-sm text-[var(--text-primary)]" role="status">{state.message}</p>
            <Link href="/auth/login" className="block text-center text-sm text-[var(--ocean)] hover:underline">
              Вернуться ко входу
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 space-y-4">
            {state.kind === 'error' && (
              <div className="px-4 py-3 bg-[var(--danger)]/10 border border-[var(--danger)]/30 rounded-md text-sm text-[var(--danger)]" role="alert">
                {state.error}
              </div>
            )}
            <div>
              <label htmlFor="forgot-email" className={LABEL}>Email</label>
              <input
                id="forgot-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className={INPUT}
                placeholder="your@email.com"
              />
            </div>
            <button
              type="submit"
              disabled={state.kind === 'loading'}
              className="w-full py-2.5 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {state.kind === 'loading' ? 'Отправляем...' : 'Отправить ссылку'}
            </button>
            <Link href="/auth/login" className="block text-center text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
              Вспомнили пароль? Войти
            </Link>
          </form>
        )}
      </div>
    </main>
  );
}

'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Eye, EyeOff } from 'lucide-react';
import Logo from '@/components/shared/Logo';
import { PASSWORD_RULE_HINT, validatePassword } from '@/lib/auth/password-rule';

const INPUT = 'w-full px-3.5 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors';
const LABEL = 'block text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1.5';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; message: string }
  | { kind: 'error'; error: string };

export default function ResetPasswordClient() {
  // Токен читается после монтирования, чтобы не тянуть useSearchParams и
  // Suspense на служебную страницу (тот же приём, что у /auth/login?mode=).
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [state, setState] = useState<State>({ kind: 'idle' });

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get('token') ?? '');
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setState({ kind: 'error', error: 'Пароли не совпадают' });
      return;
    }
    const rule = validatePassword(password);
    if (!rule.valid) {
      setState({ kind: 'error', error: rule.errors[0] });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const body = await res.json().catch(() => null) as
        | { success: true; message: string }
        | { success: false; error?: string }
        | null;
      if (!res.ok || !body || !body.success) {
        setState({ kind: 'error', error: (body && !body.success && body.error) || `Сервер ответил ${res.status}` });
        return;
      }
      setState({ kind: 'done', message: body.message });
    } catch {
      setState({ kind: 'error', error: 'Нет связи с сервером. Попробуйте ещё раз.' });
    }
  }

  const noToken = token === '';

  return (
    <main className="min-h-screen bg-[var(--bg-primary)] py-12 px-4">
      <div className="max-w-md mx-auto">
        <div className="text-center mb-6">
          <Link href="/" className="inline-flex items-center justify-center mb-3 text-[var(--text-primary)]" aria-label="Ведар — на главную">
            <Logo size={40} />
          </Link>
          <h1 className="font-playfair text-2xl font-bold text-[var(--text-primary)]">Новый пароль</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">{PASSWORD_RULE_HINT}</p>
        </div>

        {state.kind === 'done' ? (
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 space-y-4">
            <p className="text-sm text-[var(--text-primary)]" role="status">{state.message}</p>
            <Link
              href="/auth/login"
              className="block w-full py-2.5 text-center bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:opacity-90 transition-opacity"
            >
              Войти
            </Link>
          </div>
        ) : noToken ? (
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 space-y-4">
            <p className="text-sm text-[var(--text-primary)]" role="alert">
              В адресе нет ссылки для сброса. Откройте письмо ещё раз или запросите новую ссылку.
            </p>
            <Link href="/auth/forgot-password" className="block text-center text-sm text-[var(--ocean)] hover:underline">
              Запросить новую ссылку
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
              <label htmlFor="reset-password" className={LABEL}>Новый пароль</label>
              <div className="relative">
                <input
                  id="reset-password"
                  type={show ? 'text' : 'password'}
                  required
                  autoComplete="new-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className={INPUT}
                  placeholder="Введите новый пароль"
                />
                <button
                  type="button"
                  onClick={() => setShow(v => !v)}
                  aria-label={show ? 'Скрыть пароль' : 'Показать пароль'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div>
              <label htmlFor="reset-password-confirm" className={LABEL}>Ещё раз</label>
              <input
                id="reset-password-confirm"
                type={show ? 'text' : 'password'}
                required
                autoComplete="new-password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                className={INPUT}
                placeholder="Повторите пароль"
              />
            </div>
            <button
              type="submit"
              disabled={state.kind === 'loading' || token === null}
              className="w-full py-2.5 bg-[var(--accent)] text-white text-sm font-medium rounded-md hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {state.kind === 'loading' ? 'Сохраняем...' : 'Сохранить пароль'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

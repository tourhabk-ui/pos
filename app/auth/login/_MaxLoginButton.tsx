'use client';

/**
 * Вход через MAX (бот-авторизация РФ-пользователей).
 *
 * MAX не даёт OAuth-виджета: жмём кнопку → сайт создаёт одноразовую сессию и
 * deep-link в бота → пользователь подтверждает «Старт» в MAX → бот отмечает
 * сессию → сайт опросом ловит подтверждение и логинит. Телефон не требуем.
 *
 * Env (public): NEXT_PUBLIC_MAX_LOGIN_ENABLED — 'true' чтобы показать кнопку.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageCircle } from 'lucide-react';

interface MaxAuthResult {
  id: string;
  email: string;
  name: string;
  role: string;
  token: string;
}

interface Props {
  onAuth: (user: MaxAuthResult) => void;
  onError?: (message: string) => void;
}

const POLL_MS = 2500;
const MAX_POLL_MS = 5 * 60 * 1000;

/** Открываем только ссылки на сам MAX — защита от подмены deep-link (open redirect). */
function isSafeMaxLink(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'max.ru' || u.hostname.endsWith('.max.ru'));
  } catch {
    return false;
  }
}

export default function MaxLoginButton({ onAuth, onError }: Props) {
  const [waiting, setWaiting] = useState(false);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  const stop = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setWaiting(false);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const poll = useCallback(async (nonce: string) => {
    if (Date.now() - startedAtRef.current > MAX_POLL_MS) {
      stop();
      onError?.('Время входа истекло. Попробуйте снова.');
      return;
    }
    try {
      const res = await fetch(`/api/auth/max/status?nonce=${encodeURIComponent(nonce)}`);
      const result = await res.json();
      if (result.success && result.status === 'authenticated') {
        stop();
        onAuth(result.data as MaxAuthResult);
        return;
      }
      if (result.status === 'expired' || result.status === 'invalid') {
        stop();
        onError?.('Ссылка входа устарела. Попробуйте снова.');
      }
    } catch { /* сеть моргнула — продолжаем опрос */ }
  }, [onAuth, onError, stop]);

  const handleClick = useCallback(async () => {
    setWaiting(true);
    try {
      const res = await fetch('/api/auth/max/start', { method: 'POST' });
      const result = await res.json();
      if (!res.ok || !result.success) throw new Error(result.error || 'Не удалось начать вход через MAX.');
      if (typeof result.deepLink !== 'string' || !isSafeMaxLink(result.deepLink)) {
        throw new Error('Некорректная ссылка входа.');
      }

      setDeepLink(result.deepLink);
      startedAtRef.current = Date.now();
      // Открываем бота (на телефоне — приложение MAX).
      window.open(result.deepLink, '_blank', 'noopener');

      timerRef.current = setInterval(() => poll(result.nonce), POLL_MS);
    } catch (err) {
      stop();
      onError?.(err instanceof Error ? err.message : 'Ошибка входа через MAX.');
    }
  }, [poll, stop, onError]);

  if (process.env.NEXT_PUBLIC_MAX_LOGIN_ENABLED !== 'true') return null;

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={waiting}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white bg-[var(--ocean)] hover:opacity-90 transition-all duration-200 disabled:opacity-60"
      >
        <MessageCircle size={16} />
        {waiting ? 'Подтвердите вход в MAX…' : 'Войти через MAX'}
      </button>
      {waiting && deepLink && (
        <a
          href={deepLink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-[var(--ocean)] underline"
        >
          Не открылся MAX? Нажмите здесь
        </a>
      )}
    </div>
  );
}

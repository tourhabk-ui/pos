'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

/**
 * «Выйти» — одна реализация на всю платформу.
 *
 * Повод (#1778, прогулка туристом 10.09): выхода из аккаунта не было НИГДЕ —
 * ни в кабинете, ни в профиле, ни в «Ещё». Сессию можно было закончить только
 * чисткой cookie руками. Сам выход при этом существовал: `signOut()` в
 * AuthContext (POST /api/auth/signout + очистка локального состояния) — его
 * просто никто не звал с экрана.
 *
 * Кнопка рисуется только вошедшему: гостю «Выйти» показывать нечего, а
 * состояние «ещё не знаем» (isLoading) тоже молчит — обещать выход тому,
 * кто, возможно, не вошёл, нельзя.
 *
 * Своих запросов к /api/auth/signout здесь нет намеренно: две реализации
 * одного действия расходятся (урок SOS, #887). Сторож:
 * tests/unit/sign-out-reachable.test.ts.
 */
interface Props {
  className?: string;
  /** Только значок (для узкой шапки кабинета); подпись остаётся в aria-label. */
  iconOnly?: boolean;
  /** Куда уйти после выхода. По умолчанию — на главную. */
  redirectTo?: string;
}

export default function SignOutButton({ className, iconOnly = false, redirectTo = '/' }: Props) {
  const { user, isLoading, signOut } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!user || isLoading) return null;

  const handleClick = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await signOut();
      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      // Отказ не глушится (§4.0): человек видит, что выход не случился.
      console.error('[SignOutButton] выход не удался', {
        message: err instanceof Error ? err.message : String(err),
      });
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      aria-label="Выйти из аккаунта"
      title={failed ? 'Не удалось выйти. Попробуйте ещё раз.' : 'Выйти'}
      className={className}
      style={{ minHeight: 44, minWidth: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
    >
      <LogOut size={iconOnly ? 20 : 16} aria-hidden />
      {!iconOnly && <span>{failed ? 'Не удалось выйти — повторить' : busy ? 'Выходим…' : 'Выйти'}</span>}
    </button>
  );
}

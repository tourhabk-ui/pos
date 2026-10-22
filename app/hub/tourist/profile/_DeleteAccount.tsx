'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ShieldOff, Loader2, AlertCircle } from 'lucide-react';
import { ERASE_PHRASE } from '@/lib/account/erase';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

type Mode = 'delete' | 'revoke_consent';

/**
 * Персональные данные (152-ФЗ): отзыв согласия и удаление аккаунта.
 * Согласие — условие аккаунта, поэтому обе кнопки ведут к одному стиранию;
 * различается только записанная причина. Подтверждение — ввод слова.
 */
export default function DeleteAccount() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!mode) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/user/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ confirm: true, phrase, mode }),
      });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        setError(json.error ?? 'Не удалось удалить аккаунт. Попробуйте позже.');
        return;
      }
      try { localStorage.removeItem('user'); } catch (err) { logSwallowedFailure('delete-account', 'очистка localStorage', err); }
      window.location.href = '/?account=deleted';
    } catch {
      setError('Нет связи с сервером. Попробуйте позже.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="pd-heading"
      className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 space-y-4"
    >
      <div className="flex items-center gap-3">
        <ShieldOff className="w-5 h-5 text-[var(--danger)]" />
        <h2 id="pd-heading" className="text-lg font-semibold text-[var(--text-primary)]">
          Персональные данные
        </h2>
      </div>
      <p className="text-sm text-[var(--text-secondary)]">
        Вы можете отозвать согласие на обработку персональных данных или удалить аккаунт
        (152-ФЗ). Без согласия аккаунт работать не может, поэтому в обоих случаях имя, почта,
        телефон, привязки Telegram и MAX и экстренный контакт стираются сразу. Прошедшие заявки
        и отзывы остаются у операторов без ваших данных.{' '}
        <Link href="/legal/privacy" className="underline">Политика конфиденциальности</Link>
      </p>

      {!mode ? (
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => setMode('revoke_consent')}
            className="ds-btn ds-btn-secondary min-h-[44px] px-5">
            Отозвать согласие
          </button>
          <button type="button" onClick={() => setMode('delete')}
            className="ds-btn min-h-[44px] px-5 border border-[var(--danger)] text-[var(--danger)]">
            Удалить аккаунт
          </button>
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border border-[var(--danger)]/40 p-4">
          <p className="text-sm text-[var(--text-primary)]">
            {mode === 'revoke_consent' ? 'Отзыв согласия удалит аккаунт.' : 'Аккаунт будет удалён.'}{' '}
            Это нельзя отменить. Введите <b>{ERASE_PHRASE}</b>, чтобы подтвердить.
          </p>
          <input
            aria-label="Слово для подтверждения"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            autoComplete="off"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)]"
          />
          {error && (
            <div role="alert" className="flex items-start gap-2 text-sm rounded-lg px-4 py-3 bg-[var(--danger)]/10 text-[var(--danger)] border border-[var(--danger)]/30">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              {error}
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => { void submit(); }}
              disabled={busy || phrase.trim().toUpperCase() !== ERASE_PHRASE}
              className="ds-btn min-h-[44px] px-5 bg-[var(--danger)] text-white disabled:opacity-50 flex items-center gap-2">
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Удалить навсегда
            </button>
            <button type="button" onClick={() => { setMode(null); setPhrase(''); setError(null); }}
              className="ds-btn ds-btn-secondary min-h-[44px] px-5">
              Отмена
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

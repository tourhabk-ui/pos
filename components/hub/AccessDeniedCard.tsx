'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert, Loader2, Repeat } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { ownedRoles, canSwitchTo, ROLE_LABELS } from '@/lib/auth/role-switch';
import { ROLE_HUB } from '@/lib/auth/role-routes';

/**
 * Экран «сюда нельзя» для разделов кабинета.
 *
 * Повод: владелец переключился в другую роль через god-mode, зашёл в админку и
 * увидел карточку «Ошибка загрузки · Недостаточно прав доступа · Повторить».
 * Кнопка «Повторить» в этом состоянии не может сработать НИКОГДА — 403 не
 * лечится повтором запроса, — а какая роль сейчас активна и где выход, экран
 * не сообщал. Со стороны это читается не как «вы смотрите чужими глазами», а
 * как «платформа сломалась и доступа нет ни к чему».
 *
 * Поэтому здесь: что за раздел, в какой роли вы сейчас, и одно нажатие назад —
 * если нужная роль вообще ваша. Прав это никому не добавляет: переключение
 * идёт через тот же /api/auth/switch-role, который проверяет владение ролью на
 * сервере и клиенту не верит.
 */
export function AccessDeniedCard({ requiredRole = 'admin' }: { requiredRole?: string }) {
  const { user, switchRole } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeLabel = user ? (ROLE_LABELS[user.role] ?? user.role) : null;
  const requiredLabel = ROLE_LABELS[requiredRole] ?? requiredRole;

  const owned = user ? ownedRoles(user.roles, user.role) : [];
  const canReturn = user ? canSwitchTo(user.role, owned, requiredRole) : false;

  const handleReturn = async () => {
    setBusy(true);
    setError(null);
    try {
      const redirect = await switchRole(requiredRole);
      router.push(redirect);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось переключить роль');
      setBusy(false);
    }
  };

  return (
    <div className="p-6 flex items-center justify-center min-h-[400px]">
      <div className="max-w-sm bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 text-center">
        <div className="w-10 h-10 rounded-full bg-[var(--warning)]/10 flex items-center justify-center mx-auto mb-4">
          <ShieldAlert className="w-5 h-5 text-[var(--warning)]" />
        </div>

        <p className="text-sm font-medium text-[var(--text-primary)] mb-1">
          Раздел для роли «{requiredLabel}»
        </p>

        <p className="text-xs text-[var(--text-muted)] mb-4">
          {activeLabel
            ? `Сейчас вы работаете в роли «${activeLabel}». Данные раздела в ней недоступны.`
            : 'Похоже, сессия закончилась — войдите заново.'}
        </p>

        {canReturn ? (
          <button
            onClick={handleReturn}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[var(--accent)] bg-[var(--accent)]/10 rounded-md hover:bg-[var(--accent)]/15 transition-colors disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Repeat className="w-3 h-3" />}
            Вернуться в «{requiredLabel}»
          </button>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">
            Эта роль вам не принадлежит. Если доступ нужен — попросите администратора.
          </p>
        )}

        {error && <p className="mt-3 text-xs text-[var(--danger)]">{error}</p>}

        {canReturn && (
          <p className="mt-3 text-[10px] text-[var(--text-muted)]">
            То же самое делает переключатель ролей в шапке.
          </p>
        )}

        {!canReturn && user && ROLE_HUB[user.role] && (
          <p className="mt-3 text-[10px] text-[var(--text-muted)]">
            Ваш кабинет — {ROLE_HUB[user.role]}
          </p>
        )}
      </div>
    </div>
  );
}

'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, Check, Loader2, Repeat } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { availableForSwitch, ownedRoles, ROLE_LABELS } from '@/lib/auth/role-switch';

/**
 * Переключатель активной роли в шапке кабинета. Admin видит все роли (god-mode
 * владельца — показать любой интерфейс), остальные — свои. Активная подсвечена.
 * Не рендерится, если переключаться не на что.
 */
export function RoleSwitcher() {
  const { user, switchRole } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  if (!user) return null;

  const owned = ownedRoles(user.roles, user.role);
  const options = availableForSwitch(user.role, owned);

  // Нечего переключать (одна доступная роль и это текущая).
  if (options.length <= 1) return null;

  const handleSwitch = async (role: string) => {
    if (role === user.role) { setOpen(false); return; }
    setBusy(role);
    setError(null);
    try {
      const redirect = await switchRole(role);
      setOpen(false);
      router.push(redirect);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка переключения');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm border transition-colors hover:bg-[var(--bg-hover)]"
        style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}
        aria-label="Переключить роль"
      >
        <Repeat size={15} className="text-[var(--ocean)]" />
        <span className="hidden sm:inline font-medium">{ROLE_LABELS[user.role] ?? user.role}</span>
        <ChevronDown size={14} className="text-[var(--text-muted)]" />
      </button>

      {open && (
        <div
          className="absolute right-0 mt-1 w-48 rounded-lg border bg-[var(--bg-card)] shadow-lg py-1 z-50"
          style={{ borderColor: 'var(--border)' }}
        >
          <p className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
            Войти как
          </p>
          {options.map((role) => {
            const active = role === user.role;
            const isBusy = busy === role;
            return (
              <button
                key={role}
                onClick={() => handleSwitch(role)}
                disabled={!!busy}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-60"
                style={{ color: active ? 'var(--accent)' : 'var(--text-primary)' }}
              >
                <span className="font-medium">{ROLE_LABELS[role] ?? role}</span>
                {isBusy ? (
                  <Loader2 size={14} className="animate-spin text-[var(--text-muted)]" />
                ) : active ? (
                  <Check size={14} />
                ) : null}
              </button>
            );
          })}
          {error && (
            <p className="px-3 py-1.5 text-[11px] text-[var(--danger)]">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}

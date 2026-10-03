'use client';

/**
 * «Не считать мои заходы» — метка своего браузера (решение владельца 02.10).
 *
 * Ставит cookie vedar_self на год В ЭТОМ браузере: маяки page_views и
 * funnel_events пишут такие заходы с is_self = TRUE, панели считают внешних
 * без них и показывают своё отдельным числом. На каждом устройстве метка
 * ставится отдельно — телефон, ноутбук; IP для этого не годится, он меняется.
 * Правило чтения cookie — lib/analytics/self-visit, здесь только тумблер.
 */
import { useEffect, useState } from 'react';
import { UserCheck } from 'lucide-react';
import { SELF_VISIT_COOKIE, selfVisitCookieString } from '@/lib/analytics/self-visit';

function readSelf(): boolean {
  try {
    return document.cookie.split(';').some((p) => p.trim() === `${SELF_VISIT_COOKIE}=1`);
  } catch {
    return false;
  }
}

export default function SelfVisitToggle({ selfMonthHits, selfSince }: { selfMonthHits: number | null; selfSince: string | null }) {
  // До монтирования состояние неизвестно: не рисуем выключенный тумблер за включённый.
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { setOn(readSelf()); }, []);

  const toggle = () => {
    const next = !(on ?? false);
    try {
      document.cookie = selfVisitCookieString(next);
    } catch {
      // Cookie запрещены настройками браузера: метка не ставится, и тумблер это покажет.
    }
    setOn(readSelf());
  };

  return (
    <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <UserCheck className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />
      <div className="flex-1 min-w-[12rem]">
        <p className="text-xs font-medium text-[var(--text-primary)]">
          Мои заходы в этом браузере
          {on === null ? '' : on ? ': помечены как свои' : ': считаются как внешние'}
        </p>
        <p className="text-[10px] text-[var(--text-muted)]">
          Метка живёт год и только здесь; на телефоне включается отдельно. Свои заходы
          не прячутся, а отделяются: за 30 дней их {selfMonthHits ?? '—'}
          {selfSince ? `, метка ставится с ${selfSince}` : '; до первой метки свои и чужие в цифрах неразличимы'}.
        </p>
      </div>
      <button
        type="button"
        onClick={toggle}
        disabled={on === null}
        className={on ? 'ds-btn ds-btn-secondary text-xs' : 'ds-btn ds-btn-primary text-xs'}
      >
        {on ? 'Снять метку' : 'Не считать мои заходы'}
      </button>
    </div>
  );
}

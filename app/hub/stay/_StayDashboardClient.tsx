'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BarChart3, Home, ClipboardList, CalendarCheck, Wallet, CalendarDays, PlusCircle } from 'lucide-react';
import { useOnboardingGuard } from '@/components/hub/usePartnerOnboarding';

/**
 * Обзор кабинета владельца жилья. Данные — из /api/stay/stats.
 * Профиль партнёра создаётся при регистрации (ensurePartnerForRole)
 * или автоматически при первом заходе (GET /api/partners/profile);
 * незавершённый онбординг уводит в /hub/stay/onboarding.
 */

interface StayStats {
  accommodations: { total: number; active: number };
  bookings: {
    total: number; pending: number; confirmed: number;
    completed: number; cancelled: number; noShow: number;
    upcomingCheckins: number;
  };
  revenue: { paid: number; expected: number };
}

function formatMoney(v: number): string {
  return new Intl.NumberFormat('ru-RU').format(v) + ' ₽';
}

export default function StayDashboardClient() {
  const router = useRouter();
  const [stats, setStats] = useState<StayStats | null>(null);
  const [noProfile, setNoProfile] = useState(false);
  const [failed, setFailed] = useState(false);

  // Гвард онбординга: GET /api/partners/profile авто-создаёт профиль
  // (legacy-аккаунты без partners-записи), незавершённый — в визард.
  // Загрузка статистики ждёт гварда — без гонки и вспышки дашборда
  const onboardingReady = useOnboardingGuard('/hub/stay/onboarding');

  useEffect(() => {
    if (!onboardingReady) return;
    fetch('/api/stay/stats')
      .then(r => {
        if (r.status === 404) {
          setNoProfile(true);
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((d: { success?: boolean; data?: StayStats } | null) => {
        if (d === null) return;
        if (d?.success && d.data) setStats(d.data);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [onboardingReady]);

  if (noProfile) {
    return (
      <div className="p-5 lg:p-6">
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center max-w-lg">
          <p className="text-sm font-semibold text-[var(--text-primary)] mb-2">Кабинет ещё не настроен</p>
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            Заполните профиль владельца и добавьте первый объект — брони начнут приходить сюда.
          </p>
          <button className="ds-btn ds-btn-primary" onClick={() => router.push('/hub/stay/onboarding')}>
            Настроить кабинет
          </button>
        </div>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="p-5 lg:p-6">
        <p className="text-sm text-[var(--danger)]">Не удалось загрузить данные кабинета. Обновите страницу.</p>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="p-5 lg:p-6 grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="ds-skeleton h-24 rounded-lg" />
        ))}
      </div>
    );
  }

  const metrics = [
    { label: 'Объекты', value: `${stats.accommodations.active} / ${stats.accommodations.total}`, hint: 'на витрине / всего', icon: Home },
    { label: 'Новые брони', value: String(stats.bookings.pending), hint: 'ждут подтверждения', icon: ClipboardList },
    // Хинт про заезды — про заезды: подтверждённые брони, из которых они и берутся
    // (раньше здесь показывалось «завершено» — другая метрика в чужой карточке).
    { label: 'Ближайшие заезды', value: String(stats.bookings.upcomingCheckins), hint: `подтверждено: ${stats.bookings.confirmed}`, icon: CalendarCheck },
    { label: 'Оплачено', value: formatMoney(stats.revenue.paid), hint: `ожидается: ${formatMoney(stats.revenue.expected)}`, icon: Wallet },
  ];

  // Остальные счётчики API приходили, но нигде не показывались — выносим честной
  // сводкой, чтобы владелец видел всю картину по броням, а не три числа из семи.
  const breakdown = [
    { label: 'всего', value: stats.bookings.total },
    { label: 'завершено', value: stats.bookings.completed },
    { label: 'отменено', value: stats.bookings.cancelled },
    { label: 'не заехали', value: stats.bookings.noShow },
  ];

  const quickActions = [
    { href: '/hub/stay/accommodations', label: 'Мои объекты', icon: Home },
    { href: '/hub/stay/bookings',       label: 'Входящие брони', icon: ClipboardList },
    { href: '/hub/stay/calendar',       label: 'Календарь', icon: CalendarDays },
    { href: '/hub/stay/onboarding',     label: 'Добавить объект', icon: PlusCircle },
  ];

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center gap-2.5">
        <BarChart3 className="w-4 h-4 text-[var(--text-muted)]" />
        <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Кабинет владельца жилья</h1>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {metrics.map(m => {
          const Icon = m.icon;
          return (
            <div key={m.label} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon className="w-4 h-4 text-[var(--text-muted)]" />
                <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">{m.label}</span>
              </div>
              <p className="text-xl font-bold text-[var(--text-primary)]">{m.value}</p>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">{m.hint}</p>
            </div>
          );
        })}
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
        <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">
          <ClipboardList className="w-3.5 h-3.5" />
          Брони — всего
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {breakdown.map(b => (
            <div key={b.label}>
              <p className="text-lg font-bold text-[var(--text-primary)]">{b.value}</p>
              <p className="text-xs text-[var(--text-secondary)]">{b.label}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
        <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Быстрые действия</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {quickActions.map(a => {
            const Icon = a.icon;
            return (
              <button
                key={a.href}
                onClick={() => router.push(a.href)}
                className="flex flex-col items-center gap-2 p-3 bg-[var(--bg-primary)] border border-[var(--border)] rounded-md hover:bg-[var(--bg-hover)] transition-colors text-center">
                <Icon className="w-4 h-4 text-[var(--text-muted)]" />
                <span className="text-xs text-[var(--text-secondary)]">{a.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BarChart3, Backpack, ClipboardList, Package, Star, Wallet } from 'lucide-react';

/**
 * Обзор кабинета проката снаряжения. Данные — из /api/gear/profile
 * (авто-создаёт партнёрский профиль при первом входе и возвращает stats).
 */

interface GearStats {
  items: { total: number; active: number };
  rentals: { total: number; active: number; completed: number; pending: number };
  revenue: { total: number; monthlyTrends: { month: string; rentalsCount: number; revenue: number }[] };
  reviews: { total: number; avgRating: string };
  topItems: { id: string; name: string; category: string; rentalCount: number; totalRevenue: number; rating: number }[];
}

interface ProfileData {
  partner: { name: string; isVerified: boolean } | null;
  stats: GearStats | null;
}

function formatMoney(v: number): string {
  return new Intl.NumberFormat('ru-RU').format(v) + ' ₽';
}

export default function GearDashboardClient() {
  const router = useRouter();
  const [data, setData] = useState<ProfileData | null>(null);
  const [failed, setFailed] = useState(false);

  // Гвард онбординга: новый партнёр сначала настраивает профиль
  // (partners.onboarding_completed — общий флаг, миграция 052)
  useEffect(() => {
    fetch('/api/partners/profile')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { data?: { partner?: { onboarding_completed?: boolean } } } | null) => {
        if (d?.data?.partner && !d.data.partner.onboarding_completed) {
          router.replace('/hub/gear/onboarding');
        }
      })
      .catch(() => {});
  }, [router]);

  useEffect(() => {
    fetch('/api/gear/profile')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: ProfileData } | null) => {
        if (d?.success && d.data) setData(d.data);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <div className="p-5 lg:p-6">
        <p className="text-sm text-[var(--danger)]">Не удалось загрузить данные кабинета. Обновите страницу.</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-5 lg:p-6 grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="ds-skeleton h-24 rounded-lg" />
        ))}
      </div>
    );
  }

  const stats = data.stats;

  const metrics = stats
    ? [
        { label: 'Позиций в инвентаре', value: `${stats.items.active} / ${stats.items.total}`, hint: 'активных / всего', icon: Package },
        { label: 'Новых заявок', value: String(stats.rentals.pending), hint: 'ждут подтверждения', icon: ClipboardList },
        { label: 'Сейчас в аренде', value: String(stats.rentals.active), hint: `завершено: ${stats.rentals.completed}`, icon: Backpack },
        { label: 'Выручка', value: formatMoney(stats.revenue.total), hint: 'выданные и завершённые', icon: Wallet },
      ]
    : [];

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center gap-2.5">
        <BarChart3 className="w-4 h-4 text-[var(--text-muted)]" />
        <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">
          {data.partner?.name ? `Прокат «${data.partner.name}»` : 'Кабинет проката снаряжения'}
        </h1>
      </div>

      {stats ? (
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
      ) : (
        <p className="text-sm text-[var(--text-secondary)]">Статистика пока недоступна.</p>
      )}

      {/* Топ позиций */}
      {stats && stats.topItems.length > 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Топ позиций по арендам</p>
          <div className="space-y-2">
            {stats.topItems.map(item => (
              <div key={item.id} className="flex items-center justify-between text-sm">
                <span className="text-[var(--text-primary)] truncate">{item.name}</span>
                <span className="flex items-center gap-3 text-[var(--text-secondary)] shrink-0">
                  {item.rating > 0 && (
                    <span className="flex items-center gap-1">
                      <Star className="w-3 h-3 text-[var(--warning)]" />
                      {item.rating.toFixed(1)}
                    </span>
                  )}
                  <span>{item.rentalCount} аренд</span>
                  <span>{formatMoney(item.totalRevenue)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Быстрые действия */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
        <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Быстрые действия</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => router.push('/hub/gear/inventory')}
            className="flex flex-col items-center gap-2 p-3 bg-[var(--bg-primary)] border border-[var(--border)] rounded-md hover:bg-[var(--bg-hover)] transition-colors text-center">
            <Backpack className="w-4 h-4 text-[var(--text-muted)]" />
            <span className="text-xs text-[var(--text-secondary)]">Инвентарь</span>
          </button>
          <button
            onClick={() => router.push('/hub/gear/rentals')}
            className="flex flex-col items-center gap-2 p-3 bg-[var(--bg-primary)] border border-[var(--border)] rounded-md hover:bg-[var(--bg-hover)] transition-colors text-center">
            <ClipboardList className="w-4 h-4 text-[var(--text-muted)]" />
            <span className="text-xs text-[var(--text-secondary)]">Заявки на аренду</span>
          </button>
        </div>
      </div>
    </div>
  );
}

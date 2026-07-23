'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AgentMetricsGrid } from '@/components/agent/Dashboard/AgentMetricsGrid';
import { RecentClientsTable } from '@/components/agent/Dashboard/RecentClientsTable';
import { UpcomingBookingsTable } from '@/components/agent/Dashboard/UpcomingBookingsTable';
import { BarChart3, Users, Calendar, Receipt, Loader2, Share2, type LucideIcon } from 'lucide-react';
import { useOnboardingGuard } from '@/components/hub/usePartnerOnboarding';

// Кабинет агента в эталонном «туристском» формате (как «Модели эволюции» и
// дашборд агентов): playfair-хедер, icon-circle секции, ds-карточки. Данные и
// дочерние компоненты не тронуты — только форма (см. docs/AGENT_ROLE_AUDIT.md).

const QUICK_ACTIONS = [
  { label: 'Добавить клиента', href: '/hub/agent/clients', icon: Users },
  { label: 'Создать бронирование', href: '/hub/agent/bookings', icon: Calendar },
  { label: 'Создать ваучер', href: '/hub/agent/vouchers', icon: Receipt },
  { label: 'Реферальные ссылки', href: '/hub/agent/referral', icon: Share2 },
];

function SectionHeader({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--ocean)]/10">
        <Icon className="w-[22px] h-[22px] text-[var(--ocean)]" strokeWidth={1.75} />
      </span>
      <div>
        <h2 className="font-playfair text-xl font-bold text-[var(--text-primary)]">{title}</h2>
        {subtitle && <p className="ds-label">{subtitle}</p>}
      </div>
    </div>
  );
}

export default function AgentDashboardClient() {
  const router = useRouter();
  const [period, setPeriod] = useState('30');
  // Гвард онбординга: незаполненный профиль агента уводит в визард
  // (агентские таблицы на user_id никогда не 404, поэтому гейт — только здесь).
  const onboardingReady = useOnboardingGuard('/hub/agent/onboarding');

  if (!onboardingReady) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl lg:max-w-6xl mx-auto px-4 py-6 lg:py-8 space-y-6">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-playfair text-2xl sm:text-3xl font-bold text-[var(--text-primary)]">Кабинет агента</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Клиенты, брони, комиссии и реферальные ссылки в одном месте.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="ds-label">Период</span>
          <select
            value={period}
            onChange={e => setPeriod(e.target.value)}
            className="ds-input py-1.5 px-2.5 text-sm w-auto"
          >
            <option value="7">7 дней</option>
            <option value="30">30 дней</option>
            <option value="90">90 дней</option>
            <option value="365">Год</option>
          </select>
        </label>
      </header>

      {/* Сводка метрик */}
      <AgentMetricsGrid period={period} />

      {/* Быстрые действия */}
      <section className="ds-card">
        <SectionHeader icon={BarChart3} title="Быстрые действия" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {QUICK_ACTIONS.map(action => {
            const Icon = action.icon;
            return (
              <button
                key={action.href}
                onClick={() => router.push(action.href)}
                className="flex flex-col items-center gap-2.5 p-4 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] hover:border-[var(--ocean)]/50 transition-colors text-center"
              >
                <span className="flex items-center justify-center w-10 h-10 rounded-full bg-[var(--ocean)]/10">
                  <Icon className="w-5 h-5 text-[var(--ocean)]" strokeWidth={1.75} />
                </span>
                <span className="text-sm text-[var(--text-secondary)]">{action.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Таблицы */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section>
          <SectionHeader icon={Users} title="Недавние клиенты" />
          <RecentClientsTable />
        </section>
        <section>
          <SectionHeader icon={Calendar} title="Ближайшие брони" />
          <UpcomingBookingsTable />
        </section>
      </div>
    </div>
  );
}

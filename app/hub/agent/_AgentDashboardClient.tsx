'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AgentMetricsGrid } from '@/components/agent/Dashboard/AgentMetricsGrid';
import { RecentClientsTable } from '@/components/agent/Dashboard/RecentClientsTable';
import { UpcomingBookingsTable } from '@/components/agent/Dashboard/UpcomingBookingsTable';
import {
  Users, Calendar, Loader2, Inbox, Search, Handshake, CreditCard,
  Link2, Ticket, TrendingUp, User, ArrowRight, type LucideIcon,
} from 'lucide-react';
import { useOnboardingGuard } from '@/components/hub/usePartnerOnboarding';

// Обзор агента в общем формате кабинетов (гид/турист): плитки разделов с
// икон-чипами + сводка метрик + живые таблицы. Референс агентских CRM
// (лид-пайплайн -> брони -> follow-up) закрыт тем, что есть в данных честно:
// новые заявки — баннером наверху (вершина воронки, Watchdog алертит их >2ч),
// брони и клиенты — таблицами. Выдуманных виджетов нет.

// Быстрая навигация по разделам — реальные страницы кабинета (sidebar в
// layout.tsx), сгруппировано по смыслу, формат = SectionsNav гида.
interface SectionLink { href: string; label: string; icon: LucideIcon }
const SECTION_GROUPS: Array<{ title: string; items: SectionLink[] }> = [
  {
    title: 'Продажи',
    items: [
      { href: '/hub/agent/leads',    label: 'Заявки',    icon: Inbox },
      { href: '/hub/agent/find',     label: 'Найти тур', icon: Search },
      { href: '/hub/agent/clients',  label: 'Клиенты',   icon: Users },
      { href: '/hub/agent/bookings', label: 'Сделки',    icon: Handshake },
    ],
  },
  {
    title: 'Деньги и рост',
    items: [
      { href: '/hub/agent/commissions', label: 'Комиссии',   icon: CreditCard },
      { href: '/hub/agent/vouchers',    label: 'Ваучеры',    icon: Ticket },
      { href: '/hub/agent/referral',    label: 'Рефералы',   icon: Link2 },
      { href: '/hub/agent/stats',       label: 'Статистика', icon: TrendingUp },
    ],
  },
  {
    title: 'Аккаунт',
    items: [
      { href: '/hub/agent/profile', label: 'Профиль', icon: User },
    ],
  },
];

function SectionTile({ href, label, icon: Icon }: SectionLink) {
  return (
    <Link
      href={href}
      className="group flex flex-col items-center justify-center gap-2.5 p-3 min-h-[96px] bg-[var(--bg-card)] border border-[var(--border)] rounded-lg transition-all duration-200 hover:border-[var(--accent)]/50 hover:shadow-md hover:-translate-y-0.5 motion-reduce:hover:translate-y-0"
    >
      <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--ocean)]/10 group-hover:bg-[var(--accent)]/12 transition-colors">
        <Icon className="w-[22px] h-[22px] text-[var(--ocean)] group-hover:text-[var(--accent)] transition-colors" strokeWidth={1.75} />
      </span>
      <span className="text-xs font-medium text-[var(--text-primary)] text-center leading-tight">{label}</span>
    </Link>
  );
}

function SectionsNav() {
  return (
    <div className="space-y-6">
      {SECTION_GROUPS.map((group) => (
        <div key={group.title}>
          <p className="ds-label mb-3 flex items-center gap-2">
            <span className="w-4 h-px bg-[var(--accent)]/70" aria-hidden />
            {group.title}
          </p>
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {group.items.map((item) => (
              <SectionTile key={item.href} {...item} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SectionHeader({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--ocean)]/10">
        <Icon className="w-[22px] h-[22px] text-[var(--ocean)]" strokeWidth={1.75} />
      </span>
      <h2 className="font-playfair text-xl font-bold text-[var(--text-primary)]">{title}</h2>
    </div>
  );
}

/**
 * Новые заявки — вершина воронки (референс CRM: lead pipeline первым),
 * Watchdog алертит лиды без ответа >2ч. Есть новые — говорим сразу и громко;
 * нет — баннер не рендерится (честная тишина, не ноль ради ноля).
 */
function NewLeadsBanner() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let active = true;
    fetch('/api/agent/leads?status=new&limit=1')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (active && d?.success) setCount(d.meta?.total ?? 0); })
      .catch(() => { /* не смогли проверить — молчим, не пугаем */ });
    return () => { active = false; };
  }, []);

  if (count === 0) return null;

  return (
    <Link
      href="/hub/agent/leads"
      className="flex items-center gap-3 p-4 bg-[var(--bg-card)] border border-[var(--warning)]/40 rounded-lg transition-colors hover:bg-[var(--bg-hover)]"
    >
      <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--warning)]/10 shrink-0">
        <Inbox className="w-[22px] h-[22px] text-[var(--warning)]" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-[var(--text-primary)]">
          {count === 1 ? 'Новая заявка ждёт ответа' : `Новых заявок ждут ответа: ${count}`}
        </p>
        <p className="text-sm text-[var(--text-secondary)]">Чем быстрее ответ — тем выше конверсия в бронь</p>
      </div>
      <ArrowRight className="w-5 h-5 text-[var(--text-muted)] shrink-0" />
    </Link>
  );
}

export default function AgentDashboardClient() {
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
          <h1 className="font-playfair text-2xl sm:text-3xl font-bold text-[var(--text-primary)]">Обзор</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">Кабинет агента</p>
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

      {/* Новые заявки — если есть, это первое, что видит агент */}
      <NewLeadsBanner />

      {/* Сводка метрик */}
      <AgentMetricsGrid period={period} />

      {/* Быстрая навигация по разделам — формат кабинетов гида/туриста */}
      <SectionsNav />

      {/* Живые таблицы */}
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

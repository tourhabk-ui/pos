'use client';

import { ReactNode } from 'react';
import {
  LayoutDashboard, Search, Users, Handshake, CreditCard, User, Link2,
  TrendingUp, ListChecks,
} from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';
import { PartnerChannelBanner } from '@/components/hub/PartnerChannelBanner';
import { agentRoleOpen } from '@/lib/auth/agent-role';
import { AgentFrozenNote } from '@/components/agent/AgentFrozenNote';

// Статистика — живая страница кабинета, но в меню её не было:
// добраться можно было только прямой ссылкой. Ваучеры удалены 26.09:
// таблицы vouchers в базе нет, страница отвечала 500, а код ваучера нигде
// не применялся к брони.
//
// Пункты сгруппированы по section: на мобиле HubSidebar тогда рендерит
// сворачиваемую сетку иконок по разделам (как в админке) вместо горизонтальной
// ленты, в которую 10 пунктов не влезали — за экраном терялись Сделки,
// Комиссии и всё дальше. Обзор — сверху без раздела.
// Меню собирается на рендере: правило роли одно и живое (#3212).
const sidebarItems = () => [
  { href: '/hub/agent',             label: 'Обзор',      icon: LayoutDashboard },

  { href: '/hub/agent/find',        label: 'Найти тур',  icon: Search,     section: 'Продажи' },
  { href: '/hub/agent/clients',     label: 'Клиенты',    icon: Users,      section: 'Продажи' },
  { href: '/hub/agent/tasks',       label: 'Задачи',     icon: ListChecks, section: 'Продажи' },
  { href: '/hub/agent/bookings',    label: 'Сделки',     icon: Handshake,  section: 'Продажи' },

  // Комиссии и рефералы — деньги через платформу; при выключенном приёме
  // оплаты (05.10) начислять нечего: роль заморожена (#3212), разделов в меню
  // нет, а по прямому адресу страницы говорят «раздел закрыт».
  ...(agentRoleOpen() ? [
    { href: '/hub/agent/commissions', label: 'Комиссии',   icon: CreditCard, section: 'Финансы' },
    { href: '/hub/agent/referral',    label: 'Рефералы',   icon: Link2,      section: 'Финансы' },
  ] : []),

  { href: '/hub/agent/stats',       label: 'Статистика', icon: TrendingUp, section: 'Кабинет' },
  { href: '/hub/agent/profile',     label: 'Профиль',    icon: User,       section: 'Кабинет' },
];

export default function AgentHubLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={sidebarItems()} sidebarTitle="Кабинет агента" requiredRole="agent">
      <PartnerChannelBanner />
      <AgentFrozenNote />
      {children}
    </HubLayout>
  );
}

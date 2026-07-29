'use client';

import { ReactNode } from 'react';
import {
  LayoutDashboard, Inbox, Search, Users, Handshake, CreditCard, User, Link2,
  Ticket, TrendingUp,
} from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';

// Ваучеры и Статистика — живые страницы кабинета, но в меню их не было:
// добраться можно было только прямой ссылкой (осиротевшие разделы).
//
// Пункты сгруппированы по section: на мобиле HubSidebar тогда рендерит
// сворачиваемую сетку иконок по разделам (как в админке) вместо горизонтальной
// ленты, в которую 10 пунктов не влезали — за экраном терялись Сделки,
// Комиссии и всё дальше. Обзор — сверху без раздела.
const SIDEBAR_ITEMS = [
  { href: '/hub/agent',             label: 'Обзор',      icon: LayoutDashboard },

  { href: '/hub/agent/leads',       label: 'Заявки',     icon: Inbox,      section: 'Продажи' },
  { href: '/hub/agent/find',        label: 'Найти тур',  icon: Search,     section: 'Продажи' },
  { href: '/hub/agent/clients',     label: 'Клиенты',    icon: Users,      section: 'Продажи' },
  { href: '/hub/agent/bookings',    label: 'Сделки',     icon: Handshake,  section: 'Продажи' },

  { href: '/hub/agent/commissions', label: 'Комиссии',   icon: CreditCard, section: 'Финансы' },
  { href: '/hub/agent/vouchers',    label: 'Ваучеры',    icon: Ticket,     section: 'Финансы' },
  { href: '/hub/agent/referral',    label: 'Рефералы',   icon: Link2,      section: 'Финансы' },

  { href: '/hub/agent/stats',       label: 'Статистика', icon: TrendingUp, section: 'Кабинет' },
  { href: '/hub/agent/profile',     label: 'Профиль',    icon: User,       section: 'Кабинет' },
];

export default function AgentHubLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={SIDEBAR_ITEMS} sidebarTitle="Кабинет агента" requiredRole="agent">
      {children}
    </HubLayout>
  );
}

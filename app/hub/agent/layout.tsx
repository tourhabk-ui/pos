'use client';

import { ReactNode } from 'react';
import {
  LayoutDashboard, Search, Users, Handshake, CreditCard, User, Link2,
  TrendingUp,
} from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';

// Статистика — живая страница кабинета, но в меню её не было:
// добраться можно было только прямой ссылкой. Ваучеры удалены 26.09:
// таблицы vouchers в базе нет, страница отвечала 500, а код ваучера нигде
// не применялся к брони.
//
// Пункты сгруппированы по section: на мобиле HubSidebar тогда рендерит
// сворачиваемую сетку иконок по разделам (как в админке) вместо горизонтальной
// ленты, в которую 10 пунктов не влезали — за экраном терялись Сделки,
// Комиссии и всё дальше. Обзор — сверху без раздела.
const SIDEBAR_ITEMS = [
  { href: '/hub/agent',             label: 'Обзор',      icon: LayoutDashboard },

  { href: '/hub/agent/find',        label: 'Найти тур',  icon: Search,     section: 'Продажи' },
  { href: '/hub/agent/clients',     label: 'Клиенты',    icon: Users,      section: 'Продажи' },
  { href: '/hub/agent/bookings',    label: 'Сделки',     icon: Handshake,  section: 'Продажи' },

  { href: '/hub/agent/commissions', label: 'Комиссии',   icon: CreditCard, section: 'Финансы' },
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

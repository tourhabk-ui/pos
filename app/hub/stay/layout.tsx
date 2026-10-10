'use client';

import { ReactNode } from 'react';
import { LayoutDashboard, Home, ClipboardList, CalendarDays, BookUser, ListChecks, BellDot, Star } from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';
import { PartnerChannelBanner } from '@/components/hub/PartnerChannelBanner';

// section → на мобиле сетка иконок по разделам вместо ленты (см. HubSidebar).
const SIDEBAR_ITEMS = [
  { href: '/hub/stay',                label: 'Обзор',     icon: LayoutDashboard },
  { href: '/hub/stay/accommodations', label: 'Объекты',   icon: Home,          section: 'Управление' },
  { href: '/hub/stay/calendar',       label: 'Календарь', icon: CalendarDays,  section: 'Управление' },
  { href: '/hub/stay/bookings',       label: 'Брони',     icon: ClipboardList, section: 'Управление' },
  { href: '/hub/stay/inbox',          label: 'Входящие',  icon: BellDot,       section: 'Управление' },
  { href: '/hub/stay/clients',        label: 'Клиенты',   icon: BookUser,      section: 'Управление' },
  { href: '/hub/stay/tasks',          label: 'Задачи',    icon: ListChecks,    section: 'Управление' },
  { href: '/hub/stay/reviews',        label: 'Отзывы',    icon: Star,          section: 'Управление' },
];

export default function StayHubLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={SIDEBAR_ITEMS} sidebarTitle="Владелец жилья" requiredRole={['stay', 'admin']}>
      <PartnerChannelBanner />
      {children}
    </HubLayout>
  );
}

'use client';

import { ReactNode } from 'react';
import { LayoutDashboard, Home, ClipboardList, CalendarDays } from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';

// section → на мобиле сетка иконок по разделам вместо ленты (см. HubSidebar).
const SIDEBAR_ITEMS = [
  { href: '/hub/stay',                label: 'Обзор',     icon: LayoutDashboard },
  { href: '/hub/stay/accommodations', label: 'Объекты',   icon: Home,          section: 'Управление' },
  { href: '/hub/stay/calendar',       label: 'Календарь', icon: CalendarDays,  section: 'Управление' },
  { href: '/hub/stay/bookings',       label: 'Брони',     icon: ClipboardList, section: 'Управление' },
];

export default function StayHubLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={SIDEBAR_ITEMS} sidebarTitle="Владелец жилья" requiredRole={['stay', 'admin']}>
      {children}
    </HubLayout>
  );
}

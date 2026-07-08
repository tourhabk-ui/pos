'use client';

import { ReactNode } from 'react';
import { LayoutDashboard, Home, ClipboardList, CalendarDays } from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';

const SIDEBAR_ITEMS = [
  { href: '/hub/stay',                label: 'Обзор',     icon: LayoutDashboard },
  { href: '/hub/stay/accommodations', label: 'Объекты',   icon: Home },
  { href: '/hub/stay/calendar',       label: 'Календарь', icon: CalendarDays },
  { href: '/hub/stay/bookings',       label: 'Брони',     icon: ClipboardList },
];

export default function StayHubLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={SIDEBAR_ITEMS} sidebarTitle="Владелец жилья" requiredRole={['stay', 'admin']}>
      {children}
    </HubLayout>
  );
}

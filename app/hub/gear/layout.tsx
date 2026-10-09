'use client';

import { ReactNode } from 'react';
import { LayoutDashboard, Backpack, ClipboardList, BookUser } from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';

// section → на мобиле сетка иконок по разделам вместо ленты (см. HubSidebar).
const SIDEBAR_ITEMS = [
  { href: '/hub/gear',           label: 'Обзор',     icon: LayoutDashboard },
  { href: '/hub/gear/inventory', label: 'Инвентарь', icon: Backpack,      section: 'Управление' },
  { href: '/hub/gear/rentals',   label: 'Аренды',    icon: ClipboardList, section: 'Управление' },
  { href: '/hub/gear/clients',   label: 'Клиенты',   icon: BookUser,      section: 'Управление' },
];

export default function GearHubLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={SIDEBAR_ITEMS} sidebarTitle="Прокат снаряжения" requiredRole={['gear', 'admin']}>
      {children}
    </HubLayout>
  );
}

'use client';

import { ReactNode } from 'react';
import { CalendarDays, Users, CreditCard, Star, MessageSquare, User, Map } from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';
import { ChatWidget } from '@/components/chat/ChatWidget';

// section → на мобиле сетка иконок по разделам вместо ленты (см. HubSidebar).
const SIDEBAR_ITEMS = [
  { href: '/hub/guide',          label: 'Обзор',      icon: Star          },

  { href: '/hub/guide/tours',    label: 'Мои туры',   icon: Map,           section: 'Работа' },
  { href: '/hub/guide/schedule', label: 'Расписание', icon: CalendarDays,  section: 'Работа' },
  { href: '/hub/guide/groups',   label: 'Группы',     icon: Users,         section: 'Работа' },

  { href: '/hub/guide/earnings', label: 'Заработок',  icon: CreditCard,    section: 'Финансы' },

  { href: '/hub/guide/reviews',  label: 'Отзывы',     icon: MessageSquare, section: 'Кабинет' },
  { href: '/hub/guide/profile',  label: 'Профиль',    icon: User,          section: 'Кабинет' },
];

export default function GuideHubLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={SIDEBAR_ITEMS} sidebarTitle="Кабинет гида" requiredRole="guide">
      {children}
      <ChatWidget />
    </HubLayout>
  );
}

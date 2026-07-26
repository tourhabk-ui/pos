'use client';

import { ReactNode } from 'react';
import {
  LayoutDashboard, Inbox, Search, Users, Handshake, CreditCard, User, Link2,
  Ticket, TrendingUp,
} from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';

// Ваучеры и Статистика — живые страницы кабинета, но в меню их не было:
// добраться можно было только прямой ссылкой (осиротевшие разделы).
const SIDEBAR_ITEMS = [
  { href: '/hub/agent',             label: 'Обзор',      icon: LayoutDashboard },
  { href: '/hub/agent/leads',       label: 'Заявки',     icon: Inbox           },
  { href: '/hub/agent/find',        label: 'Найти тур',  icon: Search          },
  { href: '/hub/agent/clients',     label: 'Клиенты',    icon: Users           },
  { href: '/hub/agent/bookings',    label: 'Сделки',     icon: Handshake       },
  { href: '/hub/agent/commissions', label: 'Комиссии',   icon: CreditCard      },
  { href: '/hub/agent/vouchers',    label: 'Ваучеры',    icon: Ticket          },
  { href: '/hub/agent/referral',    label: 'Рефералы',   icon: Link2           },
  { href: '/hub/agent/stats',       label: 'Статистика', icon: TrendingUp      },
  { href: '/hub/agent/profile',     label: 'Профиль',    icon: User            },
];

export default function AgentHubLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={SIDEBAR_ITEMS} sidebarTitle="Кабинет агента" requiredRole="agent">
      {children}
    </HubLayout>
  );
}

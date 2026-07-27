'use client';

import { ReactNode } from 'react';
import {
  BarChart3, Map, Calendar, CalendarDays, Users, CreditCard,
  Settings, Bell, FileText, ArrowLeftRight, HelpCircle, CheckCircle, Inbox, User,
  Download, Bus, BookMarked,
} from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';
import { ChatWidget } from '@/components/chat/ChatWidget';
import { OperatorTelegramBanner } from '@/components/operator/TelegramConnectBanner';
import { ForcePasswordChangeBanner } from '@/components/operator/ForcePasswordChangeBanner';

// Пункты сгруппированы по section: на мобиле HubSidebar тогда рендерит
// сворачиваемую сетку иконок по разделам вместо горизонтальной ленты, в
// которую 17 пунктов не влезали — всё после четвёртого жило за правым краем.
const SIDEBAR_ITEMS = [
  { href: '/hub/operator', label: 'Обзор', icon: BarChart3 },

  { href: '/hub/operator/tours', label: 'Туры', icon: Map, section: 'Продажи' },
  { href: '/hub/operator/completeness', label: 'Полнота туров', icon: CheckCircle, section: 'Продажи' },
  { href: '/hub/operator/bookings', label: 'Бронирования', icon: Calendar, section: 'Продажи' },
  { href: '/hub/operator/leads', label: 'AI Заявки', icon: Inbox, section: 'Продажи' },
  { href: '/hub/operator/selections', label: 'Подборки', icon: BookMarked, section: 'Продажи' },
  { href: '/hub/operator/clients', label: 'Клиенты', icon: Users, section: 'Продажи' },
  { href: '/hub/operator/calendar', label: 'Календарь', icon: CalendarDays, section: 'Продажи' },

  { href: '/hub/operator/finance', label: 'Финансы', icon: CreditCard, section: 'Финансы' },
  { href: '/hub/operator/analytics', label: 'Аналитика', icon: BarChart3, section: 'Финансы' },
  { href: '/hub/operator/reports', label: 'Отчёты', icon: Download, section: 'Финансы' },

  { href: '/hub/operator/transfers', label: 'Трансферы', icon: ArrowLeftRight, section: 'Логистика' },
  { href: '/hub/transfer-operator', label: 'Автопарк', icon: Bus, section: 'Логистика' },

  { href: '/hub/operator/notifications', label: 'Уведомления', icon: Bell, section: 'Кабинет' },
  { href: '/hub/operator/integrations', label: 'Интеграции', icon: Settings, section: 'Кабинет' },
  { href: '/hub/operator/help', label: 'Справка', icon: HelpCircle, section: 'Кабинет' },
  { href: '/hub/operator/profile', label: 'Профиль', icon: User, section: 'Кабинет' },
];

export default function OperatorHubLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={SIDEBAR_ITEMS} sidebarTitle="Кабинет оператора" requiredRole={['operator', 'admin']}>
      <ForcePasswordChangeBanner />
      <OperatorTelegramBanner />
      {children}
      <ChatWidget />
    </HubLayout>
  );
}

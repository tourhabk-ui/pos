'use client';

import { ReactNode } from 'react';
import {
  Compass, Calendar, Star, Heart, Award, MessageSquare, User, Bell, Route,
  ShoppingCart, LifeBuoy, Mail, Mountain, BedDouble, ShieldCheck,
} from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';
import { ChatWidget } from '@/components/chat/ChatWidget';

// Пункты сгруппированы по section: на мобиле HubSidebar тогда рендерит
// сворачиваемую сетку иконок по разделам вместо горизонтальной ленты, в
// которую 15 пунктов не влезали. Контрольный срок — отдельным разделом
// «Безопасность»: safety-функция не должна тонуть среди покупок (vedar-design §7).
const SIDEBAR_ITEMS = [
  { href: '/hub/tourist',                  label: 'Обзор',             icon: Compass },

  { href: '/hub/tourist/my-kamchatka',     label: 'Моя Камчатка',      icon: Mountain,      section: 'Путешествия' },
  { href: '/hub/tourist/trips',            label: 'Мои маршруты',      icon: Route,         section: 'Путешествия' },
  { href: '/hub/tourist/bookings',         label: 'Бронирования',      icon: Calendar,      section: 'Путешествия' },
  { href: '/hub/tourist/stays',            label: 'Мои проживания',    icon: BedDouble,     section: 'Путешествия' },

  { href: '/hub/tourist/safety',           label: 'Контрольный срок',  icon: ShieldCheck,   section: 'Безопасность' },

  { href: '/marketplace',              label: 'Найти тур',         icon: Star,          section: 'Покупки' },
  { href: '/hub/tourist/cart',         label: 'Корзина',           icon: ShoppingCart,  section: 'Покупки' },
  { href: '/hub/tourist/wishlist',     label: 'Избранное',         icon: Heart,         section: 'Покупки' },

  { href: '/hub/tourist/reviews',      label: 'Мои отзывы',        icon: MessageSquare, section: 'Общение' },
  { href: '/hub/tourist/messages',     label: 'Сообщения',         icon: Mail,          section: 'Общение' },

  // «Эко-баллы» убраны: страница — редирект на /loyalty (два пункта меню
  // вели на один экран). Экран лояльности теперь и есть кошелёк эко.
  { href: '/hub/tourist/loyalty',      label: 'Эко и бонусы',      icon: Award,         section: 'Кабинет' },
  { href: '/hub/tourist/notifications',label: 'Уведомления',       icon: Bell,          section: 'Кабинет' },
  { href: '/hub/tourist/support',      label: 'Поддержка',         icon: LifeBuoy,      section: 'Кабинет' },
  { href: '/hub/tourist/profile',      label: 'Профиль',           icon: User,          section: 'Кабинет' },
];

export default function TouristLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={SIDEBAR_ITEMS} sidebarTitle="Кабинет туриста" requiredRole="tourist">
      {children}
      <ChatWidget />
    </HubLayout>
  );
}

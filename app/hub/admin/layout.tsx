'use client';

import { ReactNode } from 'react';
import {
  Shield, Users, Calendar, CalendarDays, FileText, MessageSquareText,
  Briefcase, UserCheck, BarChart3, DollarSign, Footprints,
  Activity, Bell, Settings, Brain, Tag, Award, ClipboardList, Plug, TrendingUp, Zap, Send,
  Building2, HardHat, AlertTriangle, Share2, Sparkles, Mail, Radar, Database, Image as ImageIcon, Globe, MapPin, Cpu,
  Route, LineChart, Video, Sprout, MessageCircle, ShieldCheck, LifeBuoy,
} from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';
import { AiAssistant } from '@/components/admin/AiAssistant';
import { ChatWidget } from '@/components/chat/ChatWidget';

// Меню разбито на разделы (section). HubSidebar группирует пункты под
// заголовками разделов на десктопе и метками-разделителями на мобиле.
const SIDEBAR_ITEMS = [
  // Обзор — без раздела, сверху
  { href: '/hub/admin', label: 'Обзор', icon: Shield },

  // Продажи
  { href: '/hub/admin/leads', label: 'CRM — Лиды', icon: ClipboardList, section: 'Продажи' },
  { href: '/hub/admin/bookings', label: 'Бронирования', icon: Calendar, section: 'Продажи' },
  { href: '/hub/admin/operators', label: 'Операторы', icon: UserCheck, section: 'Продажи' },
  { href: '/hub/admin/outreach', label: 'Аутрич', icon: Send, section: 'Продажи' },
  { href: '/hub/admin/promo-codes', label: 'Промокоды', icon: Tag, section: 'Продажи' },
  { href: '/hub/admin/pricing', label: 'Динамические цены', icon: TrendingUp, section: 'Продажи' },
  { href: '/hub/admin/finance', label: 'Финансы', icon: DollarSign, section: 'Продажи' },
  { href: '/hub/admin/calendar', label: 'Календарь', icon: CalendarDays, section: 'Продажи' },

  // Контент
  { href: '/hub/admin/content/tours', label: 'Модерация туров', icon: FileText, section: 'Контент' },
  { href: '/hub/admin/content/routes', label: 'Модерация маршрутов', icon: Route, section: 'Контент' },
  { href: '/hub/admin/content/reviews', label: 'Отзывы', icon: MessageSquareText, section: 'Контент' },
  { href: '/hub/admin/moderation', label: 'Модерация отзывов', icon: ShieldCheck, section: 'Контент' },
  { href: '/hub/admin/content/partners', label: 'Партнёры', icon: Briefcase, section: 'Контент' },
  { href: '/hub/admin/guide-certifications', label: 'Сертификаты гидов', icon: Award, section: 'Контент' },
  { href: '/hub/admin/content/places-import', label: 'Импорт мест', icon: MapPin, section: 'Контент' },
  { href: '/hub/admin/enrich-places', label: 'Обогащение мест', icon: Sprout, section: 'Контент' },
  { href: '/hub/admin/places-photos', label: 'Фото мест', icon: ImageIcon, section: 'Контент' },
  { href: '/hub/admin/user-photos', label: 'Фото туристов', icon: ImageIcon, section: 'Контент' },
  { href: '/hub/admin/photos', label: 'Загрузка фото', icon: ImageIcon, section: 'Контент' },
  { href: '/hub/admin/videos', label: 'Видео', icon: Video, section: 'Контент' },

  // Аналитика
  { href: '/hub/admin/analytics', label: 'Аналитика', icon: BarChart3, section: 'Аналитика' },
  { href: '/hub/admin/traffic', label: 'Посещаемость', icon: Footprints, section: 'Аналитика' },
  { href: '/hub/admin/routes-analysis', label: 'Анализ маршрутов', icon: LineChart, section: 'Аналитика' },
  { href: '/hub/admin/ai-analytics', label: 'AI Кузьмич', icon: Sparkles, section: 'Аналитика' },
  { href: '/hub/admin/activity', label: 'Активность', icon: Activity, section: 'Аналитика' },
  { href: '/hub/admin/health', label: 'Health-метрики', icon: Activity, section: 'Аналитика' },

  // AI
  { href: '/hub/admin/agents', label: 'AI и автоматизации', icon: Zap, section: 'AI' },
  { href: '/hub/admin/evo/models', label: 'Модели эволюции', icon: Cpu, section: 'AI' },
  { href: '/hub/admin/brain', label: 'Volcano Brain', icon: Brain, section: 'AI' },
  { href: '/hub/admin/taaft', label: 'AI-инструменты', icon: Globe, section: 'AI' },
  { href: '/hub/admin/knowledge', label: 'База знаний AI', icon: Brain, section: 'AI' },
  { href: '/hub/admin/intelligence', label: 'Разведка', icon: Radar, section: 'AI' },
  { href: '/hub/admin/ai-prompts', label: 'Оптим. промптов', icon: Sparkles, section: 'AI' },

  // Каналы
  { href: '/hub/admin/channels', label: 'Каналы продаж', icon: Share2, section: 'Каналы' },
  { href: '/hub/admin/telegram', label: 'Telegram-бот', icon: MessageCircle, section: 'Каналы' },
  { href: '/hub/admin/email', label: 'Email', icon: Mail, section: 'Каналы' },
  { href: '/hub/admin/notifications', label: 'Уведомления', icon: Bell, section: 'Каналы' },
  { href: '/hub/admin/integrations', label: 'Интеграции / OCTO', icon: Plug, section: 'Каналы' },

  // Безопасность
  { href: '/hub/admin/safety', label: 'Безопасность', icon: AlertTriangle, section: 'Безопасность' },
  { href: '/hub/admin/artem', label: 'Рабочее место МЧС', icon: HardHat, section: 'Безопасность' },

  // Система
  { href: '/hub/admin/users', label: 'Пользователи', icon: Users, section: 'Система' },
  { href: '/hub/admin/support', label: 'Поддержка', icon: LifeBuoy, section: 'Система' },
  { href: '/hub/admin/migrations', label: 'Миграции БД', icon: Database, section: 'Система' },
  { href: '/hub/admin/settings', label: 'Настройки', icon: Settings, section: 'Система' },
];

export default function AdminHubLayout({ children }: { children: ReactNode }) {
  return (
    <HubLayout sidebarItems={SIDEBAR_ITEMS} sidebarTitle="Администрирование" requiredRole="admin">
      {children}
      <AiAssistant />
      <ChatWidget />
    </HubLayout>
  );
}

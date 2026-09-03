'use client';

import { ReactNode } from 'react';
import {
  Shield, Users, Calendar, CalendarDays, FileText, MessageSquareText,
  Briefcase, UserCheck, BarChart3, DollarSign, Footprints, Coins,
  Activity, Bell, Settings, Brain, Tag, Award, ClipboardList, Plug, TrendingUp, Send,
  Building2, HardHat, AlertTriangle, Share2, Sparkles, Mail, Database, Image as ImageIcon, Globe, MapPin, Cpu,
  Route, LineChart, Video, Sprout, MessageCircle, ShieldCheck, LifeBuoy,
  Trash2, Webhook, Eye, Gauge,
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
  { href: '/hub/admin/places-photos', label: 'Редактор мест', icon: ImageIcon, section: 'Контент' },
  // Экран существовал без единой ссылки — найти его можно было, только помня
  // URL наизусть (перепись достижимости 22.08). То же ниже: Transparency Hub
  // и Webhook Telegram.
  { href: '/hub/admin/places', label: 'Чистка мест', icon: Trash2, section: 'Контент' },
  { href: '/hub/admin/user-photos', label: 'Фото туристов', icon: ImageIcon, section: 'Контент' },
  { href: '/hub/admin/photos', label: 'Загрузка фото', icon: ImageIcon, section: 'Контент' },
  { href: '/hub/admin/videos', label: 'Видео', icon: Video, section: 'Контент' },

  // Аналитика
  { href: '/hub/admin/analytics', label: 'Аналитика', icon: BarChart3, section: 'Аналитика' },
  { href: '/hub/admin/traffic', label: 'Посещаемость', icon: Footprints, section: 'Аналитика' },
  { href: '/hub/admin/routes-analysis', label: 'Анализ маршрутов', icon: LineChart, section: 'Аналитика' },
  // «AI Кузьмич» (/hub/admin/ai-analytics) снят 03.09: та же таблица
  // ai_actions_log, что у «Расходов AI», — теперь вкладка там. Старый адрес
  // редиректится (next.config.js), а не отдаёт 404.
  { href: '/hub/admin/activity', label: 'Активность', icon: Activity, section: 'Аналитика' },
  { href: '/hub/admin/health', label: 'Health-метрики', icon: Activity, section: 'Аналитика' },
  { href: '/hub/admin/operator-sites', label: 'Сайты операторов', icon: ShieldCheck, section: 'Аналитика' },

  // AI
  // Кокпит ядра (P3): задачи/события kernel и «Ждут моего решения». Только
  // просмотр — решения по agent-PR принимаются в GitHub, не здесь.
  // 03.09: «AI и автоматизации» (/hub/admin/agents, живость cron-агентов)
  // стала вкладкой кокпита — обе плитки отвечали на один вопрос «жив ли
  // агент». Старый адрес — редирект в next.config.
  { href: '/hub/admin/volcano', label: 'Работа Volcano OS', icon: Gauge, section: 'AI' },
  { href: '/hub/admin/ai-usage', label: 'Расходы AI', icon: Coins, section: 'AI' },
  { href: '/hub/admin/evo/models', label: 'Модели эволюции', icon: Cpu, section: 'AI' },
  // 03.09: «Разведка» (/hub/admin/intelligence) стала вкладкой Brain — обе
  // страницы читали одну agent_memory. Старый адрес — редирект в next.config.
  { href: '/hub/admin/brain', label: 'Память и разведка', icon: Brain, section: 'AI' },
  { href: '/hub/admin/taaft', label: 'AI-инструменты', icon: Globe, section: 'AI' },
  { href: '/hub/admin/knowledge', label: 'База знаний AI', icon: Brain, section: 'AI' },
  // Отчёт по AI-инициативам. Живёт вне /hub/admin, свою проверку роли делает
  // сам; в меню его не было ни разу.
  { href: '/transparency', label: 'Transparency Hub', icon: Eye, section: 'AI' },
  { href: '/hub/admin/ai-prompts', label: 'Оптим. промптов', icon: Sparkles, section: 'AI' },

  // Каналы
  { href: '/hub/admin/channels', label: 'Каналы продаж', icon: Share2, section: 'Каналы' },
  { href: '/hub/admin/telegram', label: 'Telegram-бот', icon: MessageCircle, section: 'Каналы' },
  // Регистрирует вебхук бота самим фактом открытия — потому и нужен в меню.
  { href: '/hub/admin/telegram/webhook', label: 'Webhook Telegram', icon: Webhook, section: 'Каналы' },
  { href: '/hub/admin/email', label: 'Email', icon: Mail, section: 'Каналы' },
  { href: '/hub/admin/notifications', label: 'Уведомления', icon: Bell, section: 'Каналы' },
  { href: '/hub/admin/integrations', label: 'Интеграции / OCTO', icon: Plug, section: 'Каналы' },
  // MCP — четвёртый канал. Журнал вызовов копился с миграции 861, а входа в
  // него не было: владелец 17.08 искал запросы в админке и не нашёл.
  { href: '/hub/admin/mcp', label: 'Запросы через MCP', icon: Plug, section: 'Каналы' },

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

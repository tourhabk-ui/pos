/**
 * Меню кабинета оператора и кому какой пункт (CRM фаза 2г, решение владельца
 * 11.10: менеджеру всё, кроме денег и настроек; цены — правом).
 *
 * Один источник для двух мест: меню (layout фильтрует его по useOperatorSeat)
 * и экран «Команда», где владелец читает, что увидит менеджер. Текст экрана
 * строится из этого же списка, поэтому разойтись с меню он не может.
 *
 * Меню — удобство, а не защита: деньги и настройки закрывает сервер
 * (requireOperatorOwner), это держит сторож operator-team-gates.
 */
import type { LucideIcon } from 'lucide-react';
import {
  BarChart3, Map, Calendar, CalendarDays, Users, CreditCard,
  Settings, Bell, HelpCircle, CheckCircle, Inbox, User,
  Download, BookMarked, MessageSquareText, Contact, Bot, Percent, ListChecks, BellDot, Star, UsersRound, Code2,
} from 'lucide-react';
import { isManagerSeat, type OperatorSeat } from '@/components/operator/use-operator-seat';

/**
 * team — владелец и менеджер;
 * owner — деньги и настройки, только владелец кабинета;
 * can_edit_prices — менеджер с правом цен, которое дал владелец.
 */
export type MenuAccess = 'team' | 'owner' | 'can_edit_prices';

export interface OperatorMenuItem {
  href: string;
  label: string;
  icon: LucideIcon;
  section?: string;
  access: MenuAccess;
}

// Пункты сгруппированы по section: на мобиле HubSidebar тогда рендерит
// сворачиваемую сетку иконок по разделам вместо горизонтальной ленты, в
// которую 17 пунктов не влезали — всё после четвёртого жило за правым краем.
export const OPERATOR_MENU: OperatorMenuItem[] = [
  { href: '/hub/operator', label: 'Обзор', icon: BarChart3, access: 'team' },

  { href: '/hub/operator/tours', label: 'Туры', icon: Map, section: 'Продажи', access: 'team' },
  // «Чего не хватает» — готовность туров к витринам по правилу лент; до 13.10
  // пункт звался «Полнота туров» и вёл с выдуманного процента.
  { href: '/hub/operator/completeness', label: 'Чего не хватает', icon: CheckCircle, section: 'Продажи', access: 'team' },
  { href: '/hub/operator/bookings', label: 'Бронирования', icon: Calendar, section: 'Продажи', access: 'team' },
  // Сирота-аудит 27.07: страница жила без пункта меню — разбор входящего
  // текста заявки через AI, отличен от списка лидов ниже.
  { href: '/hub/operator/booking-intake', label: 'AI Приём', icon: MessageSquareText, section: 'Продажи', access: 'team' },
  { href: '/hub/operator/leads', label: 'AI Заявки', icon: Inbox, section: 'Продажи', access: 'team' },
  { href: '/hub/operator/selections', label: 'Подборки', icon: BookMarked, section: 'Продажи', access: 'team' },
  { href: '/hub/operator/inbox', label: 'Входящие', icon: BellDot, section: 'Продажи', access: 'team' },
  { href: '/hub/operator/clients', label: 'Клиенты', icon: Users, section: 'Продажи', access: 'team' },
  { href: '/hub/operator/tasks', label: 'Задачи', icon: ListChecks, section: 'Продажи', access: 'team' },
  { href: '/hub/operator/reviews', label: 'Отзывы', icon: Star, section: 'Продажи', access: 'team' },
  // Виджет на сайте партнёра (аудит 15.10, WID-screens): коды вставки, домены
  // и отчёт за 30 дней. Только чтение, денег нет — команде.
  { href: '/hub/operator/widget', label: 'Виджет на сайт', icon: Code2, section: 'Продажи', access: 'team' },
  // Календарь — команде с 2г-2б: выручку менеджеру сервер не отдаёт, цену на
  // даты ставит право цен.
  { href: '/hub/operator/calendar', label: 'Календарь', icon: CalendarDays, section: 'Продажи', access: 'team' },
  // Скидки оператора на свои туры (27.09). До этого правила цены заводил
  // только администратор, и скидку на последние места назначить было нельзя
  // тому, кто продаёт.
  { href: '/hub/operator/pricing', label: 'Скидки', icon: Percent, section: 'Продажи', access: 'can_edit_prices' },

  { href: '/hub/operator/finance', label: 'Финансы', icon: CreditCard, section: 'Финансы', access: 'owner' },
  { href: '/hub/operator/analytics', label: 'Аналитика', icon: BarChart3, section: 'Финансы', access: 'owner' },
  { href: '/hub/operator/reports', label: 'Отчёты', icon: Download, section: 'Финансы', access: 'owner' },

  // Пункты «Трансферы» и «Автопарк» убраны 01.09 вместе с мёртвым модулем:
  // обе страницы читали таблицы, которых на проде нет, и падали с 42P01.
  // Вернутся, когда будет построен кабинет перевозчика на схеме 926.
  // Сирота-аудит 27.07: живой CRUD гидов (GET+POST) без пункта меню.
  { href: '/hub/operator/guides', label: 'Гиды', icon: Contact, section: 'Логистика', access: 'team' },

  // Сирота-аудит 27.07: AI-помощник оператора жил без пункта меню.
  { href: '/hub/operator/ai-assist', label: 'AI Помощник', icon: Bot, section: 'Кабинет', access: 'team' },
  { href: '/hub/operator/notifications', label: 'Уведомления', icon: Bell, section: 'Кабинет', access: 'team' },
  { href: '/hub/operator/integrations', label: 'Интеграции', icon: Settings, section: 'Кабинет', access: 'owner' },
  { href: '/hub/operator/team', label: 'Команда', icon: UsersRound, section: 'Кабинет', access: 'owner' },
  { href: '/hub/operator/help', label: 'Справка', icon: HelpCircle, section: 'Кабинет', access: 'team' },
  { href: '/hub/operator/profile', label: 'Профиль', icon: User, section: 'Кабинет', access: 'owner' },
];

/** Пункт виден менеджеру с такими правами. */
export function managerSees(item: OperatorMenuItem, perms: { can_edit_prices: boolean }): boolean {
  return item.access === 'team' || (item.access === 'can_edit_prices' && perms.can_edit_prices);
}

/**
 * Меню для вошедшего. Менеджеру — без денег и настроек, скидки — с правом
 * цен. Владелец, загрузка и «не узнали» — полное меню, как до команды:
 * прятать разделы владельцу из-за сбоя сети нельзя, а менеджеру сервер
 * откажет и сам.
 */
export function menuForSeat(items: OperatorMenuItem[], seat: OperatorSeat): OperatorMenuItem[] {
  if (!isManagerSeat(seat)) return items;
  return items.filter(i => managerSees(i, seat.perms));
}

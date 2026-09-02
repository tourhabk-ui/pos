/**
 * Реестр ссылок платформы — ОДИН источник для футера и страницы «Ещё».
 *
 * Повод (владелец, 02.09): футер оказался единственным местом, откуда на
 * телефоне можно попасть в половину платформы, и находили его случайно —
 * он вмонтирован на четырнадцати страницах из сорока, а таб-бар несёт пять
 * пунктов. «Связь на маршруте», «Инциденты», планировщик, помощь — всё это
 * существовало, но для человека с телефоном не было дороги.
 *
 * Два потребителя — футер и /menu — читают этот список, а не держат свои.
 * Две копии одного меню расходятся так же, как расходились две SOS-кнопки
 * (#887): пункт добавляют в одну, забывают в другой, и «есть ли ссылка»
 * зависит от того, с какого экрана смотреть. Сторож mobile-two-taps держит,
 * что каждая публичная страница из sitemap достижима с телефона за два
 * касания: таб-бар, шапка или этот реестр.
 *
 * Подписи — по заголовкам самих страниц, не по желаемому: «Планирование
 * поездки» ведёт на /partners, потому что так называется та страница
 * (авиабилеты, отели, трансферы), а конструктор маршрута — /planner.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Shield, Radio, Siren, WifiOff, ClipboardCheck, Leaf,
  Ticket, CalendarDays, Flame, Layers, ListChecks, Route, BedDouble, Plane, Fish, Award, Bus,
  MapPin, Waypoints, Map, Newspaper, BookOpen, Info, CircleHelp, LifeBuoy, Briefcase,
  Handshake, UserPlus, Bot, MessageSquare, Sparkles,
  FileText, ScrollText, Receipt, Percent, FileSignature,
} from 'lucide-react';

export interface PlatformLink {
  label: string;
  href: string;
  icon: LucideIcon;
}

export interface PlatformSection {
  id: 'field' | 'trip' | 'platform' | 'legal';
  title: string;
  links: PlatformLink[];
}

export const PLATFORM_SECTIONS: PlatformSection[] = [
  {
    id: 'field',
    title: 'На маршруте и безопасность',
    links: [
      { label: 'Безопасность',        href: '/safety',               icon: Shield },
      { label: 'Связь на маршруте',   href: '/safety/communication', icon: Radio },
      { label: 'Инциденты и алерты',  href: '/safety/incidents',     icon: Siren },
      { label: 'Офлайн-инструкции',   href: '/safety/offline',       icon: WifiOff },
      { label: 'Регистрация в МЧС',   href: '/register',             icon: ClipboardCheck },
      { label: 'Экотуризм',           href: '/eco',                  icon: Leaf },
    ],
  },
  {
    id: 'trip',
    title: 'Поездка',
    links: [
      { label: 'Туры',                    href: '/catalog',        icon: Ticket },
      { label: 'Календарь туров',         href: '/calendar',       icon: CalendarDays },
      { label: 'Популярное',              href: '/trending',       icon: Flame },
      { label: 'Подборки маршрутов',      href: '/collections',    icon: Layers },
      { label: 'Готовые планы поездок',   href: '/plans',          icon: ListChecks },
      { label: 'Конструктор маршрута',    href: '/planner',        icon: Route },
      { label: 'Жильё',                   href: '/accommodations', icon: BedDouble },
      { label: 'Места в поездках перевозчиков', href: '/transfers', icon: Bus },
      { label: 'Планирование поездки',    href: '/partners',       icon: Plane },
      { label: 'Камчатская рыбалка',      href: '/hub/fishing',    icon: Fish },
      { label: 'Сертифицированные гиды',  href: '/guides',         icon: Award },
    ],
  },
  {
    id: 'platform',
    title: 'Платформа',
    links: [
      { label: 'Места',               href: '/places',         icon: MapPin },
      { label: 'Маршруты',            href: '/routes',         icon: Waypoints },
      { label: 'Карта Камчатки',      href: '/map',            icon: Map },
      { label: 'Статьи о Камчатке',   href: '/articles',       icon: Newspaper },
      { label: 'Блог',                href: '/blog',           icon: BookOpen },
      { label: 'AI-арсенал',          href: '/ai-tools',       icon: Sparkles },
      { label: 'О платформе',         href: '/about',          icon: Info },
      { label: 'Вопросы и ответы',    href: '/faq',            icon: CircleHelp },
      { label: 'Центр помощи',        href: '/help',           icon: LifeBuoy },
      { label: 'Помощь туристам',     href: '/help/tourists',  icon: LifeBuoy },
      { label: 'Помощь операторам',   href: '/help/operators', icon: Briefcase },
      { label: 'Партнёры',            href: '/operators',      icon: Handshake },
      { label: 'Стать партнёром',     href: '/for-operators',  icon: UserPlus },
      { label: 'MCP для ИИ-агентов',  href: '/mcp',            icon: Bot },
      { label: 'Оставить заявку',     href: '/contact',        icon: MessageSquare },
    ],
  },
  {
    id: 'legal',
    title: 'Правовые документы',
    links: [
      { label: 'Пользовательское соглашение',  href: '/legal/terms',           icon: FileText },
      { label: 'Политика конфиденциальности',  href: '/legal/privacy',         icon: ScrollText },
      { label: 'Публичная оферта',             href: '/legal/offer',           icon: Receipt },
      { label: 'Условия комиссии',             href: '/legal/commission',      icon: Percent },
      { label: 'Агентский договор',            href: '/legal/agent-agreement', icon: FileSignature },
    ],
  },
];

/** Все ссылки, кроме документов, — колонка «Платформа» в футере. */
export const PLATFORM_LINKS: PlatformLink[] = PLATFORM_SECTIONS
  .filter(s => s.id !== 'legal')
  .flatMap(s => s.links);

/** Документы — своя колонка в футере. */
export const LEGAL_LINKS: PlatformLink[] = PLATFORM_SECTIONS.find(s => s.id === 'legal')!.links;

/** Все пути реестра — для сторожа достижимости. */
export function allPlatformHrefs(): string[] {
  return PLATFORM_SECTIONS.flatMap(s => s.links.map(l => l.href));
}

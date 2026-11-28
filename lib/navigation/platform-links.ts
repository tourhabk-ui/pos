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
 * Подписи — по заголовкам самих страниц (lib/navigation/tool-names, 22.11):
 * /planner — «План с Кузьмичом», /planning — «Подготовка к походу», /plans —
 * «Готовые маршруты», /partners — «Билеты и отели». Слова «планирование» в
 * меню нет: им звались сразу две страницы, и пункт вёл не туда.
 */
import { PLANNER_MENU, PLANNING_MENU, PLANS_MENU, PARTNERS_MENU, PREPARE_MENU } from '@/lib/navigation/tool-names';
import type { LucideIcon } from 'lucide-react';
import {
  Shield, Radio, Siren, WifiOff, Phone, ClipboardCheck, Leaf, Ticket, CalendarDays, Flame, Layers, ListChecks, Route, BedDouble, Plane, Fish, Award, Bus, MapPin, Waypoints, Map, Newspaper, BookOpen, Info, CircleHelp, LifeBuoy, Briefcase, Handshake, UserPlus, Bot, MessageSquare, Smartphone, ShieldAlert, FileText, ScrollText, Receipt, Backpack, CloudSun, Heart, Languages, Car, PlaneTakeoff, Trees,
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
      { label: 'Погода на Камчатке',  href: '/weather',              icon: CloudSun },
      { label: PREPARE_MENU,              href: '/prepare',              icon: Backpack },
      { label: 'Связь на маршруте',   href: '/safety/communication', icon: Radio },
      { label: 'Инциденты и алерты',  href: '/safety/incidents',     icon: Siren },
      { label: 'Офлайн-инструкции',   href: '/safety/offline',       icon: WifiOff },
      // Статический спасшлюз /emergency (без React, офлайн): в реестре, чтобы
      // дорога не была только через «Связь на маршруте» (третье касание).
      // В sitemap не входит — канон у /sos (аудит 24.11).
      { label: 'Экстренные номера',   href: '/emergency',            icon: Phone },
      { label: 'Регистрация в МЧС',   href: '/register',             icon: ClipboardCheck },
      { label: 'Экотуризм',           href: '/eco',                  icon: Leaf },
    ],
  },
  {
    id: 'trip',
    title: 'Поездка',
    links: [
      { label: 'Туры',                    href: '/catalog',        icon: Ticket },
      { label: 'Как забронировать тур',   href: '/bronirovanie-turov-kamchatka', icon: Ticket },
      { label: 'Туры к медведям',         href: '/tury-medvedi-kamchatka', icon: Ticket },
      { label: 'Восхождение на Авачинский', href: '/voshozhdenie-na-avachinskij-vulkan', icon: Ticket },
      { label: 'Экскурсия в Долину гейзеров', href: '/dolina-gejzerov-ekskursiya', icon: Ticket },
      { label: 'Рыболовные туры',         href: '/rybalka-na-kamchatke-tury', icon: Ticket },
      { label: 'Туры на Курильское озеро', href: '/kurilskoe-ozero-tury', icon: Ticket },
      { label: 'Туры к Мутновскому вулкану', href: '/vulkan-mutnovskij-tury', icon: Ticket },
      { label: 'Экскурсии на Халактырский пляж', href: '/halaktyrskij-plyazh-ekskursiya', icon: Ticket },
      { label: 'Туры к Толбачику',         href: '/tolbachik-tur', icon: Ticket },
      { label: 'Вертолётные экскурсии',    href: '/vertoletnye-ekskursii-kamchatka', icon: Ticket },
      { label: 'Снегоходные туры',         href: '/snegohodnye-tury-kamchatka', icon: Ticket },
      { label: 'Трансфер из аэропорта Елизово', href: '/transfer-aeroport-elizovo', icon: Bus },
      { label: 'Kamchatka tours (English)', href: '/en/kamchatka-tours', icon: Languages },
      { label: 'Bear watching (English)', href: '/en/bear-watching', icon: Languages },
      { label: 'Календарь туров',         href: '/calendar',       icon: CalendarDays },
      { label: 'Популярное',              href: '/trending',       icon: Flame },
      { label: 'Подборки маршрутов',      href: '/collections',    icon: Layers },
      { label: PLANS_MENU,                href: '/plans',          icon: ListChecks },
      // Посчитаны из базы (разбор видимости в ответах ИИ, 19.11).
      { label: 'Сколько стоит поездка',   href: '/skolko-stoit-poezdka-na-kamchatku', icon: Ticket },
      { label: 'Когда ехать на Камчатку', href: '/kogda-ehat-na-kamchatku', icon: CalendarDays },
      // Справка о разрешениях на охраняемые территории (#3566 п.5).
      { label: 'Нужно ли разрешение',     href: '/razreshenie-na-poseshchenie', icon: Ticket },
      { label: PLANNER_MENU,              href: '/planner',        icon: Route },
      { label: PLANNING_MENU,             href: '/planning',       icon: Backpack },
      { label: 'Жильё',                   href: '/accommodations', icon: BedDouble },
      { label: 'Избранное',               href: '/wishlist',       icon: Heart },
      // Трансфер — машина целиком под заказ (владелец 13.10), не места в ней.
      { label: 'Трансфер: машина под заказ', href: '/transfers', icon: Bus },
      // Прокат — машина без водителя, цена за сутки (23.10, 1317); водитель у перевозчика выше.
      { label: 'Аренда автомобилей',         href: '/car-rental', icon: Car },
      // Табло Елизово (29.10, #2788) — задержки и отмены по табло аэропорта.
      { label: 'Табло аэропорта Елизово',    href: '/flights',    icon: PlaneTakeoff },
      { label: PARTNERS_MENU,             href: '/partners',       icon: Plane },
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
      { label: 'Сводка для гидов',    href: '/svodka',         icon: ShieldAlert },
      { label: 'Статьи о Камчатке',   href: '/articles',       icon: Newspaper },
      { label: 'Рыбы Камчатки',       href: '/fish',           icon: Fish },
      { label: 'Летопись Камчатки',   href: '/letopis',        icon: ScrollText },
      // Список охраняемых территорий (аудит 20.11: адрес /park был 404).
      { label: 'Парки и заповедники', href: '/park',           icon: Trees },
      { label: 'Блог',                href: '/blog',           icon: BookOpen },
      { label: 'Приложения в дорогу', href: '/prilozheniya',   icon: Smartphone },
      { label: 'О платформе',         href: '/about',          icon: Info },
      // Текст о Кузьмиче уехал с чата на свою страницу (слово владельца 28.11).
      { label: 'Что умеет Кузьмич',   href: '/o-kuzmiche',     icon: Bot },
      { label: 'Вопросы и ответы',    href: '/faq',            icon: CircleHelp },
      { label: 'Центр помощи',        href: '/help',           icon: LifeBuoy },
      { label: 'Помощь туристам',     href: '/help/tourists',  icon: LifeBuoy },
      { label: 'Помощь операторам',   href: '/help/operators', icon: Briefcase },
      { label: 'Помощь гидам',        href: '/help/guides',    icon: LifeBuoy },
      { label: 'Партнёры',            href: '/operators',      icon: Handshake },
      { label: 'Стать партнёром',     href: '/for-operators',  icon: UserPlus },
      { label: 'MCP для ИИ-агентов',  href: '/mcp',            icon: Bot },
      { label: '中文 — Ведар по-китайски', href: '/zh',        icon: Languages },
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
      // Переводы для иностранных туристов и ревьюеров каталогов ИИ (17.11); оригинал — русский.
      { label: 'Terms of Use (English)',       href: '/en/legal/terms',        icon: FileText },
      { label: 'Privacy Policy (English)',     href: '/en/legal/privacy',      icon: ScrollText },
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

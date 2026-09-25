'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PRICE_RANGES } from '@/lib/tours/marketplace-constants';
import {
  MapPin, ChevronRight, Heart, BadgeCheck,
  AlertCircle, Clock, Sparkles, Search, SlidersHorizontal,
  X, ChevronDown, Flame, ThermometerSun, Fish,
  PawPrint, Helicopter, Waves, Snowflake,
  Mountain, ArrowRight, Anchor, Send,
} from 'lucide-react';
import type { CatalogSummary } from '@/lib/search/tour-search';
import {
  catalogAvailability, isInSeason, AVAILABILITY_LABEL, type CatalogAvailability,
} from '@/lib/tours/catalog-availability';

/* ─── Types ─── */

interface Tour {
  id: number;
  title: string;
  description: string;
  short_description: string | null;
  base_price: number;
  price_old: number | null;
  price_unit: string | null;
  activity_type: string;
  location_type: string;
  location_name: string | null;
  tour_image: string | null;
  operator_name: string;
  operator_id: string;
  /** partners.is_verified: «проверен» пишется только при true (§4.0). */
  operator_verified?: boolean | null;
  bookings_count: number;
  duration_hours: number | null;
  duration_type: string | null;
  multi_day_count: number | null;
  difficulty: string | null;
  included: string[] | null;
  season_start: string | null;
  season_end: string | null;
  /**
   * Есть ли открытая дата со свободными местами — сервер считает это в
   * lib/search/tour-search. Необязательное в типе намеренно: не пришло —
   * значит «не знаем», и карточка говорит «Даты по запросу», а не «Есть даты».
   */
  has_availability?: boolean | null;
}

/* ─── Constants ─── */

/**
 * Подписи — из единого словаря (lib/tours/labels). Свои копии здесь и привели
 * к тому, что `boat_trip` в каталоге назывался «Морской тур», в карточке
 * «Морские туры», а кое-где «Сплав» — то есть морская прогулка выдавалась за
 * сплав. Короткие подписи для чипов живут в том же словаре (ACTIVITY_SHORT).
 *
 * Сетка плиток направлений (CATEGORY_DATA) и сводка StatsBar удалены (аудит
 * П5, #47/#54/#60/#130): плитки и чипы были двумя фильтрами одного состояния
 * с разными названиями, шесть из восьми плиток были мёртвыми, а сводка
 * показывала «—» до второго запроса. Остался один фильтр — чипы по
 * направлениям, где туры ЕСТЬ, со счётчиком из серверной сводки.
 */
import { activityLabel, locationLabel, priceUnitLabel } from '@/lib/tours/labels';
import { photoSrc } from '@/lib/images/variant';
import { plural } from '@/lib/home/data-freshness';
import { detectFishSpecies } from '@/lib/fish-species';

const ACTIVITY_IMAGES: Record<string, string> = {
  fishing:    '/images/activities/fishing.jpg',
  trekking:   '/images/activities/volcanoes.jpg',
  thermal:    '/images/activities/hotsprings.jpg',
  helicopter: '/images/activities/helicopter.jpg',
  rafting:    '/images/activities/rafting.jpg',
  boat_trip:  '/images/activities/sea.jpg',
  bears:      '/images/categories/medvedi.jpg',
  snowmobile: '/images/activities/snowmobile.jpg',
};

const SORT_OPTIONS = [
  { value: 'recommended', label: 'Рекомендуемые' },
  { value: 'price_asc',   label: 'Цена: дешевле' },
  { value: 'price_desc',  label: 'Цена: дороже' },
  { value: 'recent',      label: 'Новые' },
];

const DIFFICULTY_OPTIONS = [
  { value: '',       label: 'Любая' },
  { value: 'easy',   label: 'Лёгкая' },
  { value: 'medium', label: 'Средняя' },
  { value: 'hard',   label: 'Сложная' },
];

const DURATION_OPTIONS = [
  { value: '',          label: 'Любая' },
  { value: 'day',       label: '1 день' },
  { value: 'multi_day', label: 'Многодневный' },
];

const DIFFICULTY_BADGE: Record<string, { label: string }> = {
  easy:   { label: 'Лёгкий' },
  medium: { label: 'Средний' },
  hard:   { label: 'Сложный' },
};

/**
 * Прозрачность токена — через color-mix, а не классом `bg-[var(--x)]/N`:
 * Tailwind 3.4 не накладывает /N на var(), такой класс не генерируется вовсе,
 * и у пилюли героя, рамки баннера и подложки ошибки фона не было (аудит П5,
 * #53). Сторож: tests/unit/catalog-storefront.test.ts.
 */
const mix = (token: string, pct: number) => `color-mix(in srgb, var(${token}) ${pct}%, transparent)`;

/** Чипы/варианты фильтра — цель нажатия не меньше 44px (аудит П5, #136). */
const CHIP_BASE = 'min-h-[44px] px-4 rounded-lg text-sm font-medium border transition-all duration-200 inline-flex items-center';
// Текст на акценте — токен --on-accent (globals.css): тёмный в тёмной теме,
// белый в светлой; контраст выше 4.5:1 в обеих.
const CHIP_ON = 'bg-[var(--accent)] border-[var(--accent)] text-[var(--on-accent)]';
const CHIP_OFF = 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--bg-card)]';

/* ─── Helpers ─── */

function formatDuration(tour: Tour): string | null {
  if (tour.duration_type === 'multi_day' && tour.multi_day_count) {
    const d = tour.multi_day_count;
    return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
  }
  if (tour.duration_type === 'half_day') return 'Полдня';
  if (tour.duration_type === 'day') return '1 день';
  if (tour.duration_hours) {
    const h = Number(tour.duration_hours);
    if (h < 24) return `${h} ч`;
    const d = Math.round(h / 24);
    return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
  }
  return null;
}

const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;

/* ─── Skeleton ─── */

function TourCardSkeleton() {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="ds-skeleton h-56 w-full" />
      <div className="p-5 space-y-3">
        <div className="ds-skeleton h-3 w-1/3 rounded" />
        <div className="ds-skeleton h-5 w-4/5 rounded" />
        <div className="ds-skeleton h-3 w-full rounded" />
        <div className="ds-skeleton h-3 w-3/4 rounded" />
        <div className="ds-skeleton h-4 w-1/4 rounded mt-4" />
      </div>
    </div>
  );
}

/* ─── Hero Section ─── */

/**
 * Герой — на всю ширину БЕЗ отрицательных полей. Прежний `-mx-4 sm:-mx-6
 * lg:-mx-8` был рассчитан на родителя с px-4, а у .ds-page боковых отступов
 * нет: страница выходила шире экрана на 16/32px, fixed-шапка с SOS уезжала
 * вверх, кнопка заявки — за нижний край (аудит П5, #8/#12/#113).
 *
 * Факт в герое — из серверной сводки: «8 туров от 13 000 ₽». Сводки нет —
 * строки нет, а не выдуманное число и не «—» (§4.0).
 */
function HeroSection({ summary }: { summary: CatalogSummary | null }) {
  const fact = summary && summary.total > 0
    ? `${summary.total} ${plural(summary.total, 'тур', 'тура', 'туров')}${summary.minPrice != null ? ` от ${rub(summary.minPrice)}` : ''}`
    : null;
  return (
    <section className="relative overflow-hidden mb-4 sm:mb-8" aria-label="Туры Камчатки">
      <Image
        src="/images/marketplace/hero-marketplace.jpg"
        alt="Камчатка — земля вулканов"
        fill
        priority
        className="object-cover"
        sizes="100vw"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/55 to-black/20" />
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-12 lg:py-14">
        <h1
          className="text-[28px] sm:text-4xl lg:text-5xl font-bold text-white leading-tight"
          style={{ fontFamily: 'var(--font-playfair)' }}
        >
          Туры Камчатки
        </h1>
        {fact && (
          <p className="mt-1 text-base sm:text-lg text-white/90 font-medium tabular-nums">
            {fact}
          </p>
        )}
        <p className="hidden sm:block mt-2 text-base text-white/80 leading-relaxed max-w-lg">
          Готовые туры от операторов: состав, цена и даты — до заявки.
        </p>
        <div className="flex gap-2 sm:gap-3 mt-3 sm:mt-6">
          <a href="#tours" className="ds-btn ds-btn-primary px-4 sm:px-5 whitespace-nowrap">
            Смотреть туры
            <ArrowRight className="w-4 h-4" />
          </a>
          <Link
            href="/planner"
            className="ds-btn px-3 sm:px-4 whitespace-nowrap text-white border border-white/30 bg-black/40 hover:bg-black/60 transition-all duration-200"
          >
            <Sparkles className="w-4 h-4" aria-hidden />
            <span className="sm:hidden">С Кузьмичом</span>
            <span className="hidden sm:inline">Подобрать с Кузьмичом</span>
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ─── Tour Card ─── */

/* Рейл фич каталожной карточки: иконки выводим детерминированно из активности
   и ключевых слов названия/описания тура (медведи/рыбалка/сплав/источники и
   т.д.). Без нового столбца в БД — работает на любом туре, до 4 иконок. */
const ACTIVITY_FEATURE: Record<string, { Icon: React.ElementType; label: string }> = {
  rafting:    { Icon: Waves,        label: 'Сплав' },
  fishing:    { Icon: Fish,         label: 'Рыбалка' },
  bears:      { Icon: PawPrint,     label: 'Медведи' },
  thermal:    { Icon: ThermometerSun, label: 'Источники' },
  trekking:   { Icon: Mountain,     label: 'Треккинг' },
  helicopter: { Icon: Helicopter,   label: 'Вертолёт' },
  boat_trip:  { Icon: Anchor,       label: 'Море' },
  snowmobile: { Icon: Snowflake,    label: 'Снегоходы' },
};
const FEATURE_RULES: { re: RegExp; Icon: React.ElementType; label: string }[] = [
  { re: /медвед/i,                        Icon: PawPrint,      label: 'Медведи' },
  { re: /рыбалк|лосос|голец|удочк|рыбы?\b/i, Icon: Fish,        label: 'Рыбалка' },
  { re: /сплав|рафт/i,                     Icon: Waves,         label: 'Сплав' },
  { re: /источник|термальн|горяч/i,        Icon: ThermometerSun, label: 'Источники' },
  { re: /вулкан/i,                         Icon: Flame,         label: 'Вулканы' },
  { re: /вертол[её]т/i,                    Icon: Helicopter,    label: 'Вертолёт' },
  { re: /море|океан|морск/i,               Icon: Anchor,        label: 'Море' },
  { re: /снегоход/i,                       Icon: Snowflake,     label: 'Снегоходы' },
];
function deriveFeatures(tour: Tour): { Icon: React.ElementType; label: string }[] {
  const text = `${tour.title} ${tour.short_description ?? tour.description ?? ''}`;
  const out: { Icon: React.ElementType; label: string }[] = [];
  const seen = new Set<string>();
  const act = ACTIVITY_FEATURE[tour.activity_type];
  if (act) { out.push(act); seen.add(act.label); }
  // Виды рыб — единым справочником (детект тот же, что у сезонной сетки):
  // «Летняя: чавыча и нерка» без слова «рыбалка» иначе оставалась без иконки.
  if (!seen.has('Рыбалка') && detectFishSpecies(text).length > 0) {
    out.push({ Icon: Fish, label: 'Рыбалка' });
    seen.add('Рыбалка');
  }
  for (const r of FEATURE_RULES) {
    if (out.length >= 4) break;
    if (r.re.test(text) && !seen.has(r.label)) { out.push({ Icon: r.Icon, label: r.label }); seen.add(r.label); }
  }
  return out.slice(0, 4);
}

/** Точка статуса дат: зелёная — есть даты, приглушённая — по запросу. */
const AVAILABILITY_DOT: Record<CatalogAvailability, string> = {
  dates: 'var(--success)',
  on_request: 'var(--warning)',
  season_over: 'var(--text-muted)',
};

/**
 * Карточка: фото на всю карточку, стекло поверх фото (контекст), CTA —
 * непрозрачная (действие). Контракт §2: «стекло — для контекста,
 * непрозрачность — для действия».
 *
 * Нижняя панель — bg-black/60 («плотнее, когда под стеклом сложный фон, а на
 * карточке текст/CTA»). Прежний `bg-black/22` не генерировался Tailwind, и
 * текст держался только на blur (аудит П5, #55/#58). При
 * prefers-reduced-transparency панель становится сплошной var(--bg-card) без
 * blur, а текст внутри — цветом темы: всё, что внутри, красится от
 * currentColor панели, поэтому фолбэк меняет один цвет, а не двадцать.
 *
 * Шрифты — Playfair (заголовок) и Outfit (остальное) по §3 (решение владельца
 * 24.09, развилка 7): Unbounded и JetBrains Mono на карточке были третьим и
 * четвёртым голосом одного продукта (#133).
 *
 * Корзины на карточке нет (решение владельца 24.09, развилка 6): у гостя
 * /cart ведёт на вход, в шапке её нет — зелёная галочка «в корзине» была
 * подтверждением действия, у которого нет продолжения (#50/#57/#59).
 */
function TourCard({
  tour,
  isLiked,
  onToggleLike,
}: {
  tour: Tour;
  isLiked: boolean;
  onToggleLike: (tourId: number) => void;
}) {
  const activity = activityLabel(tour.activity_type, true);
  const location = locationLabel(tour.location_type);
  // 640-вариант: оптимизатор Next выключен, без нарезки карточка каталога
  // грузила оригинал (см. lib/images/variant.ts).
  const imageSrc = photoSrc(tour.tour_image ?? ACTIVITY_IMAGES[tour.activity_type] ?? '/images/activities/volcanoes.jpg', 640);
  const diffBadge = tour.difficulty ? DIFFICULTY_BADGE[tour.difficulty] : null;
  const duration = formatDuration(tour);
  const availability = catalogAvailability(tour);
  // «● Сезон» — только когда есть даты: иначе зелёная точка обещала то,
  // чего нет (тур 7 без дат и тур 5 с сезоном до 15.08 несли её, #51).
  const showSeason = availability === 'dates' && isInSeason(tour);
  const priceOld = tour.price_old ? Number(tour.price_old) : null;
  const basePrice = Number(tour.base_price);
  const features = deriveFeatures(tour);
  const included = (tour.included ?? []).filter(s => typeof s === 'string' && s.trim()).slice(0, 3);
  const href = `/catalog/tours/${tour.id}`;
  const chipStyle: React.CSSProperties = {
    background: 'color-mix(in srgb, currentColor 12%, transparent)',
    borderColor: 'color-mix(in srgb, currentColor 28%, transparent)',
  };

  return (
    <div className="group relative aspect-[5/6] sm:aspect-[17/25] rounded-2xl overflow-hidden bg-[var(--bg-hover)] shadow-sm hover:shadow-xl transition-all duration-300">
      {/* Фото на всю карточку */}
      <Image
        src={imageSrc}
        alt={tour.title}
        fill
        sizes="(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 33vw"
        className="object-cover group-hover:scale-[1.04] transition-transform duration-700 ease-out"
        style={{ filter: 'saturate(1.12) contrast(1.04)' }}
      />
      {/* Затемнение только внизу под текстом — краски фото играют */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-black/10" />

      {/* Навигация по всей карточке (под оверлеями) — сразу на канонический
          адрес: /marketplace/* уходит 308-редиректом и теряет #booking (#129). */}
      <Link href={href} className="absolute inset-0 z-[1]" aria-label={tour.title} />

      {/* Рейл фич — стекло поверх фото */}
      {features.length > 0 && (
        <div
          className="absolute top-3 left-3 z-[2] flex flex-col gap-0.5 p-1.5 rounded-2xl backdrop-blur-md bg-black/40 border border-white/15 pointer-events-none"
          role="list"
          aria-label="Что в туре"
        >
          {features.map((f) => (
            <span key={f.label} role="listitem" title={f.label} aria-label={f.label} className="w-8 h-8 grid place-items-center text-white">
              <f.Icon className="w-[18px] h-[18px]" aria-hidden />
            </span>
          ))}
        </div>
      )}

      {/* Избранное — стекло, цель 44px */}
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleLike(tour.id); }}
        aria-label={isLiked ? 'Убрать из избранного' : 'В избранное'}
        aria-pressed={isLiked}
        className="absolute top-2 right-2 z-[3] w-11 h-11 rounded-full grid place-items-center backdrop-blur-md bg-black/40 border border-white/15 transition-transform duration-200 hover:scale-105"
      >
        <Heart className={`w-5 h-5 ${isLiked ? 'fill-[var(--danger)] text-[var(--danger)]' : 'text-white'}`} />
      </button>

      {/* Нижняя панель: стекло для контекста (текст), кнопка — непрозрачная */}
      <div
        className="absolute left-2.5 right-2.5 bottom-2.5 z-[2] p-3.5 rounded-2xl text-white backdrop-blur-md bg-black/60 border border-white/15 pointer-events-none [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none [@media(prefers-reduced-transparency:reduce)]:bg-[var(--bg-card)] [@media(prefers-reduced-transparency:reduce)]:text-[var(--text-primary)] [@media(prefers-reduced-transparency:reduce)]:border-[var(--border)]"
        style={{ fontFamily: 'var(--font-outfit)' }}
      >
        <div className="flex flex-wrap items-center gap-1.5 mb-1.5 text-[11px] font-semibold">
          <span className="px-2 py-0.5 rounded-full border" style={chipStyle}>{activity}</span>
          {diffBadge && <span className="px-2 py-0.5 rounded-full border" style={chipStyle}>{diffBadge.label}</span>}
          <span className="inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: AVAILABILITY_DOT[availability] }} />
            <span className={availability === 'dates' ? '' : 'font-medium opacity-90'}>{AVAILABILITY_LABEL[availability]}</span>
          </span>
          {showSeason && (
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--success)' }} />
              Сезон
            </span>
          )}
        </div>

        <h3
          className="text-xl font-bold leading-tight line-clamp-2 mb-1"
          style={{ fontFamily: 'var(--font-playfair)', textWrap: 'balance' }}
        >
          {tour.title}
        </h3>

        {(tour.short_description || tour.description) && (
          <p className="text-[13px] leading-snug opacity-90 line-clamp-2 mb-1.5">
            {tour.short_description ?? tour.description}
          </p>
        )}

        {included.length > 0 && (
          <ul className="flex flex-nowrap sm:flex-wrap overflow-hidden gap-1 mb-1.5 text-[11px]" aria-label="Входит в цену">
            {included.map(item => (
              <li key={item} className="shrink-0 max-w-[11rem] truncate px-2 py-0.5 rounded-full border" style={chipStyle} title={item}>
                {item}
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs opacity-90 mb-2">
          <span className="inline-flex items-center gap-1">
            {tour.operator_name}
            {tour.operator_verified === true && (
              <span className="inline-flex items-center gap-0.5 font-semibold">
                <BadgeCheck className="w-3.5 h-3.5" aria-hidden /> проверен
              </span>
            )}
          </span>
          {duration && <span className="inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5" aria-hidden />{duration}</span>}
          {(tour.location_name ?? location) && (
            <span className="hidden sm:inline-flex items-center gap-1 min-w-0"><MapPin className="w-3.5 h-3.5 shrink-0" aria-hidden /><span className="truncate">{tour.location_name ?? location}</span></span>
          )}
        </div>


        {/* Цена строкой выше, кнопка — слева и по своей ширине: правый нижний
            угол карточки свободен, и плавающая «Подобрать тур» (StickyLeadButton,
            right-4) при любой прокрутке ложится на пустое место, а не на бронь. */}
        <div className="flex flex-col items-start gap-1.5 pointer-events-auto">
          <div className="flex flex-col min-w-0">
            {priceOld && priceOld > basePrice && (
              <span className="text-xs opacity-60 line-through tabular-nums">{rub(priceOld)}</span>
            )}
            <span className="whitespace-nowrap leading-tight">
              <span className="text-lg font-bold tabular-nums">{rub(basePrice)}</span>{' '}
              <span className="text-[11px] opacity-75">{priceUnitLabel(tour.price_unit, true)}</span>
            </span>
          </div>
          <Link
            href={`${href}#booking`}
            onClick={(e) => e.stopPropagation()}
            className="ds-btn ds-btn-primary px-4 whitespace-nowrap"
          >
            {availability === 'dates' ? 'Забронировать' : 'Оставить заявку'}
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ─── Planner Banner ─── */

function PlannerBanner() {
  return (
    <Link
      href="/planner"
      className="col-span-full group flex items-center gap-4 p-5 rounded-lg border transition-all duration-200 hover:shadow-md"
      style={{
        borderColor: mix('--accent', 25),
        background: `linear-gradient(90deg, ${mix('--accent', 10)}, ${mix('--accent', 3)})`,
      }}
    >
      <div className="w-11 h-11 rounded-lg flex items-center justify-center shrink-0" style={{ background: mix('--accent', 15) }}>
        <Sparkles className="w-5 h-5 text-[var(--accent)]" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-[var(--text-primary)] mb-0.5">Не знаете, что выбрать?</p>
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed">Кузьмич подберёт тур по вашим датам, бюджету и физической подготовке</p>
      </div>
      <ChevronRight className="w-5 h-5 text-[var(--accent)] shrink-0 group-hover:translate-x-1 transition-transform duration-200" />
    </Link>
  );
}

/* ─── Marketplace Client ─── */

interface MarketplaceClientProps {
  /** Первый рендер с сервера (SEO): данные, снятые RSC-страницей каталога. */
  initialTours?: Tour[];
  initialTotal?: number;
  /** Ключ фильтров серверного рендера — чтобы не дублировать fetch на маунте. */
  initialKey?: string | null;
  /**
   * Сводка витрины (без фильтров), посчитанная на сервере: число туров, цена
   * «от» и счётчики направлений. null — не посчитана (отказ записан в лог
   * страницей): герой без факта, чипов направлений нет.
   */
  summary?: CatalogSummary | null;
}

type Notice = { text: string; href?: string; hrefLabel?: string } | null;

export default function MarketplaceClient({
  initialTours,
  initialTotal = 0,
  initialKey = null,
  summary = null,
}: MarketplaceClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const urlParams = useSearchParams();

  const [tours, setTours] = useState<Tour[]>(initialTours ?? []);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(initialKey === null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<Notice>(null);

  // Search (deep-link параметры должны работать одинаково для SSR и клиента)
  const initialSearch = urlParams.get('search') ?? '';
  const [searchTerm, setSearchTerm] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Filters
  const [activityFilter, setActivityFilter] = useState(urlParams.get('activity_type') ?? '');
  const [sort, setSort] = useState(urlParams.get('sort') ?? 'recommended');
  const [difficulty, setDifficulty] = useState(urlParams.get('difficulty') ?? '');
  const [priceRange, setPriceRange] = useState(() => {
    const p = urlParams.get('price') ?? '';
    return PRICE_RANGES.some(r => r.value === p) ? p : '';
  });
  const [durationType, setDurationType] = useState(urlParams.get('duration_type') ?? '');
  const [showFilters, setShowFilters] = useState(false);

  // Пока не «потрачен» — первый эффект с совпадающим ключом не рефетчит
  // (данные уже отрендерены сервером; иначе мигание и лишний запрос на вход).
  const initialKeyRef = useRef<string | null>(initialKey);

  // Wishlist
  const [likedMap, setLikedMap] = useState<Map<number, string>>(new Map());

  const activeFiltersCount = useMemo(
    () => [difficulty, priceRange, durationType].filter(Boolean).length,
    [difficulty, priceRange, durationType],
  );

  /**
   * Чипы направлений — только те, где туры есть (сводка GROUP BY по живым
   * турам), с числом: «Рыбалка · 7», «Сплав · 1». Направление, пришедшее
   * deep-link'ом без туров, показывается выбранным с нулём — чтобы его было
   * видно и можно было снять, а не чтобы звать в него.
   */
  const chips = useMemo(() => {
    const list = (summary?.byActivity ?? []).map(a => ({ value: a.activity_type, count: a.count }));
    if (activityFilter && !list.some(c => c.value === activityFilter)) list.push({ value: activityFilter, count: 0 });
    return list;
  }, [summary, activityFilter]);

  const getPriceParams = useCallback(() => {
    const range = PRICE_RANGES.find(r => r.value === priceRange);
    return { price_min: range?.min, price_max: range?.max };
  }, [priceRange]);

  // Debounce search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(searchTerm), 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchTerm]);

  // Тост гаснет сам
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // Load wishlist. У гостя 401 — ожидаемый ответ «не вошёл», не поломка.
  useEffect(() => {
    fetch('/api/tourist/wishlist?type=tour')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.data) {
          const map = new Map<number, string>();
          for (const item of data.data as { item_id: string; id: string | number }[]) {
            map.set(parseInt(item.item_id), String(item.id));
          }
          setLikedMap(map);
        }
      })
      .catch(err => console.warn('[catalog] избранное не загружено', err instanceof Error ? err.message : err));
  }, []);

  // Fetch tours
  useEffect(() => {
    if (initialKeyRef.current !== null) {
      // Тот же формат ключа, что собирает RSC-страница.
      const currentKey = JSON.stringify({
        search: debouncedSearch,
        activityFilter,
        sort,
        difficulty,
        priceRange,
        durationType,
      });
      const matched = initialKeyRef.current === currentKey;
      initialKeyRef.current = null;
      if (matched) return;
    }
    const params = new URLSearchParams();
    if (debouncedSearch) params.append('search', debouncedSearch);
    if (activityFilter) params.append('activity_type', activityFilter);
    if (sort && sort !== 'recommended') params.append('sort', sort);
    if (difficulty) params.append('difficulty', difficulty);
    if (durationType) params.append('duration_type', durationType);
    const { price_min, price_max } = getPriceParams();
    if (price_min != null) params.append('price_min', String(price_min));
    if (price_max != null) params.append('price_max', String(price_max));

    setLoading(true);
    setError('');
    fetch(`/api/hub/marketplace/tours?${params}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (data?.tours) setTours(data.tours);
        if (data?.total != null) setTotal(data.total);
      })
      .catch(err => {
        console.error('[catalog] туры не загружены', err instanceof Error ? err.message : err);
        setError('Не удалось загрузить туры. Попробуйте обновить страницу.');
      })
      .finally(() => setLoading(false));
  }, [debouncedSearch, activityFilter, sort, difficulty, priceRange, durationType, getPriceParams]);

  // Sync URL — deep-link на текущие фильтры всегда актуален.
  useEffect(() => {
    const p = new URLSearchParams();
    if (debouncedSearch) p.set('search', debouncedSearch);
    if (activityFilter) p.set('activity_type', activityFilter);
    if (sort !== 'recommended') p.set('sort', sort);
    if (difficulty) p.set('difficulty', difficulty);
    if (priceRange) p.set('price', priceRange);
    if (durationType) p.set('duration_type', durationType);
    router.replace(`${pathname}${p.size ? '?' + p : ''}`, { scroll: false });
  }, [debouncedSearch, activityFilter, sort, difficulty, priceRange, durationType, pathname, router]);

  /**
   * Отказ избранного не глушится (§4.0, аудит П5 #50/#59): раньше сердце у
   * гостя молча откатывалось. 401 — «войдите», и это ожидаемый исход, в лог
   * уходит предупреждением; иной отказ — ошибкой с кодом.
   */
  const reportWishlistFailure = useCallback((status: number | null, op: 'add' | 'remove') => {
    if (status === 401) {
      console.warn(`[catalog] избранное: ${op} → 401, гость`);
      setNotice({ text: 'Войдите, чтобы сохранить тур в избранное', href: `/auth/login?from=${encodeURIComponent(pathname ?? '/catalog')}`, hrefLabel: 'Войти' });
    } else {
      console.error(`[catalog] избранное: ${op} не удалось`, status ?? 'сеть');
      setNotice({ text: 'Не удалось сохранить. Попробуйте ещё раз.' });
    }
  }, [pathname]);

  const handleToggleLike = useCallback(async (tourId: number) => {
    const wishlistRowId = likedMap.get(tourId);
    const isLiked = likedMap.has(tourId);

    if (isLiked && wishlistRowId) {
      setLikedMap(prev => { const next = new Map(prev); next.delete(tourId); return next; });
      let status: number | null = null;
      try {
        const res = await fetch(`/api/tourist/wishlist?id=${wishlistRowId}`, { method: 'DELETE' });
        if (res.ok) return;
        status = res.status;
      } catch { /* сеть: status остаётся null и называется в логе */ }
      setLikedMap(prev => { const next = new Map(prev); next.set(tourId, wishlistRowId); return next; });
      reportWishlistFailure(status, 'remove');
    } else {
      setLikedMap(prev => { const next = new Map(prev); next.set(tourId, ''); return next; });
      let status: number | null = null;
      try {
        const res = await fetch('/api/tourist/wishlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemType: 'tour', itemId: String(tourId) }),
        });
        if (res.ok) {
          const data = await res.json() as { data?: { id?: string | number } };
          setLikedMap(prev => { const next = new Map(prev); next.set(tourId, String(data?.data?.id ?? '')); return next; });
          return;
        }
        status = res.status;
      } catch { /* сеть: status остаётся null и называется в логе */ }
      setLikedMap(prev => { const next = new Map(prev); next.delete(tourId); return next; });
      reportWishlistFailure(status, 'add');
    }
  }, [likedMap, reportWishlistFailure]);

  const resetFilters = () => {
    setDifficulty('');
    setPriceRange('');
    setDurationType('');
  };

  const sortSelect = (extra: string) => (
    <select
      value={sort}
      onChange={e => setSort(e.target.value)}
      aria-label="Сортировка"
      className={`ds-input min-h-[44px] pr-8 text-sm rounded-lg ${extra}`}
    >
      {SORT_OPTIONS.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );

  const optionGroup = (
    title: string,
    options: { value: string; label: string }[],
    value: string,
    set: (v: string) => void,
  ) => (
    <div>
      <p className="ds-label mb-2.5 text-xs font-semibold uppercase tracking-wider">{title}</p>
      <div className="flex flex-wrap gap-2">
        {options.map(opt => (
          <button
            key={opt.value}
            type="button"
            aria-pressed={value === opt.value}
            onClick={() => set(value === opt.value ? '' : opt.value)}
            className={`${CHIP_BASE} ${value === opt.value ? CHIP_ON : CHIP_OFF}`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );

  // «По направлению» — только когда пустоту дал сам выбор направления, а не
  // поиск или фильтры поверх него (у «Сплав · 1» туры есть).
  const emptyTitle = activityFilter && !debouncedSearch && activeFiltersCount === 0
    ? 'Готовых туров по направлению пока нет'
    : 'Туров по этому запросу нет';

  return (
    <div className="ds-page pb-8">
      {/* ─── Hero (на всю ширину, без отрицательных полей) ─── */}
      <HeroSection summary={summary} />

      {/* Локальная обёртка контента: поля и ширина. Общий .ds-page не трогаем. */}
      <div className="px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
        {/* ─── Tours Section ─── */}
        <div id="tours" className="scroll-mt-20">
          {/* Направления — одна строка чипов со счётчиком */}
          {chips.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1 mb-3 scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0" role="group" aria-label="Направления">
              <button
                type="button"
                aria-pressed={activityFilter === ''}
                onClick={() => setActivityFilter('')}
                className={`flex-shrink-0 ${CHIP_BASE} ${activityFilter === '' ? CHIP_ON : CHIP_OFF}`}
              >
                Все{summary ? ` · ${summary.total}` : ''}
              </button>
              {chips.map(c => (
                <button
                  key={c.value}
                  type="button"
                  aria-pressed={activityFilter === c.value}
                  onClick={() => setActivityFilter(activityFilter === c.value ? '' : c.value)}
                  className={`flex-shrink-0 ${CHIP_BASE} ${activityFilter === c.value ? CHIP_ON : CHIP_OFF}`}
                >
                  {activityLabel(c.value, true)} · {c.count}
                </button>
              ))}
            </div>
          )}

          {/* Поиск + сортировка + фильтры: на телефоне одна строка */}
          <div className="flex gap-2 sm:gap-3 mb-3 sm:mb-4">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" aria-hidden />
              <input
                type="search"
                placeholder="Поиск по названию"
                aria-label="Поиск тура по названию"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="ds-input w-full min-h-[44px] pl-10 pr-11 rounded-lg [&::-webkit-search-cancel-button]:appearance-none"
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  aria-label="Очистить поиск"
                  className="absolute right-0 top-1/2 -translate-y-1/2 w-11 h-11 grid place-items-center text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {sortSelect('hidden sm:block w-auto')}

            <button
              type="button"
              onClick={() => setShowFilters(v => !v)}
              aria-expanded={showFilters}
              aria-controls="catalog-filters"
              className={`relative ds-btn ds-btn-secondary shrink-0 text-sm rounded-lg ${
                showFilters ? 'border-[var(--accent)] text-[var(--accent)]' : ''
              }`}
            >
              <SlidersHorizontal className="w-4 h-4" aria-hidden />
              <span>Фильтры</span>
              {activeFiltersCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[var(--accent)] text-white text-[11px] flex items-center justify-center font-bold">
                  {activeFiltersCount}
                </span>
              )}
              <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${showFilters ? 'rotate-180' : ''}`} aria-hidden />
            </button>
          </div>

          {/* Expandable Filter Panel */}
          {showFilters && (
            <div id="catalog-filters" className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5 mb-5 shadow-sm">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                <div className="sm:hidden">
                  <p className="ds-label mb-2.5 text-xs font-semibold uppercase tracking-wider">Сортировка</p>
                  {sortSelect('w-full')}
                </div>
                {optionGroup('Цена', PRICE_RANGES, priceRange, setPriceRange)}
                {optionGroup('Сложность', DIFFICULTY_OPTIONS, difficulty, setDifficulty)}
                {optionGroup('Длительность', DURATION_OPTIONS, durationType, setDurationType)}
              </div>

              {activeFiltersCount > 0 && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="mt-4 ds-btn ds-btn-secondary text-sm rounded-lg"
                >
                  Сбросить фильтры
                </button>
              )}
            </div>
          )}

          {/* Results count (на телефоне число уже в чипах и герое) */}
          {!loading && !error && total > 0 && (
            <p className="hidden sm:block text-sm text-[var(--text-secondary)] mb-5">
              {total} {plural(total, 'тур', 'тура', 'туров')}
            </p>
          )}

          {/* Grid */}
          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
              {Array.from({ length: 6 }).map((_, i) => <TourCardSkeleton key={i} />)}
            </div>
          ) : error ? (
            <div
              role="alert"
              className="flex items-center gap-3 text-[var(--danger)] border rounded-lg p-5"
              style={{ background: mix('--danger', 10), borderColor: mix('--danger', 30) }}
            >
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <p className="text-sm">{error}</p>
            </div>
          ) : tours.length === 0 ? (
            <div className="text-center py-14">
              <div className="w-16 h-16 rounded-lg bg-[var(--bg-hover)] flex items-center justify-center mx-auto mb-4">
                <Search className="w-7 h-7 text-[var(--text-muted)]" />
              </div>
              <p className="ds-h2 mb-2">{emptyTitle}</p>
              <p className="text-sm text-[var(--text-secondary)] mb-5 max-w-md mx-auto">
                Оставьте заявку — оператор предложит поездку под ваши даты. Но
                Камчатка — это не только готовые туры: сотни маршрутов и мест,
                поездку можно собрать самому.
              </p>
              {/* Первой — заявка через существующую форму /request (продажа не
                  теряется в тупике), второй — маршруты. КОНТЕКСТНО: искал
                  «Сплав» и туров нет → ведём на сплав-МАРШРУТЫ, а не в общий
                  список (жалоба Ярослава). Числа не хардкодим (CLAUDE.md). */}
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <Link href="/request" className="ds-btn ds-btn-primary text-sm rounded-lg">
                  <Send className="w-4 h-4" /> Оставить заявку
                </Link>
                <Link
                  href={activityFilter ? `/routes?kind=route&activity_type=${encodeURIComponent(activityFilter)}` : '/routes'}
                  className="ds-btn ds-btn-secondary text-sm rounded-lg"
                >
                  <Mountain className="w-4 h-4" />
                  {activityFilter
                    ? `Маршруты: ${activityLabel(activityFilter)}`
                    : 'Все маршруты'}
                </Link>
              </div>
              {(activeFiltersCount > 0 || activityFilter || searchTerm) && (
                <button
                  type="button"
                  onClick={() => { resetFilters(); setActivityFilter(''); setSearchTerm(''); }}
                  className="mt-4 min-h-[44px] px-3 text-sm text-[var(--ocean)] hover:underline"
                >
                  Сбросить все фильтры
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
              {tours.map((tour, i) => (
                <FragmentWithBanner key={tour.id} showBanner={i === Math.min(2, tours.length - 1)}>
                  <TourCard
                    tour={tour}
                    isLiked={likedMap.has(tour.id)}
                    onToggleLike={handleToggleLike}
                  />
                </FragmentWithBanner>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Тост: непрозрачный, над таб-баром и кнопкой заявки */}
      {notice && (
        <div
          role="status"
          className="fixed left-4 right-4 sm:left-auto sm:right-6 sm:max-w-sm z-[110] flex items-center gap-3 p-4 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] shadow-lg text-sm text-[var(--text-primary)]"
          style={{ bottom: 'calc(var(--bottom-nav-h, 0px) + 84px)' }}
        >
          <span className="flex-1">{notice.text}</span>
          {notice.href && (
            <Link href={notice.href} className="ds-btn ds-btn-primary shrink-0">{notice.hrefLabel}</Link>
          )}
          <button type="button" onClick={() => setNotice(null)} aria-label="Закрыть" className="w-11 h-11 -m-2 grid place-items-center text-[var(--text-secondary)]">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Баннер планировщика — после третьей карточки (или после последней, если
 * туров меньше), а не над выдачей: на первом экране должен быть тур (#7/#9).
 */
function FragmentWithBanner({ showBanner, children }: { showBanner: boolean; children: React.ReactNode }) {
  return (
    <>
      {children}
      {showBanner && <PlannerBanner />}
    </>
  );
}

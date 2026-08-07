'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PRICE_RANGES } from '@/lib/tours/marketplace-constants';
import {
  MapPin, Users, ChevronRight, Heart, ShoppingCart, Check,
  AlertCircle, Clock, Sparkles, Search, SlidersHorizontal,
  X, ChevronDown, Flame, ThermometerSun, Fish,
  PawPrint, Helicopter, Waves, Snowflake, Star, TrendingUp,
  Calendar, Mountain, ArrowRight, Anchor,
} from 'lucide-react';
import { useCart } from '@/contexts/CartContext';

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
  bookings_count: number;
  duration_hours: number | null;
  duration_type: string | null;
  multi_day_count: number | null;
  difficulty: string | null;
  included: string[] | null;
  season_start: string | null;
  season_end: string | null;
}

/* ─── Constants ─── */

/**
 * Подписи — из единого словаря (lib/tours/labels). Свои копии здесь и привели
 * к тому, что `boat_trip` в каталоге назывался «Морской тур», в карточке
 * «Морские туры», а кое-где «Сплав» — то есть морская прогулка выдавалась за
 * сплав. Короткие подписи для чипов остались, но живут в том же словаре.
 */
import { activityLabel, locationLabel, priceUnitLabel } from '@/lib/tours/labels';
import { photoSrc } from '@/lib/images/variant';
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

const ACTIVITY_OPTIONS = [
  { value: '',           label: 'Все' },
  { value: 'fishing',    label: 'Рыбалка' },
  { value: 'trekking',   label: 'Треккинг' },
  { value: 'rafting',    label: 'Сплав' },
  { value: 'thermal',    label: 'Термальные' },
  { value: 'helicopter', label: 'Вертолёт' },
  { value: 'boat_trip',  label: 'Морской тур' },
  { value: 'bears',      label: 'Медведи' },
  { value: 'snowmobile', label: 'Снегоход' },
];

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

const DIFFICULTY_BADGE: Record<string, { label: string; style: React.CSSProperties }> = {
  easy:   { label: 'Лёгкий',  style: { background: 'color-mix(in srgb, var(--success) 15%, transparent)', color: 'var(--success)' } },
  medium: { label: 'Средний', style: { background: 'color-mix(in srgb, var(--warning) 15%, transparent)', color: 'var(--warning)' } },
  hard:   { label: 'Сложный', style: { background: 'color-mix(in srgb, var(--danger) 15%, transparent)', color: 'var(--danger)' } },
};

const CATEGORY_DATA = [
  { key: 'trekking',   label: 'Вулканы',   icon: Flame,          color: 'from-orange-500/20 to-red-500/10',    iconColor: 'text-orange-400',  ring: 'ring-orange-400' },
  { key: 'thermal',    label: 'Термальные', icon: ThermometerSun, color: 'from-rose-500/20 to-pink-500/10',     iconColor: 'text-rose-400',    ring: 'ring-rose-400' },
  { key: 'fishing',    label: 'Рыбалка',   icon: Fish,           color: 'from-sky-500/20 to-blue-500/10',      iconColor: 'text-sky-400',     ring: 'ring-sky-400' },
  { key: 'bears',      label: 'Медведи',   icon: PawPrint,       color: 'from-amber-500/20 to-yellow-500/10',  iconColor: 'text-amber-400',   ring: 'ring-amber-400' },
  { key: 'helicopter', label: 'Вертолёт',  icon: Helicopter,     color: 'from-violet-500/20 to-purple-500/10', iconColor: 'text-violet-400',  ring: 'ring-violet-400' },
  { key: 'boat_trip',  label: 'Море',      icon: Waves,          color: 'from-cyan-500/20 to-teal-500/10',     iconColor: 'text-cyan-400',    ring: 'ring-cyan-400' },
  { key: 'rafting',    label: 'Сплав',     icon: Waves,          color: 'from-emerald-500/20 to-green-500/10', iconColor: 'text-emerald-400', ring: 'ring-emerald-400' },
  { key: 'snowmobile', label: 'Снегоход',  icon: Snowflake,      color: 'from-slate-400/20 to-blue-400/10',    iconColor: 'text-slate-300',   ring: 'ring-slate-400' },
];

/* ─── Helpers ─── */

function formatDuration(tour: Tour): string | null {
  if (tour.duration_type === 'multi_day' && tour.multi_day_count) {
    const d = tour.multi_day_count;
    return `${d} ${d === 1 ? 'день' : d < 5 ? 'дня' : 'дней'}`;
  }
  if (tour.duration_type === 'half_day') return 'Полдня';
  if (tour.duration_type === 'day') return '1 день';
  if (tour.duration_hours) {
    const h = Number(tour.duration_hours);
    if (h < 24) return `${h} ч`;
    const d = Math.round(h / 24);
    return `${d} ${d === 1 ? 'день' : d < 5 ? 'дня' : 'дней'}`;
  }
  return null;
}

function isInSeason(tour: Tour): boolean {
  if (!tour.season_start || !tour.season_end) return false;
  const now = new Date();
  return now >= new Date(tour.season_start) && now <= new Date(tour.season_end);
}

function getSeasonLabel(): string {
  const month = new Date().getMonth();
  if (month >= 5 && month <= 8) return 'Лето';
  if (month >= 2 && month <= 4) return 'Весна';
  if (month >= 9 && month <= 10) return 'Осень';
  return 'Зима';
}

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

function HeroSection() {
  return (
    <div className="relative -mx-4 sm:-mx-6 lg:-mx-8 mb-10 overflow-hidden rounded-none sm:rounded-lg">
      <div className="relative h-[320px] sm:h-[380px] lg:h-[420px]">
        <Image
          src="/images/marketplace/hero-marketplace.jpg"
          alt="Камчатка — земля вулканов"
          fill
          priority
          className="object-cover"
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/50 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />

        <div className="relative h-full flex flex-col justify-end p-6 sm:p-10 lg:p-12 max-w-2xl">
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--accent)]/90 text-white text-xs font-semibold ">
              <TrendingUp className="w-3 h-3" />
              {getSeasonLabel()} 2026
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-black/30 text-white text-xs font-medium ">
              <Mountain className="w-3 h-3" />
              13 туров
            </span>
          </div>

          <h1
            className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white leading-tight mb-3"
            style={{ fontFamily: 'var(--font-playfair)' }}
          >
            Туры Камчатки
          </h1>
          <p className="text-sm sm:text-base text-white/80 leading-relaxed mb-5 max-w-lg">
            Реальные предложения от проверенных операторов. Вулканы, медведи, океан, термальные источники — выберите своё приключение.
          </p>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/planner"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-semibold transition-all duration-200 shadow-lg shadow-[var(--accent)]/30"
            >
              <Sparkles className="w-4 h-4" />
              Подобрать с Кузьмичом
            </Link>
            <a
              href="#tours"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-black/25 hover:bg-black/40 text-white text-sm font-medium transition-all duration-200 border border-white/30"
            >
              Смотреть все туры
              <ArrowRight className="w-4 h-4" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Stats Bar ─── */

function StatsBar() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
      {[
        { icon: Mountain, label: 'Направлений', value: '8', color: 'text-[var(--accent)]' },
        { icon: Calendar, label: 'Сезон', value: getSeasonLabel(), color: 'text-[var(--success)]' },
        { icon: Users, label: 'Операторов', value: '2+', color: 'text-[var(--ocean)]' },
        { icon: Star, label: 'Проверенные', value: '100%', color: 'text-[var(--warning)]' },
      ].map((stat, i) => (
        <div
          key={i}
          className="flex items-center gap-3 p-3.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] hover:border-[var(--border-strong)] transition-colors"
        >
          <div className={`w-9 h-9 rounded-lg bg-[var(--bg-hover)] flex items-center justify-center ${stat.color}`}>
            <stat.icon className="w-4.5 h-4.5" />
          </div>
          <div>
            <p className="text-base font-bold text-[var(--text-primary)] leading-none">{stat.value}</p>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">{stat.label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Tour Card (Premium Redesign) ─── */

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

function TourCard({
  tour,
  isLiked,
  onToggleLike,
}: {
  tour: Tour;
  isLiked: boolean;
  onToggleLike: (tourId: number) => void;
}) {
  const { add, remove, has } = useCart();
  const inCart = has(tour.id);
  const activity = activityLabel(tour.activity_type, true);
  const location = locationLabel(tour.location_type);
  // 640-вариант: оптимизатор Next выключен, без нарезки карточка каталога
  // грузила оригинал (см. lib/images/variant.ts).
  const imageSrc = photoSrc(tour.tour_image ?? ACTIVITY_IMAGES[tour.activity_type] ?? '/images/activities/volcanoes.jpg', 640);
  const diffBadge = tour.difficulty ? DIFFICULTY_BADGE[tour.difficulty] : null;
  const duration = formatDuration(tour);
  const inSeason = isInSeason(tour);
  const priceOld = tour.price_old ? Number(tour.price_old) : null;
  const basePrice = Number(tour.base_price);
  const features = deriveFeatures(tour);

  const toggleCart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (inCart) {
      remove(tour.id);
    } else {
      add({
        tourId: tour.id,
        title: tour.title,
        operatorName: tour.operator_name,
        price: basePrice,
        activityType: tour.activity_type,
        image: tour.tour_image,
      });
    }
  };

  return (
    <div className="group relative aspect-[17/25] rounded-2xl overflow-hidden bg-[var(--bg-hover)] shadow-sm hover:shadow-2xl transition-all duration-300">
      {/* Фото на всю карточку */}
      <Image
        src={imageSrc}
        alt={tour.title}
        fill
        sizes="(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 33vw"
        className="object-cover group-hover:scale-[1.05] transition-transform duration-700 ease-out"
        style={{ filter: 'saturate(1.12) contrast(1.04)' }}
      />
      {/* Затемнение только внизу под текстом — краски фото играют */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-black/10" />

      {/* Навигация по всей карточке (под оверлеями) */}
      <Link href={`/marketplace/tours/${tour.id}`} className="absolute inset-0 z-[1]" aria-label={tour.title} />

      {/* Рейл фич — стекло поверх фото */}
      {features.length > 0 && (
        <div className="absolute top-3 left-3 z-[2] flex flex-col gap-0.5 p-1.5 rounded-2xl backdrop-blur-md bg-black/25 border border-white/25 pointer-events-none">
          {features.map((f) => (
            <span key={f.label} title={f.label} className="w-8 h-8 grid place-items-center text-white">
              <f.Icon className="w-[18px] h-[18px]" />
            </span>
          ))}
        </div>
      )}

      {/* Избранное — стекло */}
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleLike(tour.id); }}
        aria-label={isLiked ? 'Убрать из избранного' : 'В избранное'}
        className="absolute top-3 right-3 z-[3] w-9 h-9 rounded-full grid place-items-center backdrop-blur-md bg-black/25 border border-white/25 transition-transform hover:scale-110"
      >
        <Heart className={`w-4 h-4 ${isLiked ? 'fill-[var(--danger)] text-[var(--danger)]' : 'text-white'}`} />
      </button>

      {/* Нижняя стеклянная панель — компактная и лёгкая, чтобы фото дышало */}
      <div className="absolute left-3 right-3 bottom-3 z-[2] p-3.5 rounded-2xl backdrop-blur-md bg-black/22 border border-white/15 pointer-events-none">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-white px-2 py-0.5 rounded-full bg-white/15 border border-white/20" style={{ fontFamily: 'var(--font-jetbrains, monospace)' }}>
            {activity}
          </span>
          {diffBadge && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-white px-2 py-0.5 rounded-full bg-white/10 border border-white/15" style={{ fontFamily: 'var(--font-jetbrains, monospace)' }}>
              {diffBadge.label}
            </span>
          )}
          {inSeason && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-white">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--success)' }} />
              Сезон
            </span>
          )}
        </div>

        <h3
          className="text-white leading-none line-clamp-2 mb-1.5"
          style={{ fontFamily: 'var(--font-unbounded, var(--font-playfair))', fontWeight: 800, fontSize: '1.25rem', letterSpacing: '-0.02em', textShadow: '0 1px 14px rgba(0,0,0,.45)' }}
        >
          {tour.title}
        </h3>

        {(tour.short_description || tour.description) && (
          <p className="text-[12.5px] text-white/85 line-clamp-1 mb-2" style={{ textShadow: '0 1px 8px rgba(0,0,0,.4)' }}>
            {tour.short_description ?? tour.description}
          </p>
        )}

        <div className="flex items-center gap-3 text-[11px] text-white/75 mb-2">
          <span className="inline-flex items-center gap-1"><MapPin className="w-3.5 h-3.5" />{tour.location_name ?? location}</span>
          {duration && <span className="inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{duration}</span>}
        </div>

        <div className="flex items-baseline gap-2 mb-2.5">
          {priceOld && priceOld > basePrice && (
            <span className="text-xs text-white/50 line-through">{priceOld.toLocaleString('ru-RU')} ₽</span>
          )}
          <span className="text-white" style={{ fontFamily: 'var(--font-unbounded, var(--font-playfair))', fontWeight: 800, fontSize: '1.25rem', letterSpacing: '-0.01em' }}>
            {basePrice.toLocaleString('ru-RU')} ₽
          </span>
          <span className="text-[11px] text-white/60">{priceUnitLabel(tour.price_unit, true)}</span>
        </div>

        <div className="flex items-center gap-2 pointer-events-auto">
          <Link
            href={`/marketplace/tours/${tour.id}#booking`}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 text-center rounded-xl py-3 text-sm font-bold text-white border border-white/30 bg-white/15 backdrop-blur-md transition-colors hover:bg-[var(--accent)] hover:border-[var(--accent)]"
            style={{ fontFamily: 'var(--font-unbounded, var(--font-playfair))' }}
          >
            Забронировать
          </Link>
          <button
            onClick={toggleCart}
            title={inCart ? 'Убрать из корзины' : 'В корзину'}
            aria-label={inCart ? 'Убрать из корзины' : 'В корзину'}
            className={`w-11 h-11 rounded-xl grid place-items-center border backdrop-blur-md transition-colors ${
              inCart ? 'bg-[var(--success)] border-[var(--success)] text-white' : 'border-white/30 bg-white/15 text-white hover:bg-white/25'
            }`}
          >
            {inCart ? <Check className="w-4 h-4" /> : <ShoppingCart className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Marketplace Client ─── */

interface MarketplaceClientProps {
  /** Первый рендер с сервера (SEO): данные, снятые RSC-страницей каталога. */
  initialTours?: Tour[];
  initialTotal?: number;
  /** Ключ фильтров серверного рендера — чтобы не дублировать fetch на маунте. */
  initialKey?: string | null;
}

export default function MarketplaceClient({
  initialTours,
  initialTotal = 0,
  initialKey = null,
}: MarketplaceClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const urlParams = useSearchParams();

  const [tours, setTours] = useState<Tour[]>(initialTours ?? []);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(initialKey === null);
  const [error, setError] = useState('');

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

  // Load wishlist
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
      .catch(() => {});
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
        if (!r.ok) throw new Error('Ошибка загрузки');
        return r.json();
      })
      .then(data => {
        if (data?.tours) setTours(data.tours);
        if (data?.total != null) setTotal(data.total);
      })
      .catch(() => setError('Не удалось загрузить туры. Попробуйте обновить страницу.'))
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

  const handleToggleLike = useCallback(async (tourId: number) => {
    const wishlistRowId = likedMap.get(tourId);
    const isLiked = likedMap.has(tourId);

    if (isLiked && wishlistRowId) {
      setLikedMap(prev => { const next = new Map(prev); next.delete(tourId); return next; });
      const res = await fetch(`/api/tourist/wishlist?id=${wishlistRowId}`, { method: 'DELETE' });
      if (!res.ok) setLikedMap(prev => { const next = new Map(prev); next.set(tourId, wishlistRowId); return next; });
    } else {
      setLikedMap(prev => { const next = new Map(prev); next.set(tourId, ''); return next; });
      const res = await fetch('/api/tourist/wishlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemType: 'tour', itemId: String(tourId) }),
      });
      if (res.ok) {
        const data = await res.json() as { data?: { id?: string | number } };
        setLikedMap(prev => { const next = new Map(prev); next.set(tourId, String(data?.data?.id ?? '')); return next; });
      } else {
        setLikedMap(prev => { const next = new Map(prev); next.delete(tourId); return next; });
      }
    }
  }, [likedMap]);

  const resetFilters = () => {
    setDifficulty('');
    setPriceRange('');
    setDurationType('');
  };

  return (
    <div className="ds-page pb-20">
      {/* ─── Hero ─── */}
      <HeroSection />

      {/* ─── Stats ─── */}
      <StatsBar />

      {/* ─── Visual Category Grid ─── */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>
            Выберите направление
          </h2>
          {activityFilter && (
            <button
              onClick={() => setActivityFilter('')}
              className="text-xs text-[var(--accent)] hover:underline flex items-center gap-1"
            >
              Сбросить
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        <div className="grid grid-cols-4 sm:grid-cols-4 lg:grid-cols-8 gap-2.5">
          {CATEGORY_DATA.map(cat => (
            <button
              key={cat.key}
              onClick={() => setActivityFilter(activityFilter === cat.key ? '' : cat.key)}
              className={`group flex flex-col items-center gap-2 py-4 px-2 rounded-lg border transition-all duration-300 ${
                activityFilter === cat.key
                  ? `bg-gradient-to-b ${cat.color} border-transparent ring-2 ${cat.ring} ring-offset-2 ring-offset-[var(--bg-page)] scale-[1.02]`
                  : 'border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--border-strong)] hover:scale-[1.03] hover:shadow-md'
              }`}
            >
              <div className={`w-10 h-10 sm:w-11 sm:h-11 rounded-xl flex items-center justify-center transition-all duration-300 ${
                activityFilter === cat.key
                  ? `bg-gradient-to-b ${cat.color} ${cat.iconColor}`
                  : `bg-[var(--bg-hover)] text-[var(--text-muted)] group-hover:${cat.iconColor}`
              }`}>
                <cat.icon className="w-5 h-5 sm:w-5.5 sm:h-5.5" />
              </div>
              <span className={`text-[11px] sm:text-xs font-semibold text-center leading-tight transition-colors ${
                activityFilter === cat.key
                  ? 'text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]'
              }`}>
                {cat.label}
              </span>
              {activityFilter === cat.key && (
                <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[var(--accent)] flex items-center justify-center">
                  <Check className="w-2.5 h-2.5 text-white" />
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ─── AI Planner Banner ─── */}
      <Link
        href="/planner"
        className="group flex items-center gap-4 p-5 rounded-lg border border-[var(--accent)]/20 bg-gradient-to-r from-[var(--accent)]/8 to-[var(--accent)]/3 hover:from-[var(--accent)]/12 hover:to-[var(--accent)]/6 transition-all duration-300 mb-8"
      >
        <div className="w-11 h-11 rounded-xl bg-[var(--accent)]/15 flex items-center justify-center shrink-0 group-hover:bg-[var(--accent)]/25 transition-colors">
          <Sparkles className="w-5 h-5 text-[var(--accent)]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-[var(--text-primary)] mb-0.5">Не знаете что выбрать?</p>
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">Кузьмич подберёт тур по вашим датам, бюджету и физической подготовке</p>
        </div>
        <ChevronRight className="w-5 h-5 text-[var(--accent)] shrink-0 group-hover:translate-x-1 transition-transform" />
      </Link>

      {/* ─── Tours Section ─── */}
      <div id="tours">
        {/* Search + Sort + Filters */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input
              type="text"
              placeholder="Поиск по названию..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="ds-input w-full pl-10 pr-10 rounded-xl"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            className="ds-input w-auto pr-8 text-sm rounded-xl"
          >
            {SORT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          <button
            onClick={() => setShowFilters(v => !v)}
            className={`relative ds-btn ds-btn-secondary flex items-center gap-2 text-sm rounded-xl ${
              showFilters ? 'border-[var(--accent)] text-[var(--accent)]' : ''
            }`}
          >
            <SlidersHorizontal className="w-4 h-4" />
            <span className="hidden sm:inline">Фильтры</span>
            {activeFiltersCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[var(--accent)] text-white text-[10px] flex items-center justify-center font-bold">
                {activeFiltersCount}
              </span>
            )}
            <ChevronDown className={`w-3 h-3 transition-transform ${showFilters ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {/* Activity Chips */}
        <div className="flex gap-2 overflow-x-auto pb-2 mb-4 scrollbar-none">
          {ACTIVITY_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setActivityFilter(opt.value)}
              className={`flex-shrink-0 px-3.5 py-1.5 rounded-xl text-sm font-medium border transition-all duration-200 ${
                activityFilter === opt.value
                  ? 'bg-[var(--accent)] border-[var(--accent)] text-white shadow-md shadow-[var(--accent)]/20'
                  : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text-primary)] bg-[var(--bg-card)]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Expandable Filter Panel */}
        {showFilters && (
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5 mb-5 shadow-sm">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              <div>
                <p className="ds-label mb-2.5 text-xs font-semibold uppercase tracking-wider">Цена</p>
                <div className="flex flex-wrap gap-2">
                  {PRICE_RANGES.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setPriceRange(priceRange === opt.value ? '' : opt.value)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all duration-150 ${
                        priceRange === opt.value
                          ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                          : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 bg-[var(--bg-card)]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="ds-label mb-2.5 text-xs font-semibold uppercase tracking-wider">Сложность</p>
                <div className="flex flex-wrap gap-2">
                  {DIFFICULTY_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setDifficulty(difficulty === opt.value ? '' : opt.value)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all duration-150 ${
                        difficulty === opt.value
                          ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                          : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 bg-[var(--bg-card)]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="ds-label mb-2.5 text-xs font-semibold uppercase tracking-wider">Длительность</p>
                <div className="flex flex-wrap gap-2">
                  {DURATION_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setDurationType(durationType === opt.value ? '' : opt.value)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all duration-150 ${
                        durationType === opt.value
                          ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                          : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 bg-[var(--bg-card)]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {activeFiltersCount > 0 && (
              <button
                onClick={resetFilters}
                className="mt-4 ds-btn ds-btn-secondary text-xs rounded-xl"
              >
                Сбросить фильтры
              </button>
            )}
          </div>
        )}

        {/* Results count */}
        {!loading && !error && (
          <div className="flex items-center justify-between mb-6">
            <p className="text-sm text-[var(--text-muted)]">
              {total > 0
                ? `${total} ${total === 1 ? 'тур' : total < 5 ? 'тура' : 'туров'}`
                : null}
            </p>
          </div>
        )}

        {/* Grid */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 6 }).map((_, i) => <TourCardSkeleton key={i} />)}
          </div>
        ) : error ? (
          <div className="flex items-center gap-3 text-[var(--danger)] bg-[var(--danger)]/10 border border-[var(--danger)]/30 rounded-lg p-5">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <p className="text-sm">{error}</p>
          </div>
        ) : tours.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 rounded-lg bg-[var(--bg-hover)] flex items-center justify-center mx-auto mb-4">
              <Search className="w-7 h-7 text-[var(--text-muted)]" />
            </div>
            <p className="ds-h2 mb-2">Туров по этому запросу немного</p>
            <p className="text-sm text-[var(--text-muted)] mb-5 max-w-md mx-auto">
              Попробуйте изменить фильтры. Но Камчатка — это не только готовые туры:
              сотни маршрутов и мест, поездку можно собрать самому.
            </p>
            {(activeFiltersCount > 0 || activityFilter || searchTerm) && (
              <button
                onClick={() => { resetFilters(); setActivityFilter(''); setSearchTerm(''); }}
                className="ds-btn ds-btn-secondary text-sm rounded-xl mb-6"
              >
                Сбросить все фильтры
              </button>
            )}
            {/* Тупик «нет туров» → путь к настоящему богатству платформы:
                маршруты/места и планировщик (с ~20 турами это главный контент,
                а не запасной). Числа не хардкодим — они меняются (CLAUDE.md).
                КОНТЕКСТНО: искал «Сплав» и туров нет → ведём на сплав-МАРШРУТЫ,
                а не в общий список (жалоба Ярослава: искал сплавы → пусто). */}
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <Link
                href={activityFilter ? `/routes?kind=route&activity_type=${encodeURIComponent(activityFilter)}` : '/routes'}
                className="ds-btn ds-btn-secondary text-sm rounded-xl inline-flex items-center gap-2"
              >
                <Mountain className="w-4 h-4" />
                {activityFilter
                  ? `Маршруты: ${activityLabel(activityFilter)}`
                  : 'Все маршруты'}
              </Link>
              <Link href="/planner" className="ds-btn ds-btn-primary text-sm rounded-xl inline-flex items-center gap-2">
                <Sparkles className="w-4 h-4" /> Собрать поездку
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {tours.map(tour => (
              <TourCard
                key={tour.id}
                tour={tour}
                isLiked={likedMap.has(tour.id)}
                onToggleLike={handleToggleLike}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

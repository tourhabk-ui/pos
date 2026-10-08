'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Search, SlidersHorizontal, X, Building2 } from 'lucide-react';
import { AccommodationCard } from '@/components/shared/AccommodationCard';
import { AccommodationCardSkeleton } from '@/components/shared/AccommodationCardSkeleton';
import { AccommodationFilters } from '@/components/shared/AccommodationFilters';
import { funnelBeacon } from '@/lib/funnel/beacon';
import { wishlistFailureText } from '@/lib/wishlist/contract';
import { staySearchEntity, type StaySearchOutcome } from '@/lib/stay/demand';
import { sessionState } from '@/lib/auth/session-state';
import { ACCOMMODATIONS_FIRST_PAGE_LIMIT, ACCOMMODATIONS_DEFAULT_SORT } from '@/lib/stay/catalog-first-page';

// Форма ответа GET /api/accommodations (camelCase — как отдаёт роут;
// старый snake_case интерфейс не совпадал с API и листинг падал)
interface Accommodation {
  id: string;
  name: string;
  type: string;
  description: string;
  address: string;
  starRating: number | null;
  pricePerNight: { from: number; to: number | null; currency: string };
  amenities: string[];
  /** null — объект никто не оценивал (§4.0). API отдаёт именно null, а карточка
   *  это признаёт (components/stay/AccommodationCard) — тип обязан позволять. */
  rating: number | null;
  reviewCount: number;
  isVerified: boolean;
  images: Array<{ url: string; alt?: string }>;
}

/** Первая страница витрины, отрисованная сервером (тело ответа GET /api/accommodations). */
export interface AccommodationsInitial {
  raw: { accommodations: Accommodation[]; pagination: { total: number } };
}

interface FiltersState {
  type: string[];
  priceMin: number;
  priceMax: number;
  ratingMin: number;
  amenities: string[];
  locationZone: string;
  search: string;
  sort: string;
  /** Поиск по датам (Booking-паттерн): обе даты или ни одной. */
  checkIn: string;
  checkOut: string;
}

const DEFAULT_FILTERS: FiltersState = {
  type: [],
  priceMin: 0,
  priceMax: 50000,
  ratingMin: 0,
  amenities: [],
  locationZone: '',
  search: '',
  sort: ACCOMMODATIONS_DEFAULT_SORT,
  checkIn: '',
  checkOut: '',
};

/**
 * Задал ли посетитель хоть одно условие ПОИСКА — ровно те, что `load` уходит
 * искать. Порядок сортировки — не условие: он меняет вид, а не то, что человек
 * ищет. Условия здесь повторяют отбор параметров в `load` (тип — только когда
 * выбран один; даты — только валидной парой): иначе выдача, в которой фильтр
 * НЕ применён, считалась бы поиском. Первая загрузка витрины без условий
 * поиском не считается — её уже посчитал просмотр страницы (page_views).
 */
function isSearch(f: FiltersState): boolean {
  return f.type.length === 1
    || f.priceMin > 0
    || f.priceMax < 50000
    || f.ratingMin > 0
    || f.amenities.length > 0
    || f.locationZone !== ''
    || f.search.trim() !== ''
    || (f.checkIn !== '' && f.checkOut !== '' && f.checkOut > f.checkIn);
}

export function AccommodationsClient({ initial = null }: { initial?: AccommodationsInitial | null }) {
  const [accommodations, setAccommodations] = useState<Accommodation[]>(initial?.raw.accommodations ?? []);
  const [total, setTotal] = useState(initial?.raw.pagination?.total ?? initial?.raw.accommodations.length ?? 0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(initial === null);
  // Первую страницу при условиях по умолчанию уже отрисовал сервер тем же
  // запросом (lib/stay/catalog-first-page) — повторно её не спрашиваем.
  const skipFirstLoad = useRef(initial !== null);
  const [filters, setFilters] = useState<FiltersState>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);

  // Избранное — по единому контракту (lib/wishlist/contract, тип
  // `accommodation`), той же дорогой, что у каталога туров. До 10.09 сердечко
  // на карточке жилья было мёртвым: страница не передавала обработчик, клик
  // не делал ничего (#1786). Гость — на вход, не молча.
  const router = useRouter();
  const [favMap, setFavMap] = useState<Map<string, string>>(new Map());
  // Причина отказа избранного словами (09.10): раньше сердце откатывалось молча.
  const [favNotice, setFavNotice] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Только вошедшему: у гостя роут отвечал 401 (аудит 01.10).
    sessionState()
      .then(authed => (authed === true
        ? fetch('/api/tourist/wishlist?type=accommodation').then(r => (r.ok ? r.json() : null))
        : null))
      .then((data: { data?: Array<{ item_id: string; id: string | number }> } | null) => {
        if (!alive || !Array.isArray(data?.data)) return;
        setFavMap(new Map(data.data.map(i => [String(i.item_id), String(i.id)])));
      })
      .catch(() => { /* гость или сеть — сердечки остаются пустыми, клик проверит вход */ });
    return () => { alive = false; };
  }, []);

  const toggleFavorite = useCallback(async (id: string) => {
    const isFav = favMap.has(id);
    setFavMap(prev => { const next = new Map(prev); if (isFav) next.delete(id); else next.set(id, ''); return next; });
    const res = await fetch('/api/tourist/wishlist', {
      method: isFav ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemType: 'accommodation', itemId: id }),
    }).catch(() => null);
    if (res?.status === 401) {
      setFavMap(prev => { const next = new Map(prev); next.delete(id); return next; });
      router.push('/auth/login');
      return;
    }
    if (!res?.ok) {
      // Откат и причина: в консоль для нас и словами для человека (09.10).
      console.error('[accommodations] избранное не сохранено', res?.status ?? 'сеть');
      setFavMap(prev => { const next = new Map(prev); if (isFav) next.set(id, ''); else next.delete(id); return next; });
      setFavNotice(wishlistFailureText(res?.status ?? null));
      return;
    }
    setFavNotice(null);
    if (!isFav) {
      const data = await res.json().catch(() => null) as { data?: { id?: string | number } } | null;
      setFavMap(prev => { const next = new Map(prev); next.set(id, String(data?.data?.id ?? '')); return next; });
    }
  }, [favMap, router]);

  // Маяк спроса шлётся после паузы: каждая буква в поиске и каждый сдвиг
  // ползунка цены — отдельная загрузка, но не отдельное намерение. Считается
  // последний исход серии, а не каждый промежуточный (обзор 29.09).
  const beaconTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beaconPending = useRef<StaySearchOutcome | null>(null);
  const flushBeacon = useCallback(() => {
    if (beaconTimer.current) { clearTimeout(beaconTimer.current); beaconTimer.current = null; }
    if (beaconPending.current) {
      funnelBeacon('stay_search', staySearchEntity('web', beaconPending.current));
      beaconPending.current = null;
    }
  }, []);
  // Уход со страницы не теряет последний поиск серии.
  useEffect(() => flushBeacon, [flushBeacon]);

  const load = useCallback(async (currentPage: number, currentFilters: FiltersState) => {
    setLoading(true);
    const p = new URLSearchParams();
    p.set('page', String(currentPage));
    p.set('limit', String(ACCOMMODATIONS_FIRST_PAGE_LIMIT));
    p.set('sort', currentFilters.sort);
    if (currentFilters.type.length === 1) p.set('type', currentFilters.type[0]);
    if (currentFilters.priceMin > 0) p.set('price_min', String(currentFilters.priceMin));
    if (currentFilters.priceMax < 50000) p.set('price_max', String(currentFilters.priceMax));
    if (currentFilters.ratingMin > 0) p.set('rating_min', String(currentFilters.ratingMin / 10));
    if (currentFilters.amenities.length > 0) p.set('amenities', currentFilters.amenities.join(','));
    if (currentFilters.locationZone) p.set('location_zone', currentFilters.locationZone);
    if (currentFilters.search) p.set('search', currentFilters.search);
    // Даты уходят только парой и только валидные — сервер иначе ответит 400.
    if (currentFilters.checkIn && currentFilters.checkOut && currentFilters.checkOut > currentFilters.checkIn) {
      p.set('check_in', currentFilters.checkIn);
      p.set('check_out', currentFilters.checkOut);
    }

    // Исход поиска для счётчика спроса на жильё (lib/stay/demand). По
    // умолчанию 'failed': если витрина не ответила или ответила не тем, спрос
    // был, а ответа не было — и это факт о нас, а не «ничего не нашлось».
    let outcome: StaySearchOutcome = 'failed';
    try {
      const res = await fetch(`/api/accommodations?${p}`);
      if (res.ok) {
        // Роут отдаёт { success, data: { accommodations, pagination } } —
        // старое чтение data.data-массива и meta.total ломало листинг
        const data = await res.json() as {
          success: boolean;
          data: { accommodations: Accommodation[]; pagination: { total: number } };
        };
        if (data.success && Array.isArray(data.data?.accommodations)) {
          const items = data.data.accommodations;
          setAccommodations(currentPage === 1 ? items : prev => [...prev, ...items]);
          const found = data.data.pagination?.total ?? items.length;
          setTotal(found);
          outcome = found > 0 ? 'found' : 'empty';
        }
      }
    } finally {
      setLoading(false);
      // Считается поиск, а не «показать ещё», и только с условиями.
      if (currentPage === 1 && isSearch(currentFilters)) {
        beaconPending.current = outcome;
        if (beaconTimer.current) clearTimeout(beaconTimer.current);
        beaconTimer.current = setTimeout(flushBeacon, 1500);
      }
    }
  }, [flushBeacon]);

  useEffect(() => {
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false;
      return;
    }
    setPage(1);
    load(1, filters);
  }, [filters, load]);

  const handleFiltersChange = (newFilters: FiltersState) => {
    setFilters(newFilters);
  };

  const handleReset = () => {
    setFilters(DEFAULT_FILTERS);
  };

  const handleLoadMore = () => {
    const next = page + 1;
    setPage(next);
    load(next, filters);
  };

  const hasMore = accommodations.length < total;

  return (
    <div className="max-w-7xl mx-auto px-4 py-10">

      {/* Hero */}
      <div className="mb-8">
        <h1 className="font-playfair text-4xl md:text-5xl font-bold text-[var(--text-primary)] mb-3 leading-tight">
          Жильё на Камчатке
        </h1>
        <p className="text-[var(--text-secondary)] text-lg max-w-xl">
          Отели, хостелы, глэмпинг и кемпинги — от центра Петропавловска до природных парков.
        </p>
      </div>

      {/* Даты поездки — первичный фильтр жилья (как в booking-сервисах):
          выбраны обе даты → каталог показывает только объекты со свободным
          номером на все ночи окна */}
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="stay-check-in" className="ds-label block mb-1">Заезд</label>
          <input
            id="stay-check-in"
            type="date"
            value={filters.checkIn}
            min={new Date().toISOString().slice(0, 10)}
            onChange={e => handleFiltersChange({ ...filters, checkIn: e.target.value })}
            className="ds-input"
          />
        </div>
        <div>
          <label htmlFor="stay-check-out" className="ds-label block mb-1">Выезд</label>
          <input
            id="stay-check-out"
            type="date"
            value={filters.checkOut}
            min={filters.checkIn || new Date().toISOString().slice(0, 10)}
            onChange={e => handleFiltersChange({ ...filters, checkOut: e.target.value })}
            className="ds-input"
          />
        </div>
        {(filters.checkIn || filters.checkOut) && (
          <button
            type="button"
            onClick={() => handleFiltersChange({ ...filters, checkIn: '', checkOut: '' })}
            className="ds-btn ds-btn-secondary flex items-center gap-1.5 text-sm"
          >
            <X size={14} /> Любые даты
          </button>
        )}
        {filters.checkIn && filters.checkOut && filters.checkOut > filters.checkIn && (
          <p className="text-xs text-[var(--text-muted)] pb-2.5">
            Показаны только объекты со свободными номерами на эти даты
          </p>
        )}
      </div>

      {/* Mobile search + filter toggle */}
      <div className="flex gap-3 mb-6 lg:hidden">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={filters.search}
            onChange={e => handleFiltersChange({ ...filters, search: e.target.value })}
            placeholder="Поиск жилья..."
            className="ds-input pl-10 pr-9 w-full"
          />
          {filters.search && (
            <button
              onClick={() => handleFiltersChange({ ...filters, search: '' })}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className="ds-btn ds-btn-secondary flex items-center gap-2 shrink-0"
        >
          <SlidersHorizontal size={16} />
          Фильтры
        </button>
      </div>

      <div className="flex gap-6">
        {/* Sidebar filters — desktop always visible, mobile conditional */}
        <aside className={`w-72 shrink-0 ${showFilters ? 'block' : 'hidden'} lg:block`}>
          <div className="sticky top-[72px]">
            <AccommodationFilters
              filters={filters}
              onFiltersChange={handleFiltersChange}
              onReset={handleReset}
            />
          </div>
        </aside>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          {/* Count */}
          <p className="text-sm text-[var(--text-muted)] mb-4">
            {loading && accommodations.length === 0 ? '...' : `${total} объектов`}
          </p>

          {/* Grid */}
          {loading && accommodations.length === 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <AccommodationCardSkeleton key={i} />
              ))}
            </div>
          ) : accommodations.length === 0 ? (
            <div className="text-center py-20">
              <Building2 size={40} className="mx-auto text-[var(--text-muted)] mb-4" />
              <p className="text-[var(--text-secondary)] mb-3">Объекты не найдены</p>
              <button
                onClick={handleReset}
                className="text-[var(--accent)] text-sm hover:underline"
              >
                Сбросить фильтры
              </button>
            </div>
          ) : (
            <>
              {favNotice && (
                <div role="status" className="ds-card p-3 mb-4 flex items-start justify-between gap-3 text-sm text-[var(--text-secondary)]">
                  <span>{favNotice}</span>
                  <button type="button" onClick={() => setFavNotice(null)} aria-label="Закрыть" className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                    <X size={16} />
                  </button>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {accommodations.map(acc => (
                  <AccommodationCard
                    key={acc.id}
                    id={acc.id}
                    name={acc.name}
                    type={acc.type}
                    description={acc.description}
                    address={acc.address}
                    pricePerNight={acc.pricePerNight}
                    rating={acc.rating}
                    reviewCount={acc.reviewCount}
                    amenities={acc.amenities}
                    images={acc.images}
                    starRating={acc.starRating ?? undefined}
                    isVerified={acc.isVerified}
                    isFavorite={favMap.has(acc.id)}
                    onFavoriteToggle={toggleFavorite}
                  />
                ))}
              </div>

              {hasMore && (
                <div className="mt-8 text-center">
                  <button
                    onClick={handleLoadMore}
                    disabled={loading}
                    className="ds-btn ds-btn-secondary px-8"
                  >
                    {loading ? 'Загрузка...' : 'Показать ещё'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

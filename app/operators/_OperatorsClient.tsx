'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { Search, ShieldCheck, ChevronRight, MapPin } from 'lucide-react';
import { OperatorRating } from '@/components/operator/OperatorRating';
import { activityLabel } from '@/lib/tours/labels';
import { tourFactsLine, type ActivityCount, type OperatorTourFacts } from '@/lib/operators/tour-facts';
import { OPERATORS_ORDER_NOTE } from '@/lib/operators/order-note';

export interface Operator {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  shortDescription: string | null;
  heroImage: string | null;
  rating: number;
  reviewCount: number;
  isVerified: boolean;
  /** Живые туры компании; `null` — сервер посчитать не смог, строки нет. */
  tourFacts: OperatorTourFacts | null;
}

export interface ApiMeta {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

// Кнопки фильтра — виды ЖИВЫХ туров с числом компаний, из данных сервера
// (`activities`), а не захардкоженный список. Прежние «Рыбалка», «Вертолётные
// туры», «Треккинг» фильтровали partners.category, где таких значений быть не
// может, и всегда давали пустую выдачу (находка PAVEL-operators, 15.10).
const CHIP_BASE = 'min-h-[44px] inline-flex items-center px-3 rounded-lg text-sm font-medium transition-colors border';
const CHIP_ON = 'bg-[var(--accent)] text-[var(--on-accent)] border-[var(--accent)]';
const CHIP_OFF = 'bg-[var(--bg-card)] text-[var(--text-secondary)] border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)]';

interface OperatorsPageClientProps {
  /** Первый рендер с сервера (SEO): данные, снятые RSC-страницей /operators. */
  initialItems?: Operator[];
  initialMeta?: ApiMeta | null;
  /** Ключ фильтров серверного рендера — чтобы не дублировать fetch на маунте. */
  initialKey?: string | null;
  /** Виды живых туров → сколько компаний их водят. `null` — неизвестно, кнопок нет. */
  initialActivities?: ActivityCount[] | null;
}

export default function OperatorsPageClient({
  initialItems,
  initialMeta = null,
  initialKey = null,
  initialActivities = null,
}: OperatorsPageClientProps) {
  const router = useRouter();
  const pathname = usePathname();

  // Первый рендер — список по умолчанию, тот же, что отдал сервер (страница
  // без `searchParams` не стримится, см. app/operators/page.tsx). Фильтры из
  // адреса читаются ПОСЛЕ монтирования: `useSearchParams` на сервере дал бы
  // другой первый HTML, чем у страницы, — расхождение гидратации.
  const [operators, setOperators] = useState<Operator[]>(initialItems ?? []);
  const [meta, setMeta] = useState<ApiMeta | null>(initialMeta);
  const [loading, setLoading] = useState(initialKey === null);
  /** Список не загрузился (сеть или база): это не «не найдено» (§4.0). */
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [activity, setActivity] = useState('');
  const [activities, setActivities] = useState<ActivityCount[] | null>(initialActivities);
  const [page, setPage] = useState(1);

  // Deep-link: ?search=&activity=&page= применяются один раз при входе.
  // Вид берётся, только если он есть среди видов живых туров: незнакомое
  // значение — без фильтра, а не пустая выдача. Прежний `?category=` (старые
  // ссылки на мёртвые кнопки) не читается вовсе — список без фильтра.
  const knownAtEntryRef = useRef<ActivityCount[] | null>(initialActivities);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    setSearch(sp.get('search') ?? '');
    const a = sp.get('activity') ?? '';
    setActivity(knownAtEntryRef.current?.some(x => x.activity_type === a) ? a : '');
    const p = parseInt(sp.get('page') ?? '1', 10);
    setPage(Number.isFinite(p) && p >= 1 ? p : 1);
  }, []);

  // Пока не «потрачен» — первый эффект с совпадающим ключом не рефетчит
  // (данные уже отрендерены сервером; иначе мигание и лишний запрос на вход).
  const initialKeyRef = useRef<string | null>(initialKey);

  const fetchOperators = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '12' });
      if (search) params.set('search', search);
      if (activity) params.set('activity', activity);
      const res = await fetch(`/api/operators?${params}`);
      const data = await res.json();
      if (data.success && data.degraded) {
        // База не ответила: прежний список не стираем и не выдаём за «не найдено».
        setFailed(true);
      } else if (data.success) {
        setFailed(false);
        setOperators(data.data);
        setMeta(data.meta);
        // Сбой подсчёта видов (null) не стирает кнопки, уже полученные раньше.
        if (Array.isArray(data.activities)) setActivities(data.activities);
      }
    } catch (err) {
      setFailed(true);
      console.error('[operators] список не обновился:', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [search, activity, page]);

  useEffect(() => {
    if (initialKeyRef.current !== null) {
      // Тот же формат ключа, что собирает RSC-страница.
      const currentKey = JSON.stringify({ search, activity, page });
      const matched = initialKeyRef.current === currentKey;
      initialKeyRef.current = null;
      if (matched) return;
    }
    const timer = setTimeout(() => void fetchOperators(), search ? 400 : 0);
    return () => clearTimeout(timer);
  }, [fetchOperators, search, activity, page]);

  // Href с фильтрами — реальные ссылки нужны ботам (Google не кликает JS);
  // клик человека перехватываем и остаёмся в SPA-режиме.
  const filterHref = useCallback((s: string, act: string, pg: number) => {
    const p = new URLSearchParams();
    if (s) p.set('search', s);
    if (act) p.set('activity', act);
    if (pg > 1) p.set('page', String(pg));
    return `${pathname}${p.size ? '?' + p : ''}`;
  }, [pathname]);

  // Sync URL — deep-link на текущие фильтры всегда актуален. Первый прогон
  // пропускается: состояние ещё умолчательное, а адрес мог нести фильтры —
  // переписать его здесь значило бы стереть их раньше, чем они применились.
  const urlSyncArmedRef = useRef(false);
  useEffect(() => {
    if (!urlSyncArmedRef.current) { urlSyncArmedRef.current = true; return; }
    router.replace(filterHref(search, activity, page), { scroll: false });
  }, [search, activity, page, filterHref, router]);

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      {/* Header */}
      <div className="bg-[var(--bg-card)] border-b border-[var(--border)]">
        <div className="max-w-6xl mx-auto px-4 py-10">
          <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-3">
            <Link href="/" className="hover:text-[var(--accent)]">Главная</Link>
            <ChevronRight className="w-3.5 h-3.5" />
            <span>Операторы</span>
          </div>
          <h1 className="font-playfair text-4xl font-bold text-[var(--text-primary)] mb-2">
            Операторы Камчатки
          </h1>
          <p className="text-[var(--text-secondary)] text-lg">
            {meta ? `Операторов на платформе: ${meta.total}` : 'Туристические операторы Камчатки'}
          </p>
          <p className="text-[var(--text-muted)] text-sm mt-1">{OPERATORS_ORDER_NOTE}</p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* Search + filter */}
        <div className="flex flex-col sm:flex-row gap-3 mb-8">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input
              type="text"
              placeholder="Поиск оператора..."
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              className="ds-input w-full pl-10"
            />
          </div>
          {activities && activities.length > 0 && (
            <nav className="flex gap-2 flex-wrap" aria-label="Виды туров">
              <Link
                href={filterHref(search, '', 1)}
                aria-current={activity === '' ? 'true' : undefined}
                onClick={e => { e.preventDefault(); setActivity(''); setPage(1); }}
                className={`${CHIP_BASE} ${activity === '' ? CHIP_ON : CHIP_OFF}`}
              >
                Все
              </Link>
              {activities.map(a => {
                const on = activity === a.activity_type;
                return (
                  <Link
                    key={a.activity_type}
                    href={filterHref(search, on ? '' : a.activity_type, 1)}
                    aria-current={on ? 'true' : undefined}
                    onClick={e => { e.preventDefault(); setActivity(on ? '' : a.activity_type); setPage(1); }}
                    className={`${CHIP_BASE} ${on ? CHIP_ON : CHIP_OFF}`}
                  >
                    {activityLabel(a.activity_type, true)} · {a.count}
                  </Link>
                );
              })}
            </nav>
          )}
        </div>

        {failed && (
          <p role="status" className="text-sm text-[var(--warning)] mb-4">
            Список сейчас не загрузился. Обновите страницу чуть позже.
          </p>
        )}

        {/* Grid */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="ds-card ds-skeleton h-64 rounded-xl" />
            ))}
          </div>
        ) : operators.length === 0 && !failed ? (
          <div className="text-center py-20">
            <MapPin className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
            <p className="text-[var(--text-secondary)] text-lg">Операторы не найдены</p>
            <p className="text-[var(--text-muted)] text-sm mt-1">Попробуйте изменить фильтры поиска</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {operators.map(op => {
              const facts = tourFactsLine(op.tourFacts);
              return (
              <Link
                key={op.id}
                href={`/operators/${op.slug}`}
                className="ds-card rounded-xl overflow-hidden hover:shadow-lg transition-all duration-200 hover:-translate-y-0.5 group"
              >
                {/* Hero image */}
                <div className="relative h-44 bg-[var(--bg-hover)] overflow-hidden">
                  {op.heroImage ? (
                    <Image
                      src={op.heroImage}
                      alt={op.name}
                      fill
                      className="object-cover group-hover:scale-105 transition-transform duration-300"
                      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <MapPin className="w-10 h-10 text-[var(--text-muted)]" />
                    </div>
                  )}
                  {op.isVerified && (
                    <div className="absolute top-3 right-3 bg-[var(--success)] text-white text-xs font-medium px-2 py-1 rounded-full flex items-center gap-1">
                      <ShieldCheck className="w-3 h-3" />
                      Проверен
                    </div>
                  )}
                </div>

                {/* Content */}
                <div className="p-4">
                  <h3 className="font-semibold text-[var(--text-primary)] text-base mb-1 line-clamp-1">
                    {op.name}
                  </h3>
                  {op.shortDescription && (
                    <p className="text-[var(--text-muted)] text-sm line-clamp-2 mb-3">
                      {op.shortDescription}
                    </p>
                  )}
                  {/* Чем компания занимается — по её живым турам (находка
                      PAVEL-operators, 15.10). Туров нет или посчитать не
                      удалось — строки нет, а не «0 туров». */}
                  {facts && (
                    <p className="text-sm text-[var(--text-secondary)] mb-3" data-testid="operator-tour-facts">
                      {facts}
                    </p>
                  )}
                  <OperatorRating
                    rating={op.rating}
                    reviewCount={op.reviewCount}
                    size="sm"
                  />
                </div>
              </Link>
              );
            })}
          </div>
        )}

        {/* Pagination (ссылки, не кнопки — SEO-обход) */}
        {meta && meta.pages > 1 && (
          <div className="flex justify-center gap-2 mt-10">
            {Array.from({ length: meta.pages }, (_, i) => i + 1).map(p => (
              <Link
                key={p}
                href={filterHref(search, activity, p)}
                onClick={e => { e.preventDefault(); setPage(p); }}
                className={`w-9 h-9 rounded-lg text-sm font-medium transition-colors flex items-center justify-center ${
                  p === page
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--bg-card)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--accent)]'
                }`}
              >
                {p}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

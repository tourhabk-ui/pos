'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, ShieldCheck, ChevronRight, MapPin } from 'lucide-react';
import { OperatorRating } from '@/components/operator/OperatorRating';

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
}

export interface ApiMeta {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

const CATEGORIES = [
  { value: '', label: 'Все' },
  { value: 'adventure', label: 'Активный отдых' },
  { value: 'fishing', label: 'Рыбалка' },
  { value: 'helicopter', label: 'Вертолётные туры' },
  { value: 'whale_watching', label: 'Морские экскурсии' },
  { value: 'trekking', label: 'Треккинг' },
];

interface OperatorsPageClientProps {
  /** Первый рендер с сервера (SEO): данные, снятые RSC-страницей /operators. */
  initialItems?: Operator[];
  initialMeta?: ApiMeta | null;
  /** Ключ фильтров серверного рендера — чтобы не дублировать fetch на маунте. */
  initialKey?: string | null;
}

export default function OperatorsPageClient({
  initialItems,
  initialMeta = null,
  initialKey = null,
}: OperatorsPageClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Deep-link фильтры должны работать одинаково для SSR и клиента.
  const [operators, setOperators] = useState<Operator[]>(initialItems ?? []);
  const [meta, setMeta] = useState<ApiMeta | null>(initialMeta);
  const [loading, setLoading] = useState(initialKey === null);
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [category, setCategory] = useState(searchParams.get('category') ?? '');
  const [page, setPage] = useState(() => {
    const p = parseInt(searchParams.get('page') ?? '1', 10);
    return Number.isFinite(p) && p >= 1 ? p : 1;
  });

  // Пока не «потрачен» — первый эффект с совпадающим ключом не рефетчит
  // (данные уже отрендерены сервером; иначе мигание и лишний запрос на вход).
  const initialKeyRef = useRef<string | null>(initialKey);

  const fetchOperators = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '12' });
      if (search) params.set('search', search);
      if (category) params.set('category', category);
      const res = await fetch(`/api/operators?${params}`);
      const data = await res.json();
      if (data.success) {
        setOperators(data.data);
        setMeta(data.meta);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [search, category, page]);

  useEffect(() => {
    if (initialKeyRef.current !== null) {
      // Тот же формат ключа, что собирает RSC-страница.
      const currentKey = JSON.stringify({ search, category, page });
      const matched = initialKeyRef.current === currentKey;
      initialKeyRef.current = null;
      if (matched) return;
    }
    const timer = setTimeout(() => void fetchOperators(), search ? 400 : 0);
    return () => clearTimeout(timer);
  }, [fetchOperators, search, category, page]);

  // Href с фильтрами — реальные ссылки нужны ботам (Google не кликает JS);
  // клик человека перехватываем и остаёмся в SPA-режиме.
  const filterHref = useCallback((s: string, cat: string, pg: number) => {
    const p = new URLSearchParams();
    if (s) p.set('search', s);
    if (cat) p.set('category', cat);
    if (pg > 1) p.set('page', String(pg));
    return `${pathname}${p.size ? '?' + p : ''}`;
  }, [pathname]);

  // Sync URL — deep-link на текущие фильтры всегда актуален.
  useEffect(() => {
    router.replace(filterHref(search, category, page), { scroll: false });
  }, [search, category, page, filterHref, router]);

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
            {meta ? `${meta.total} проверенных оператора` : 'Проверенные туристические операторы'}
          </p>
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
          <div className="flex gap-2 flex-wrap">
            {CATEGORIES.map(cat => (
              <Link
                key={cat.value}
                href={filterHref(search, cat.value, 1)}
                onClick={e => { e.preventDefault(); setCategory(cat.value); setPage(1); }}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                  category === cat.value
                    ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                    : 'bg-[var(--bg-card)] text-[var(--text-secondary)] border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
                }`}
              >
                {cat.label}
              </Link>
            ))}
          </div>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="ds-card ds-skeleton h-64 rounded-xl" />
            ))}
          </div>
        ) : operators.length === 0 ? (
          <div className="text-center py-20">
            <MapPin className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
            <p className="text-[var(--text-secondary)] text-lg">Операторы не найдены</p>
            <p className="text-[var(--text-muted)] text-sm mt-1">Попробуйте изменить фильтры поиска</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {operators.map(op => (
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
                  <OperatorRating
                    rating={op.rating}
                    reviewCount={op.reviewCount}
                    size="sm"
                  />
                </div>
              </Link>
            ))}
          </div>
        )}

        {/* Pagination (ссылки, не кнопки — SEO-обход) */}
        {meta && meta.pages > 1 && (
          <div className="flex justify-center gap-2 mt-10">
            {Array.from({ length: meta.pages }, (_, i) => i + 1).map(p => (
              <Link
                key={p}
                href={filterHref(search, category, p)}
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

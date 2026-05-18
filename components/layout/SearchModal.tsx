'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Search, X, MapPin, Route, ShoppingBag, Loader2 } from 'lucide-react';

interface PlaceResult {
  id: string;
  name: string;
  location_type: string;
  image_url: string | null;
}

interface TourResult {
  id: number;
  title: string;
  operator_name: string;
  base_price: number;
  tour_image: string | null;
  activity_type: string;
}

interface RouteResult {
  id: string;
  name: string;
  activity_type: string | null;
  distance_km: number | null;
}

const TYPE_LABELS: Record<string, string> = {
  volcano: 'Вулкан', lake: 'Озеро', hot_spring: 'Горячий источник',
  mountain: 'Гора', geyser: 'Гейзер', river: 'Река', beach: 'Пляж',
  forest: 'Лес', valley: 'Долина',
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SearchModal({ open, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<PlaceResult[]>([]);
  const [tours, setTours] = useState<TourResult[]>([]);
  const [routes, setRoutes] = useState<RouteResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const hasResults = places.length > 0 || tours.length > 0 || routes.length > 0;

  const doSearch = useCallback((q: string) => {
    abortRef.current?.abort();
    if (q.trim().length < 2) {
      setPlaces([]); setTours([]); setRoutes([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);

    const enc = encodeURIComponent(q.trim());

    Promise.all([
      fetch(`/api/routes?q=${enc}&kind=place&limit=4`, { signal: ctrl.signal })
        .then(r => r.json()).then(d => setPlaces(d.routes ?? []))
        .catch(() => {}),
      fetch(`/api/hub/marketplace/tours?search=${enc}&limit=4`, { signal: ctrl.signal })
        .then(r => r.json()).then(d => setTours(d.data ?? []))
        .catch(() => {}),
      fetch(`/api/routes?q=${enc}&kind=route&limit=4`, { signal: ctrl.signal })
        .then(r => r.json()).then(d => setRoutes(d.routes ?? []))
        .catch(() => {}),
    ]).finally(() => {
      if (!ctrl.signal.aborted) setLoading(false);
    });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => doSearch(query), 280);
    return () => clearTimeout(t);
  }, [query, doSearch]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
      setPlaces([]); setTours([]); setRoutes([]);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[env(safe-area-inset-top,0px)]"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-[var(--text-primary)]/40" />

      {/* Panel */}
      <div className="relative w-full max-w-xl mx-4 mt-16 bg-[var(--bg-card)] rounded-xl shadow-2xl border border-[var(--border)] overflow-hidden">

        {/* Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
          {loading
            ? <Loader2 className="w-4 h-4 text-[var(--text-muted)] animate-spin shrink-0" />
            : <Search className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
          }
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Поиск мест, маршрутов, туров..."
            className="flex-1 bg-transparent text-[var(--text-primary)] placeholder:text-[var(--text-muted)] text-sm outline-none"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <X className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onClose}
            className="text-xs text-[var(--text-muted)] bg-[var(--bg-hover)] px-2 py-1 rounded"
          >
            Esc
          </button>
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto">
          {query.trim().length >= 2 && !loading && !hasResults && (
            <div className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">
              Ничего не найдено по запросу «{query.trim()}»
            </div>
          )}

          {places.length > 0 && (
            <section className="px-4 pt-4 pb-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
                <MapPin className="w-3 h-3" /> Места
              </p>
              <div className="space-y-1">
                {places.map(p => (
                  <Link
                    key={p.id}
                    href={`/places/${p.id}`}
                    onClick={onClose}
                    className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <div className="w-10 h-10 rounded-md bg-[var(--bg-hover)] shrink-0 overflow-hidden relative">
                      {p.image_url
                        ? <Image src={p.image_url} alt={p.name} fill className="object-cover" sizes="40px" />
                        : <MapPin className="w-4 h-4 text-[var(--text-muted)] m-auto mt-3" />
                      }
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[var(--text-primary)] truncate">{p.name}</p>
                      <p className="text-xs text-[var(--text-muted)]">{TYPE_LABELS[p.location_type] ?? p.location_type}</p>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {routes.length > 0 && (
            <section className="px-4 pt-3 pb-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
                <Route className="w-3 h-3" /> Маршруты
              </p>
              <div className="space-y-1">
                {routes.map(r => (
                  <Link
                    key={r.id}
                    href={`/routes/${r.id}`}
                    onClick={onClose}
                    className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <div className="w-10 h-10 rounded-md bg-[var(--bg-hover)] shrink-0 flex items-center justify-center">
                      <Route className="w-4 h-4 text-[var(--text-muted)]" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[var(--text-primary)] truncate">{r.name}</p>
                      <p className="text-xs text-[var(--text-muted)]">
                        {[r.activity_type, r.distance_km ? `${r.distance_km} км` : null].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {tours.length > 0 && (
            <section className="px-4 pt-3 pb-4">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
                <ShoppingBag className="w-3 h-3" /> Туры
              </p>
              <div className="space-y-1">
                {tours.map(t => (
                  <Link
                    key={t.id}
                    href={`/marketplace/tours/${t.id}`}
                    onClick={onClose}
                    className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <div className="w-10 h-10 rounded-md bg-[var(--bg-hover)] shrink-0 overflow-hidden relative">
                      {t.tour_image
                        ? <Image src={t.tour_image} alt={t.title} fill className="object-cover" sizes="40px" />
                        : <ShoppingBag className="w-4 h-4 text-[var(--text-muted)] m-auto mt-3" />
                      }
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-[var(--text-primary)] truncate">{t.title}</p>
                      <p className="text-xs text-[var(--text-muted)] truncate">{t.operator_name}</p>
                    </div>
                    <p className="text-sm font-semibold text-[var(--accent)] shrink-0">
                      {t.base_price.toLocaleString('ru')} ₽
                    </p>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {!query.trim() && (
            <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
              Начните вводить название места, маршрута или тура
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { MapPin, Route, TrendingUp, Eye } from 'lucide-react';
import { locationTypeLabel } from '@/lib/places/location-types';
import type { TrendingPlace, TrendingRoute } from '@/lib/trending/load';

const DIFFICULTY_LABELS: Record<string, string> = {
  easy: 'Лёгкий', moderate: 'Средний', hard: 'Сложный', extreme: 'Экстрим',
};

/**
 * Списки приходят с сервера (page.tsx → lib/trending/load): прежде их тянул
 * браузер, и поисковик видел 21–23 слова вместо мест (аудит 01.10). Здесь
 * остаётся только переключение вкладок. failed — сервер не смог прочитать
 * списки; это не «популярного нет» (§4.0).
 */
export function TrendingClient({ places, routes, failed }: {
  places: TrendingPlace[];
  routes: TrendingRoute[];
  failed: boolean;
}) {
  const [tab, setTab] = useState<'places' | 'routes'>('places');

  return (
    <main className="ds-page min-h-screen pb-12">
      <div className="max-w-6xl mx-auto px-4">
        <header className="mb-10">
          <div className="flex items-center gap-2 text-[var(--accent)] font-semibold text-sm uppercase tracking-widest mb-2">
            <TrendingUp className="w-4 h-4" />
            Популярное
          </div>
          <h1 className="ds-h1 mb-3">Что смотрят прямо сейчас</h1>
          <p className="text-[var(--text-secondary)] text-lg max-w-2xl">
            Самые востребованные места и маршруты Камчатки
          </p>
        </header>

        <div className="flex gap-2 mb-8">
          {(['places', 'routes'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`ds-btn ${tab === t ? 'ds-btn-primary' : 'ds-btn-secondary'} flex items-center gap-2`}
            >
              {t === 'places' ? <><MapPin className="w-4 h-4" /> Места</> : <><Route className="w-4 h-4" /> Маршруты</>}
            </button>
          ))}
        </div>

        {failed ? (
          <div className="ds-card p-10 text-center">
            <p className="text-[var(--text-secondary)]">Не удалось загрузить популярное. Обновите страницу.</p>
          </div>
        ) : tab === 'places' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {places.map((p, idx) => (
              <Link key={p.id} href={`/places/${p.slug ?? p.id}`} className="ds-card group block hover:shadow-md transition-all duration-200">
                <div className="relative">
                  {p.image_url ? (
                    <img src={p.image_url} alt={p.name} className="w-full h-40 object-cover rounded-t-lg" />
                  ) : (
                    <div className="w-full h-40 rounded-t-lg bg-[var(--bg-hover)] flex items-center justify-center">
                      <MapPin className="w-8 h-8 text-[var(--text-muted)]" />
                    </div>
                  )}
                  <span className="absolute top-2 left-2 bg-[var(--accent)] text-white text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center">
                    {idx + 1}
                  </span>
                </div>
                <div className="p-4">
                  <p className="text-xs text-[var(--accent)] font-semibold uppercase tracking-wide mb-1">
                    {locationTypeLabel(p.location_type)}
                  </p>
                  <h3 className="font-playfair font-bold text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                    {p.name}
                  </h3>
                  <p className="text-xs text-[var(--text-muted)] mt-1 flex items-center gap-1">
                    <Eye className="w-3 h-3" /> {p.view_count.toLocaleString('ru')}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {routes.map((r, idx) => (
              <Link key={r.id} href={`/routes/${r.slug ?? r.id}`} className="ds-card group block p-4 hover:shadow-md transition-all duration-200">
                <div className="flex items-start gap-3">
                  <span className="text-[var(--accent)] font-bold text-2xl font-playfair shrink-0 w-8">
                    {idx + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {r.difficulty && (
                        <span className="ds-badge text-xs">{DIFFICULTY_LABELS[r.difficulty] ?? r.difficulty}</span>
                      )}
                    </div>
                    <h3 className="font-playfair font-bold text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors truncate">
                      {r.title}
                    </h3>
                    <div className="flex gap-3 text-xs text-[var(--text-secondary)] mt-1">
                      {r.distance_km && <span>{r.distance_km} км</span>}
                      {r.duration_hours && <span>{r.duration_hours} ч</span>}
                      <span className="flex items-center gap-1 ml-auto text-[var(--text-muted)]">
                        <Eye className="w-3 h-3" /> {r.view_count.toLocaleString('ru')}
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

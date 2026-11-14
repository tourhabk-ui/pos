'use client';

/**
 * «Анализатор безопасности» (/tools/safety) — форма.
 *
 * Человек выбирает место или маршрут по названию либо нажимает GPS. Ответ
 * рисует `SafetyToolResult` — теми же блоками, что карточка места и карточка
 * маршрута: своей оценки у инструмента нет (слово владельца 14.11).
 */

import React, { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { Search, MapPin, ShieldCheck, ChevronLeft, AlertTriangle, Navigation, Route } from 'lucide-react';
import { SafetyToolResult, type SafetyToolAnswer } from '@/components/tools/SafetyToolResult';
/** Подписи — из единых словарей (lib/tours/labels, lib/places/type-label), своих копий не держим. */
import { activityLabel } from '@/lib/tours/labels';
import { placeTypeLabel } from '@/lib/places/type-label';
import { requestPosition, geoFailureText } from '@/lib/geo/current-position';

type Mode = 'place' | 'route';

interface PlaceHit {
  id: string;
  name: string;
  locationType: string | null;
  description: string;
}

interface RouteHit {
  id: string;
  title: string;
  activityType: string | null;
  difficulty: string | null;
  distanceKm: number | null;
}

/** Поиск не ответил — это не «ничего не найдено» (§4.0): говорим словами. */
const SEARCH_FAILED = 'Поиск не ответил — попробуйте ещё раз';

export function SafetyClient() {
  const [mode, setMode] = useState<Mode>('place');
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<PlaceHit[]>([]);
  const [routeSuggestions, setRouteSuggestions] = useState<RouteHit[]>([]);
  const [selectedPlace, setSelectedPlace] = useState<PlaceHit | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<RouteHit | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SafetyToolAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetSelection = () => {
    setSelectedPlace(null);
    setSelectedRoute(null);
    setQuery('');
    setSuggestions([]);
    setRouteSuggestions([]);
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    resetSelection();
    setResult(null);
    setError(null);
  };

  const handleQueryChange = useCallback((value: string, currentMode: Mode) => {
    setQuery(value);
    setSelectedPlace(null);
    setSelectedRoute(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) { setSuggestions([]); setRouteSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const url = currentMode === 'place'
          ? `/api/places?q=${encodeURIComponent(value)}&limit=6`
          : `/api/routes?q=${encodeURIComponent(value)}&limit=6`;
        const res = await fetch(url);
        const json = await res.json() as { success: boolean; data?: unknown };
        if (!res.ok || !json.success || !Array.isArray(json.data)) {
          setError(SEARCH_FAILED);
          return;
        }
        setError(null);
        if (currentMode === 'place') setSuggestions(json.data as PlaceHit[]);
        else setRouteSuggestions(json.data as RouteHit[]);
      } catch {
        setError(SEARCH_FAILED);
      }
    }, 280);
  }, []);

  const analyze = async (body: Record<string, unknown>) => {
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch('/api/tools/safety', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json() as { success: boolean; data?: SafetyToolAnswer; error?: string };
      if (json.success && json.data) {
        setResult(json.data);
      } else {
        setError(json.error ?? 'Ошибка, попробуйте ещё раз');
      }
    } catch {
      setError('Нет соединения с сервером');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'route' && selectedRoute) {
      void analyze({ routeId: selectedRoute.id });
    } else if (mode === 'place' && selectedPlace) {
      void analyze({ placeId: selectedPlace.id });
    }
  };

  const canSubmit = mode === 'route' ? !!selectedRoute : !!selectedPlace;

  const handleGPS = async () => {
    setGpsLoading(true);
    setError(null);
    // Один вход с разбором причины (lib/geo/current-position): запрет лечится
    // настройками, таймаут — повтором, и это разные слова.
    const pos = await requestPosition();
    setGpsLoading(false);
    if (!pos.ok) { setError(geoFailureText(pos.kind)); return; }
    void analyze({ lat: pos.lat, lng: pos.lng });
  };

  return (
    <div className="bg-[var(--bg-primary)] min-h-screen py-12">
      <div className="container mx-auto px-6 max-w-2xl">

        <Link href="/tools" className="inline-flex items-center gap-2 text-[var(--text-muted)] hover:text-[var(--text-secondary)] text-sm mb-8 transition-colors">
          <ChevronLeft size={16} />
          Все инструменты
        </Link>

        <div className="mb-8">
          <span className="text-[var(--accent)] font-bold tracking-[0.4em] uppercase text-[10px] mb-3 inline-block">
            Мини-инструмент
          </span>
          <h1 className="font-playfair text-3xl md:text-4xl font-bold text-[var(--text-primary)] mb-2">
            Анализатор безопасности
          </h1>
          <p className="text-[var(--text-secondary)] text-sm font-light">
            Выберите место или маршрут либо нажмите GPS — покажем ту же оценку на сегодня, что на его карточке
          </p>
        </div>

        {!result && (
          <form onSubmit={handleSubmit} className="space-y-4">

            <div className="flex gap-2 p-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl">
              <button
                type="button"
                onClick={() => switchMode('place')}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all ${
                  mode === 'place'
                    ? 'bg-[var(--accent)] text-white shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <MapPin size={15} /> Точка
              </button>
              <button
                type="button"
                onClick={() => switchMode('route')}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all ${
                  mode === 'route'
                    ? 'bg-[var(--accent)] text-white shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Route size={15} /> Маршрут
              </button>
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-[0.2em] text-[var(--text-muted)] mb-2">
                {mode === 'place' ? 'Место' : 'Маршрут'}
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                  <input
                    type="text"
                    value={(mode === 'place' ? selectedPlace?.name : selectedRoute?.title) ?? query}
                    onChange={e => handleQueryChange(e.target.value, mode)}
                    onFocus={() => { if (selectedPlace || selectedRoute) resetSelection(); }}
                    placeholder={mode === 'place' ? 'Авачинский вулкан, Халактырский пляж...' : 'Налычево, Мутновский, Ключевской...'}
                    className="ds-input pl-9 w-full"
                    autoComplete="off"
                  />

                  {mode === 'place' && suggestions.length > 0 && !selectedPlace && (
                    <div className="absolute z-10 w-full mt-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden shadow-lg">
                      {suggestions.map(s => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => { setSelectedPlace(s); setQuery(s.name); setSuggestions([]); }}
                          className="w-full text-left px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors border-b border-[var(--border)] last:border-0"
                        >
                          <p className="text-sm font-medium text-[var(--text-primary)] leading-tight">{s.name}</p>
                          {placeTypeLabel(s.locationType) && (
                            <p className="text-xs text-[var(--text-muted)] mt-0.5">{placeTypeLabel(s.locationType)}</p>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {mode === 'route' && routeSuggestions.length > 0 && !selectedRoute && (
                    <div className="absolute z-10 w-full mt-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden shadow-lg">
                      {routeSuggestions.map(r => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => { setSelectedRoute(r); setQuery(r.title); setRouteSuggestions([]); }}
                          className="w-full text-left px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors border-b border-[var(--border)] last:border-0"
                        >
                          <p className="text-sm font-medium text-[var(--text-primary)] leading-tight">{r.title}</p>
                          <p className="text-xs text-[var(--text-muted)] mt-0.5">
                            {[activityLabel(r.activityType), r.distanceKm ? `${r.distanceKm} км` : null].filter(Boolean).join(' · ')}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* GPS — только для точек */}
                {mode === 'place' && (
                  <button
                    type="button"
                    onClick={() => { void handleGPS(); }}
                    disabled={gpsLoading}
                    title="Использовать моё местоположение"
                    className="ds-btn ds-btn-secondary flex-shrink-0 flex items-center gap-1.5 px-4"
                  >
                    {gpsLoading
                      ? <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      : <Navigation size={16} />
                    }
                    <span className="hidden sm:inline text-sm">GPS</span>
                  </button>
                )}
              </div>
            </div>

            {error && (
              <p role="alert" className="text-sm text-[var(--danger)] flex items-center gap-2">
                <AlertTriangle size={14} /> {error}
              </p>
            )}

            <button
              type="submit"
              disabled={!canSubmit || loading}
              className="ds-btn ds-btn-primary w-full flex items-center justify-center gap-2 py-3 disabled:opacity-40"
            >
              {loading ? (
                <>
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Читаю обстановку...
                </>
              ) : (
                <>
                  <ShieldCheck size={18} />
                  Проверить безопасность
                </>
              )}
            </button>
          </form>
        )}

        {loading && !result && (
          <div className="mt-8 space-y-4" aria-hidden="true">
            <div className="ds-skeleton h-20 rounded-lg" />
            <div className="ds-skeleton h-24 rounded-lg" />
            <div className="ds-skeleton h-24 rounded-lg" />
          </div>
        )}

        {result && !loading && (
          <SafetyToolResult
            answer={result}
            onReset={() => { setResult(null); resetSelection(); }}
          />
        )}
      </div>
    </div>
  );
}

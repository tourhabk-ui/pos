'use client';

import React, { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { Search, MapPin, ShieldCheck, ChevronLeft, AlertTriangle, AlertCircle, CheckCircle, Navigation, Route } from 'lucide-react';
import { HazardBadgeStrip } from '@/components/shared/HazardBadgeStrip';

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

interface Realtime {
  isOpen: boolean | null;
  alertSeverity: number | null;
  alertMessage: string | null;
  currentCrowds: number | null;
  activeAlerts: string[] | null;
}

interface SafetyResult {
  placeId: string;
  placeName: string;
  placeType: string | null;
  altitudeM: number | null;
  hazards: string[];
  nearestMedicalKm: number | null;
  satCommunicator: boolean;
  registrationRequired: boolean;
  realtime: Realtime | null;
  riskScore: number;
  kuzmichAssessment: string | null;
  recommendations: string[];
  emergencyTip: string | null;
}

const RISK_CONFIG = [
  { score: 1, label: 'Низкий риск', color: 'var(--success)' },
  { score: 2, label: 'Умеренный риск', color: 'var(--ocean)' },
  { score: 3, label: 'Повышенный риск', color: 'var(--warning)' },
  { score: 4, label: 'Высокий риск', color: 'var(--danger)' },
  { score: 5, label: 'Экстремальный риск', color: 'var(--danger)' },
];

const LOCATION_LABELS: Record<string, string> = {
  volcano: 'Вулкан', lake: 'Озеро', hot_spring: 'Термальный источник',
  mountain: 'Гора', geyser: 'Гейзер', valley: 'Долина', coast: 'Побережье',
  river: 'Река', forest: 'Лес', pass: 'Перевал',
};

const ACTIVITY_LABELS: Record<string, string> = {
  trekking: 'Треккинг', fishing: 'Рыбалка', thermal: 'Термальные',
  winter_hiking: 'Зимний поход', sightseeing: 'Осмотр', ski: 'Лыжи',
};

export function SafetyClient() {
  const [mode, setMode] = useState<Mode>('place');
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<PlaceHit[]>([]);
  const [routeSuggestions, setRouteSuggestions] = useState<RouteHit[]>([]);
  const [selectedPlace, setSelectedPlace] = useState<PlaceHit | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<RouteHit | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SafetyResult | null>(null);
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
        if (currentMode === 'place') {
          const res = await fetch(`/api/places?q=${encodeURIComponent(value)}&limit=6`);
          const json = await res.json() as { success: boolean; data: PlaceHit[] };
          if (json.success) setSuggestions(json.data);
        } else {
          const res = await fetch(`/api/routes?q=${encodeURIComponent(value)}&limit=6`);
          const json = await res.json() as { success: boolean; data: RouteHit[] };
          if (json.success) setRouteSuggestions(json.data);
        }
      } catch { /* silent */ }
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
      const json = await res.json() as { success: boolean; data?: SafetyResult; error?: string };
      if (json.success && json.data) {
        setResult(json.data);
      } else {
        setError(json.error ?? 'Ошибка, попробуй ещё раз');
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

  const handleGPS = () => {
    if (!navigator.geolocation) { setError('GPS недоступен на этом устройстве'); return; }
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      pos => {
        setGpsLoading(false);
        void analyze({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => { setGpsLoading(false); setError('Не удалось получить геолокацию'); }
    );
  };

  const riskCfg = result ? (RISK_CONFIG[result.riskScore - 1] ?? RISK_CONFIG[0]) : null;

  return (
    <div className="bg-[var(--bg-primary)] min-h-screen py-12">
      <div className="container mx-auto px-6 max-w-2xl">

        {/* Back */}
        <Link href="/tools" className="inline-flex items-center gap-2 text-[var(--text-muted)] hover:text-[var(--text-secondary)] text-sm mb-8 transition-colors">
          <ChevronLeft size={16} />
          Все инструменты
        </Link>

        {/* Header */}
        <div className="mb-8">
          <span className="text-[var(--accent)] font-bold tracking-[0.4em] uppercase text-[10px] mb-3 inline-block">
            Мини-инструмент
          </span>
          <h1 className="font-playfair text-3xl md:text-4xl font-bold text-[var(--text-primary)] mb-2">
            Анализатор безопасности
          </h1>
          <p className="text-[var(--text-secondary)] text-sm font-light">
            Введи название места или используй GPS — получи реальную оценку рисков
          </p>
        </div>

        {/* Form */}
        {!result && (
          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Mode toggle */}
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

                  {/* Place suggestions */}
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
                          {s.locationType && (
                            <p className="text-xs text-[var(--text-muted)] mt-0.5">
                              {LOCATION_LABELS[s.locationType] ?? s.locationType}
                            </p>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Route suggestions */}
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
                            {[ACTIVITY_LABELS[r.activityType ?? ''] ?? r.activityType, r.distanceKm ? `${r.distanceKm} км` : null].filter(Boolean).join(' · ')}
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
                    onClick={handleGPS}
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
              <p className="text-sm text-[var(--danger)] flex items-center gap-2">
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
                  Анализирую...
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

        {/* Skeleton */}
        {loading && !result && (
          <div className="mt-8 space-y-4">
            <div className="ds-skeleton h-20 rounded-lg" />
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5 space-y-3">
              {[80, 60, 70, 50, 65].map((w, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="ds-skeleton h-3 w-3 rounded-full flex-shrink-0" />
                  <div className={`ds-skeleton h-3`} style={{ width: `${w}%` }} />
                </div>
              ))}
            </div>
            <div className="ds-skeleton h-24 rounded-lg" />
          </div>
        )}

        {/* Results */}
        {result && !loading && riskCfg && (
          <div className="space-y-5">
            {/* Risk score header */}
            <div
              className="bg-[var(--bg-card)] border rounded-lg p-6"
              style={{ borderColor: `color-mix(in srgb, ${riskCfg.color} 40%, transparent)` }}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[var(--text-muted)] text-[10px] uppercase tracking-[0.3em] font-bold mb-1">
                    {LOCATION_LABELS[result.placeType ?? ''] ?? result.placeType ?? 'Место'}
                  </p>
                  <h2 className="font-playfair text-2xl font-bold text-[var(--text-primary)]">
                    {result.placeName}
                  </h2>
                  {result.altitudeM && (
                    <p className="text-sm text-[var(--text-muted)] mt-0.5">{result.altitudeM.toLocaleString('ru-RU')} м</p>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <div
                    className="text-2xl font-bold font-playfair"
                    style={{ color: riskCfg.color }}
                  >
                    {result.riskScore}/5
                  </div>
                  <div className="text-xs font-bold mt-0.5" style={{ color: riskCfg.color }}>
                    {riskCfg.label}
                  </div>
                </div>
              </div>

              {/* Alert */}
              {result.realtime?.alertSeverity != null && result.realtime.alertSeverity > 0 && (
                <div className="mt-4 flex gap-2 text-sm" style={{ color: 'var(--warning)' }}>
                  <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                  <span>{result.realtime.alertMessage ?? 'Повышенная осторожность'}</span>
                </div>
              )}
            </div>

            {/* Hazard badges */}
            {result.hazards.length > 0 && (
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
                <p className="text-[10px] uppercase tracking-[0.3em] text-[var(--text-muted)] font-bold mb-3">
                  Опасности
                </p>
                <HazardBadgeStrip
                  hazards={result.hazards}
                  mchsRequired={result.registrationRequired}
                />
              </div>
            )}

            {/* Kuzmich assessment */}
            {result.kuzmichAssessment && (
              <div className="bg-[var(--accent)]/5 border border-[var(--accent)]/20 rounded-lg p-5">
                <p className="text-[10px] uppercase tracking-[0.3em] text-[var(--text-muted)] font-bold mb-2">
                  Кузьмич говорит
                </p>
                <p className="text-sm text-[var(--text-primary)] leading-relaxed">
                  {result.kuzmichAssessment}
                </p>
              </div>
            )}

            {/* Recommendations */}
            {result.recommendations.length > 0 && (
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
                <div className="px-5 py-3 border-b border-[var(--border)] bg-[var(--bg-hover)]">
                  <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--text-secondary)]">
                    Рекомендации
                  </h3>
                </div>
                <ul className="divide-y divide-[var(--border)]">
                  {result.recommendations.map((rec, i) => (
                    <li key={i} className="px-5 py-3 flex items-start gap-3">
                      <CheckCircle size={15} className="text-[var(--success)] flex-shrink-0 mt-0.5" />
                      <span className="text-sm text-[var(--text-primary)]">{rec}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Emergency tip */}
            {result.emergencyTip && (
              <div className="bg-[var(--bg-card)] border border-[var(--danger)]/30 rounded-lg p-4 flex gap-3">
                <AlertTriangle size={16} className="text-[var(--danger)] flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--danger)] font-bold mb-1">ЧС</p>
                  <p className="text-sm text-[var(--text-primary)]">{result.emergencyTip}</p>
                </div>
              </div>
            )}

            {/* Meta */}
            <div className="flex items-center justify-between text-xs text-[var(--text-muted)] pt-2">
              {result.nearestMedicalKm != null && (
                <span className="flex items-center gap-1.5">
                  <MapPin size={12} />
                  Медпомощь: {result.nearestMedicalKm} км
                </span>
              )}
              <button
                onClick={() => { setResult(null); setSelectedPlace(null); setQuery(''); }}
                className="ml-auto text-[var(--accent)] hover:underline"
              >
                Новый запрос
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import React, { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { Search, Calendar, Backpack, ChevronLeft, AlertTriangle, CheckCircle, Circle } from 'lucide-react';

interface RouteHit {
  id: string;
  title: string;
  category: string | null;
  locationType: string | null;
  difficulty: string | null;
}

interface GearItem {
  name: string;
  required: boolean;
  note?: string;
}

interface GearCategory {
  id: string;
  name: string;
  items: GearItem[];
}

interface Checklist {
  summary: string;
  categories: GearCategory[];
  warnings: string[];
  tip: string;
}

interface Result {
  routeTitle: string;
  dateFrom: string;
  season: string;
  checklist: Checklist;
}

export function EquipmentClient() {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<RouteHit[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<RouteHit | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    setSelectedRoute(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/routes?q=${encodeURIComponent(value)}&limit=6`);
        const json = await res.json() as { success: boolean; data: RouteHit[] };
        if (json.success) setSuggestions(json.data);
      } catch { /* silent */ }
    }, 280);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRoute || !dateFrom) return;
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch('/api/tools/equipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routeId: selectedRoute.id, dateFrom }),
      });
      const json = await res.json() as { success: boolean; data?: Result; error?: string };
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
            Чек-лист снаряжения
          </h1>
          <p className="text-[var(--text-secondary)] text-sm font-light">
            Выбери маршрут и дату — Кузьмич составит список с учётом сезона и рельефа
          </p>
        </div>

        {/* Form */}
        {!result && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Route autocomplete */}
            <div className="relative">
              <label className="block text-xs font-bold uppercase tracking-[0.2em] text-[var(--text-muted)] mb-2">
                Маршрут
              </label>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  type="text"
                  value={selectedRoute ? selectedRoute.title : query}
                  onChange={e => handleQueryChange(e.target.value)}
                  onFocus={() => { if (selectedRoute) { setSelectedRoute(null); setQuery(''); } }}
                  placeholder="Мутновский вулкан, хели-ски, медведи..."
                  className="ds-input pl-9 w-full"
                  autoComplete="off"
                />
              </div>
              {suggestions.length > 0 && !selectedRoute && (
                <div className="absolute z-10 w-full mt-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden shadow-lg">
                  {suggestions.map(s => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => { setSelectedRoute(s); setQuery(s.title); setSuggestions([]); }}
                      className="w-full text-left px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors border-b border-[var(--border)] last:border-0"
                    >
                      <p className="text-sm font-medium text-[var(--text-primary)] leading-tight">{s.title}</p>
                      {(s.category || s.locationType) && (
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">
                          {[s.category, s.locationType].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Date */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-[0.2em] text-[var(--text-muted)] mb-2">
                Дата поездки
              </label>
              <div className="relative">
                <Calendar size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  type="date"
                  value={dateFrom}
                  onChange={e => setDateFrom(e.target.value)}
                  className="ds-input pl-9 w-full"
                />
              </div>
            </div>

            {error && (
              <p className="text-sm text-[var(--danger)] flex items-center gap-2">
                <AlertTriangle size={14} /> {error}
              </p>
            )}

            <button
              type="submit"
              disabled={!selectedRoute || !dateFrom || loading}
              className="ds-btn ds-btn-primary w-full flex items-center justify-center gap-2 py-3 disabled:opacity-40"
            >
              {loading ? (
                <>
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Кузьмич составляет список...
                </>
              ) : (
                <>
                  <Backpack size={18} />
                  Составить чек-лист
                </>
              )}
            </button>
          </form>
        )}

        {/* Skeleton */}
        {loading && !result && (
          <div className="mt-8 space-y-4">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
                <div className="ds-skeleton h-4 w-32 mb-3" />
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, j) => (
                    <div key={j} className="ds-skeleton h-3 w-full" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Results */}
        {result && !loading && (
          <div className="space-y-6">
            {/* Summary */}
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6">
              <p className="text-[var(--text-muted)] text-[10px] uppercase tracking-[0.3em] font-bold mb-1">
                {result.routeTitle} · {result.season}
              </p>
              <p className="text-[var(--text-primary)] text-sm leading-relaxed">{result.checklist.summary}</p>
            </div>

            {/* Warnings */}
            {result.checklist.warnings.length > 0 && (
              <div className="bg-[var(--bg-card)] border border-[var(--warning)]/40 rounded-lg p-4 flex gap-3">
                <AlertTriangle size={18} className="text-[var(--warning)] flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  {result.checklist.warnings.map((w, i) => (
                    <p key={i} className="text-sm text-[var(--warning)]">{w}</p>
                  ))}
                </div>
              </div>
            )}

            {/* Categories */}
            {result.checklist.categories.map(cat => (
              <div key={cat.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
                <div className="px-5 py-3 border-b border-[var(--border)] bg-[var(--bg-hover)]">
                  <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--text-secondary)]">
                    {cat.name}
                  </h3>
                </div>
                <ul className="divide-y divide-[var(--border)]">
                  {cat.items.map((item, i) => (
                    <li key={i} className="px-5 py-3 flex items-start gap-3">
                      {item.required
                        ? <CheckCircle size={16} className="text-[var(--accent)] flex-shrink-0 mt-0.5" />
                        : <Circle size={16} className="text-[var(--text-muted)] flex-shrink-0 mt-0.5" />
                      }
                      <div className="min-w-0">
                        <span className="text-sm text-[var(--text-primary)]">{item.name}</span>
                        {item.note && (
                          <span className="ml-2 text-xs text-[var(--text-muted)]">{item.note}</span>
                        )}
                      </div>
                      {!item.required && (
                        <span className="ml-auto text-[10px] text-[var(--text-muted)] flex-shrink-0">по желанию</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {/* Kuzmich tip */}
            {result.checklist.tip && (
              <div className="bg-[var(--accent)]/5 border border-[var(--accent)]/20 rounded-lg p-5">
                <p className="text-[var(--text-muted)] text-[10px] uppercase tracking-[0.3em] font-bold mb-2">
                  Кузьмич советует
                </p>
                <p className="text-sm text-[var(--text-primary)] italic leading-relaxed">
                  &ldquo;{result.checklist.tip}&rdquo;
                </p>
              </div>
            )}

            {/* Legend + Reset */}
            <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
              <span className="flex items-center gap-4">
                <span className="flex items-center gap-1.5"><CheckCircle size={12} className="text-[var(--accent)]" /> Обязательно</span>
                <span className="flex items-center gap-1.5"><Circle size={12} /> По желанию</span>
              </span>
              <button
                onClick={() => { setResult(null); setSelectedRoute(null); setQuery(''); setDateFrom(''); }}
                className="text-[var(--accent)] hover:underline"
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

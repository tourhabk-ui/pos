'use client';

/**
 * Чек-лист снаряжения (/tools/equipment). С 21.11 список собирается из
 * данных маршрута без модели (lib/preparation/gear-checklist.ts, слово владельца
 * «го»): ответ сразу, своих слов и советов нет.
 *
 * Почему с этой страницы уходили (перепись 21.11, код):
 *   — кнопка молча не нажималась, пока маршрут не выбран из подсказок, а
 *     подсказка поля звала писать свободным текстом («…медведи»);
 *   — подсказки появлялись только после набора, вперемешку места и маршруты;
 *   — после списка не было следующего шага.
 * Теперь: популярные маршруты видны при нажатии на поле, в подсказках только
 * маршруты, у недоступной кнопки сказано, чего не хватает, под списком —
 * карточка маршрута, подготовка к выходу, прокат снаряжения и печать.
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { Search, Calendar, Backpack, ChevronLeft, AlertTriangle, CheckCircle, Circle, Printer, MessageCircle } from 'lucide-react';
import type { GearChecklist } from '@/lib/preparation/gear-checklist';
import { kuzmichAskHref } from '@/lib/kuzmich/ask-link';

interface RouteHit {
  id: string;
  title: string;
}

type Result = GearChecklist & { dateFrom: string; essentialsSource: string };

/** Подсказки поля: только маршруты. Пустой запрос — популярные. */
export function routeSuggestUrl(q: string): string {
  const query = q.trim();
  return query
    ? `/api/routes?kind=route&q=${encodeURIComponent(query)}&limit=6`
    : '/api/routes?kind=route&sort=recommended&limit=6';
}

/** Чего не хватает до кнопки — словами; всё есть — null. */
export function missingForSubmit(route: RouteHit | null, date: string): string | null {
  if (!route && !date) return 'Выберите маршрут из списка и дату поездки';
  if (!route) return 'Выберите маршрут из списка под полем';
  if (!date) return 'Укажите дату поездки';
  return null;
}

function isRouteHits(v: unknown): v is RouteHit[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'object' && x !== null && typeof (x as RouteHit).id === 'string' && typeof (x as RouteHit).title === 'string');
}

export function EquipmentClient() {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<RouteHit[]>([]);
  const [suggestState, setSuggestState] = useState<'idle' | 'loading' | 'empty' | 'failed'>('idle');
  const [open, setOpen] = useState(false);
  const [selectedRoute, setSelectedRoute] = useState<RouteHit | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Deep-link из «Подготовки к походу» и кабинета: ?routeId= и ?date=.
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const qd = qs.get('date');
    if (qd && /^\d{4}-\d{2}-\d{2}$/.test(qd)) setDateFrom(qd);
    const rid = qs.get('routeId');
    if (!rid || !/^[0-9a-f-]{36}$/.test(rid)) return;
    fetch(`/api/routes/${rid}`)
      .then((r) => r.json())
      .then((j: unknown) => {
        if (typeof j !== 'object' || j === null || !(j as Record<string, unknown>).success) return;
        const data = (j as Record<string, unknown>).data as Record<string, unknown>;
        if (typeof data.title !== 'string') return;
        setSelectedRoute({ id: rid, title: data.title });
        setQuery(data.title);
      })
      .catch(() => { /* нет сети — человек выберет маршрут сам, поле ему это скажет */ });
  }, []);

  const loadSuggestions = useCallback(async (value: string) => {
    setSuggestState('loading');
    try {
      const res = await fetch(routeSuggestUrl(value));
      const json = await res.json() as { success?: boolean; data?: unknown };
      if (!res.ok || !json.success || !isRouteHits(json.data)) throw new Error(`HTTP ${res.status}`);
      setSuggestions(json.data);
      setSuggestState(json.data.length > 0 ? 'idle' : 'empty');
    } catch {
      setSuggestions([]);
      setSuggestState('failed');
    }
  }, []);

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    setSelectedRoute(null);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void loadSuggestions(value); }, 280);
  }, [loadSuggestions]);

  const handleFocus = () => {
    if (selectedRoute) return;
    setOpen(true);
    if (suggestions.length === 0 && suggestState !== 'loading') void loadSuggestions(query);
  };

  const pick = (s: RouteHit) => {
    setSelectedRoute(s);
    setQuery(s.title);
    setOpen(false);
  };

  const missing = missingForSubmit(selectedRoute, dateFrom);

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
      if (json.success && json.data) setResult(json.data);
      else setError(json.error ?? 'Не получилось — попробуйте ещё раз');
    } catch {
      setError('Нет соединения с сервером');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-[var(--bg-primary)] min-h-screen py-12">
      <div className="container mx-auto px-6 max-w-2xl">
        <Link href="/tools" className="inline-flex items-center gap-2 text-[var(--text-muted)] hover:text-[var(--text-secondary)] text-sm mb-8 transition-colors print:hidden">
          <ChevronLeft size={16} />
          Все инструменты
        </Link>

        <div className="mb-8">
          <span className="text-[var(--accent)] font-bold tracking-[0.4em] uppercase text-[10px] mb-3 inline-block print:hidden">
            Мини-инструмент
          </span>
          <h1 className="font-playfair text-3xl md:text-4xl font-bold text-[var(--text-primary)] mb-2">
            Чек-лист снаряжения
          </h1>
          <p className="text-[var(--text-secondary)] text-sm">
            Выберите маршрут и дату — список соберётся из паспорта маршрута: снаряжение, опасности, обязательные шаги.
          </p>
        </div>

        {!result && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <label htmlFor="gear-route" className="block text-xs font-bold uppercase tracking-[0.2em] text-[var(--text-muted)] mb-2">
                Маршрут
              </label>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden="true" />
                <input
                  id="gear-route"
                  type="text"
                  value={query}
                  onChange={(e) => handleQueryChange(e.target.value)}
                  onFocus={handleFocus}
                  placeholder="Например: Авачинский вулкан"
                  className="ds-input pl-9 w-full"
                  autoComplete="off"
                  aria-autocomplete="list"
                  aria-controls="gear-route-list"
                />
              </div>
              {open && !selectedRoute && (
                <div id="gear-route-list" className="absolute z-10 w-full mt-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden shadow-lg">
                  {!query.trim() && suggestions.length > 0 && (
                    <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]">Популярные маршруты</p>
                  )}
                  {suggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => pick(s)}
                      className="w-full text-left px-4 py-3 min-h-[44px] hover:bg-[var(--bg-hover)] transition-colors border-b border-[var(--border)] last:border-0 text-sm text-[var(--text-primary)]"
                    >
                      {s.title}
                    </button>
                  ))}
                  {suggestState === 'loading' && suggestions.length === 0 && (
                    <p className="px-4 py-3 text-sm text-[var(--text-muted)]">Ищем маршруты…</p>
                  )}
                  {suggestState === 'empty' && (
                    <p className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                      Маршрута с таким названием в каталоге нет. Попробуйте название вулкана или места —{' '}
                      <Link href="/routes" className="text-[var(--ocean)] underline">все маршруты</Link>.
                    </p>
                  )}
                  {suggestState === 'failed' && (
                    <p className="px-4 py-3 text-sm text-[var(--danger)]">Список маршрутов не загрузился — проверьте связь и нажмите на поле ещё раз.</p>
                  )}
                </div>
              )}
            </div>

            <div>
              <label htmlFor="gear-date" className="block text-xs font-bold uppercase tracking-[0.2em] text-[var(--text-muted)] mb-2">
                Дата поездки
              </label>
              <div className="relative">
                <Calendar size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden="true" />
                <input
                  id="gear-date"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="ds-input pl-9 w-full"
                />
              </div>
            </div>

            {error && (
              <p className="text-sm text-[var(--danger)] flex items-center gap-2" role="alert">
                <AlertTriangle size={14} aria-hidden="true" /> {error}
              </p>
            )}

            <button
              type="submit"
              disabled={missing !== null || loading}
              aria-describedby={missing ? 'gear-missing' : undefined}
              className="ds-btn ds-btn-primary w-full flex items-center justify-center gap-2 py-3 disabled:opacity-40"
            >
              <Backpack size={18} aria-hidden="true" />
              {loading ? 'Собираем список…' : 'Собрать чек-лист'}
            </button>
            {missing && <p id="gear-missing" className="text-xs text-[var(--text-muted)] text-center">{missing}</p>}
          </form>
        )}

        {result && !loading && (
          <div className="space-y-6">
            <div className="ds-card p-6">
              <p className="text-[var(--text-muted)] text-[10px] uppercase tracking-[0.3em] font-bold mb-1">
                {result.monthLabel}
              </p>
              <h2 className="font-playfair text-2xl font-bold text-[var(--text-primary)]">
                <Link href={result.routeHref} className="hover:underline">{result.routeTitle}</Link>
              </h2>
              <p className="text-sm text-[var(--text-secondary)] mt-2">
                Обстановка на сегодня и оценка дня — <Link href={result.routeHref} className="text-[var(--ocean)] underline">на карточке маршрута</Link>.
              </p>
            </div>

            {result.offSeason && (
              <div className="ds-card p-4 flex gap-3 border-[var(--warning)]">
                <AlertTriangle size={18} className="text-[var(--warning)] flex-shrink-0 mt-0.5" aria-hidden="true" />
                <p className="text-sm text-[var(--text-primary)]">{result.offSeason}</p>
              </div>
            )}

            {result.steps.length > 0 && (
              <section className="ds-card p-5">
                <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--text-secondary)] mb-3">До выхода</h3>
                <ul className="space-y-2">
                  {result.steps.map((s) => (
                    <li key={s.title} className="flex items-start gap-3 text-sm">
                      <CheckCircle size={16} className="text-[var(--accent)] flex-shrink-0 mt-0.5" aria-hidden="true" />
                      <Link href={s.href} className="text-[var(--text-primary)] hover:underline">{s.title}</Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="ds-card overflow-hidden">
              <h3 className="px-5 py-3 border-b border-[var(--border)] bg-[var(--bg-hover)] text-xs font-bold uppercase tracking-[0.2em] text-[var(--text-secondary)]">
                Снаряжение по паспорту маршрута
              </h3>
              {result.passportEquipment ? (
                <ul className="divide-y divide-[var(--border)]">
                  {result.passportEquipment.map((item) => (
                    <li key={item} className="px-5 py-3 flex items-start gap-3 text-sm text-[var(--text-primary)]">
                      <CheckCircle size={16} className="text-[var(--accent)] flex-shrink-0 mt-0.5" aria-hidden="true" />
                      {item}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-4 text-sm text-[var(--text-secondary)]">
                  Паспорт маршрута снаряжение не называет. Ниже — общий минимум; что нужно сверх него, уточните у гида или оператора.
                </p>
              )}
            </section>

            {result.hazards.length > 0 && (
              <section className="ds-card p-5">
                <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--text-secondary)] mb-3">Опасности маршрута</h3>
                <ul className="flex flex-wrap gap-2">
                  {result.hazards.map((h) => (
                    <li key={h} className="ds-badge">{h}</li>
                  ))}
                </ul>
                <p className="text-xs text-[var(--text-muted)] mt-3">Снаряжение под эти опасности подбирайте с гидом или оператором.</p>
              </section>
            )}

            <section className="ds-card overflow-hidden">
              <h3 className="px-5 py-3 border-b border-[var(--border)] bg-[var(--bg-hover)] text-xs font-bold uppercase tracking-[0.2em] text-[var(--text-secondary)]">
                Общий минимум для любого выхода
              </h3>
              <ul className="divide-y divide-[var(--border)]">
                {result.essentials.map((item) => (
                  <li key={item.name} className="px-5 py-3 flex items-start gap-3">
                    <Circle size={16} className="text-[var(--text-muted)] flex-shrink-0 mt-0.5" aria-hidden="true" />
                    <span className="text-sm text-[var(--text-primary)]">
                      {item.name}
                      <span className="block text-xs text-[var(--text-muted)]">{item.why}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="px-5 py-3 text-xs text-[var(--text-muted)] border-t border-[var(--border)]">Источник: {result.essentialsSource}.</p>
            </section>

            <nav aria-label="Что дальше" className="grid grid-cols-1 sm:grid-cols-2 gap-3 print:hidden">
              <Link href={result.prepareHref} className="ds-btn ds-btn-primary justify-center">Подготовка к выходу</Link>
              <Link href="/gear" className="ds-btn ds-btn-secondary justify-center">Прокат снаряжения</Link>
              <Link href={kuzmichAskHref(`Что взять на маршрут «${result.routeTitle}»?`)} className="ds-btn ds-btn-secondary justify-center inline-flex items-center gap-2">
                <MessageCircle size={16} aria-hidden="true" />Спросить Кузьмича
              </Link>
              <button type="button" onClick={() => window.print()} className="ds-btn ds-btn-secondary justify-center inline-flex items-center gap-2">
                <Printer size={16} aria-hidden="true" />Распечатать
              </button>
            </nav>

            <button
              type="button"
              onClick={() => { setResult(null); setSelectedRoute(null); setQuery(''); setDateFrom(''); setSuggestions([]); setSuggestState('idle'); }}
              className="text-sm text-[var(--accent)] hover:underline print:hidden"
            >
              Другой маршрут
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect, useId } from 'react';
import { useRouter } from 'next/navigation';
import {
  Route, Calendar, Dumbbell, ChevronDown, Loader, Sparkles,
  Download, AlertTriangle, Search,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RouteOption {
  id: string;
  title: string;
  zone: string | null;
  difficulty: string | null;
  distanceKm: number | null;
  durationHours: number | null;
  season: string | null;
}

type Experience = 'beginner' | 'intermediate' | 'advanced';
type Step = 'form' | 'generating' | 'done' | 'error';

const EXPERIENCE_LABELS: Record<Experience, string> = {
  beginner:     'Начинающий',
  intermediate: 'Опытный',
  advanced:     'Эксперт',
};

// ─── Session ID ───────────────────────────────────────────────────────────────

function getSessionId(): string {
  const key = 'kh_session_id';
  let sid = localStorage.getItem(key);
  if (!sid) {
    sid = crypto.randomUUID();
    localStorage.setItem(key, sid);
  }
  return sid;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TripPlanClient() {
  const router = useRouter();
  const uid = useId();

  const [search, setSearch]         = useState('');
  const [routes, setRoutes]         = useState<RouteOption[]>([]);
  const [routeLoading, setRouteLoading] = useState(false);
  const [selected, setSelected]     = useState<RouteOption | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);

  const [startDate, setStartDate]   = useState('');
  const [days, setDays]             = useState(1);
  const [experience, setExperience] = useState<Experience>('intermediate');

  const [step, setStep]             = useState<Step>('form');
  const [errorMsg, setErrorMsg]     = useState('');
  const [planId, setPlanId]         = useState('');

  // ── Search routes ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (search.length < 2) { setRoutes([]); setShowDropdown(false); return; }
    const timer = setTimeout(async () => {
      setRouteLoading(true);
      try {
        const res = await fetch(`/api/routes?q=${encodeURIComponent(search)}&limit=10`);
        if (!res.ok) throw new Error();
        const json = await res.json() as { success: boolean; data: RouteOption[] };
        setRoutes(json.data ?? []);
        setShowDropdown(true);
      } catch {
        setRoutes([]);
      } finally {
        setRouteLoading(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  function selectRoute(r: RouteOption) {
    setSelected(r);
    setSearch(r.title);
    setShowDropdown(false);
  }

  // ── Generate ───────────────────────────────────────────────────────────────
  async function handleGenerate() {
    if (!selected) return;
    setStep('generating');
    setErrorMsg('');

    try {
      const sessionId = getSessionId();
      const res = await fetch('/api/trip-plans/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routeId: selected.id,
          sessionId,
          startDate: startDate || undefined,
          days,
          experience,
        }),
      });
      const json = await res.json() as { success: boolean; data?: { id: string }; error?: string };
      if (!json.success || !json.data) throw new Error(json.error ?? 'Ошибка генерации');
      setPlanId(json.data.id);
      setStep('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Ошибка сети');
      setStep('error');
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (step === 'generating') {
    return (
      <div className="ds-page flex items-center justify-center min-h-[60vh]">
        <div className="text-center space-y-4">
          <Loader className="w-10 h-10 animate-spin text-[var(--accent)] mx-auto" />
          <p className="ds-h2">AI составляет план...</p>
          <p className="text-[var(--text-secondary)] text-sm">
            Анализируем маршрут, точки и условия. Обычно 15–30 секунд.
          </p>
        </div>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="ds-page flex items-center justify-center min-h-[60vh]">
        <div className="ds-card p-8 max-w-md w-full text-center space-y-5">
          <Sparkles className="w-10 h-10 text-[var(--accent)] mx-auto" />
          <h2 className="ds-h2">План готов</h2>
          <p className="text-[var(--text-secondary)] text-sm">
            Откройте план и скачайте его для офлайн-использования — он будет работать без интернета.
          </p>
          <div className="flex flex-col gap-3">
            <button
              onClick={() => router.push(`/trips/${planId}`)}
              className="ds-btn ds-btn-primary w-full flex items-center justify-center gap-2"
            >
              <Route className="w-4 h-4" />
              Открыть план
            </button>
            <button
              onClick={() => { setStep('form'); setSelected(null); setSearch(''); }}
              className="ds-btn ds-btn-secondary w-full"
            >
              Составить другой план
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-page">
      <div className="ds-section max-w-2xl mx-auto">

        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm mb-2">
            <Route className="w-4 h-4" />
            <span>Офлайн-рюкзак</span>
          </div>
          <h1 className="ds-h1">Составить маршрут</h1>
          <p className="text-[var(--text-secondary)] mt-2">
            AI построит день-за-днём план по маршруту Камчатки.
            Сохраните офлайн — работает без связи в горах.
          </p>
        </div>

        {step === 'error' && (
          <div className="mb-6 p-4 rounded-lg border border-[var(--danger)] bg-[var(--bg-hover)] flex gap-3">
            <AlertTriangle className="w-5 h-5 text-[var(--danger)] shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-[var(--danger)]">Ошибка генерации</p>
              <p className="text-sm text-[var(--text-secondary)] mt-0.5">{errorMsg}</p>
            </div>
          </div>
        )}

        <div className="ds-card p-6 space-y-6">

          {/* Route search */}
          <div>
            <label htmlFor={`${uid}-route`} className="ds-label">Маршрут</label>
            <div className="relative mt-1">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
                {routeLoading
                  ? <Loader className="w-4 h-4 animate-spin" />
                  : <Search className="w-4 h-4" />
                }
              </div>
              <input
                id={`${uid}-route`}
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); setSelected(null); }}
                placeholder="Авачинский перевал, Долина гейзеров..."
                className="ds-input pl-9 w-full"
              />
              {showDropdown && routes.length > 0 && (
                <div className="absolute z-20 mt-1 w-full bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-lg max-h-60 overflow-y-auto">
                  {routes.map(r => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => selectRoute(r)}
                      className="w-full text-left px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors border-b border-[var(--border)] last:border-0"
                    >
                      <div className="text-sm font-medium text-[var(--text-primary)]">{r.title}</div>
                      <div className="text-xs text-[var(--text-muted)] mt-0.5 flex gap-2">
                        {r.zone && <span>{r.zone}</span>}
                        {r.difficulty && <span>· {r.difficulty}</span>}
                        {r.distanceKm && <span>· {r.distanceKm} км</span>}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {selected && (
              <div className="mt-2 flex flex-wrap gap-2">
                {selected.difficulty && (
                  <span className="ds-badge text-xs">{selected.difficulty}</span>
                )}
                {selected.distanceKm && (
                  <span className="ds-badge text-xs">{selected.distanceKm} км</span>
                )}
                {selected.season && (
                  <span className="ds-badge text-xs">{selected.season}</span>
                )}
              </div>
            )}
          </div>

          {/* Days + Date */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor={`${uid}-days`} className="ds-label">Дней в походе</label>
              <div className="relative mt-1">
                <input
                  id={`${uid}-days`}
                  type="number"
                  min={1}
                  max={14}
                  value={days}
                  onChange={e => setDays(Math.max(1, Math.min(14, Number(e.target.value))))}
                  className="ds-input w-full"
                />
              </div>
            </div>
            <div>
              <label htmlFor={`${uid}-date`} className="ds-label flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5" /> Дата старта
                <span className="text-[var(--text-muted)] font-normal">(необязательно)</span>
              </label>
              <input
                id={`${uid}-date`}
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="ds-input w-full mt-1"
              />
            </div>
          </div>

          {/* Experience */}
          <div>
            <label className="ds-label flex items-center gap-1">
              <Dumbbell className="w-3.5 h-3.5" /> Уровень подготовки
            </label>
            <div className="grid grid-cols-3 gap-2 mt-1">
              {(['beginner', 'intermediate', 'advanced'] as Experience[]).map(lvl => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setExperience(lvl)}
                  className={[
                    'py-2 px-3 rounded-lg border text-sm font-medium transition-all',
                    experience === lvl
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                      : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]',
                  ].join(' ')}
                >
                  {EXPERIENCE_LABELS[lvl]}
                </button>
              ))}
            </div>
          </div>

          {/* Submit */}
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!selected}
            className="ds-btn ds-btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Sparkles className="w-4 h-4" />
            Составить план AI
          </button>

          <p className="text-xs text-[var(--text-muted)] flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5 shrink-0" />
            После генерации план можно скачать офлайн одной кнопкой
          </p>
        </div>

        {/* Info */}
        <div className="mt-6 grid grid-cols-3 gap-4 text-center">
          {[
            { label: 'Работает без связи', sub: 'в горах и тайге' },
            { label: 'Безопасность', sub: 'опасности и МЧС' },
            { label: 'GPS офлайн', sub: 'координаты всегда' },
          ].map(item => (
            <div key={item.label} className="ds-card p-3">
              <p className="text-xs font-medium text-[var(--text-primary)]">{item.label}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">{item.sub}</p>
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}

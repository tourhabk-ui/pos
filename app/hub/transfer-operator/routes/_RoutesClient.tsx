'use client';

import { useEffect, useState, useCallback } from 'react';
import { Protected } from '@/components/auth/Protected';
import { Route, Plus, Loader2, MapPin, Clock, Banknote, RefreshCw } from 'lucide-react';

// Реальные маршруты трансфер-оператора: список из GET /api/transfer/routes,
// создание через POST того же эндпоинта (скоуп по operator_id на сервере).
interface ApiRoute {
  id: string;
  from_location: string;
  to_location: string;
  distance_km: number | null;
  duration_minutes: number | null;
  base_price: string | number | null;
}

export default function RoutesClient() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [routes, setRoutes] = useState<ApiRoute[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ from: '', to: '', distance: '', duration: '', price: '' });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/transfer/routes', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json?.success) throw new Error(json?.error || 'Не удалось загрузить маршруты');
      setRoutes((json.data?.routes ?? []) as ApiRoute[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/transfer/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${form.from} — ${form.to}`,
          fromLocation: form.from,
          toLocation: form.to,
          distance: parseFloat(form.distance) || undefined,
          estimatedDuration: parseInt(form.duration) || undefined,
          basePrice: parseFloat(form.price) || 0,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) throw new Error(json?.error || 'Не удалось сохранить маршрут');
      setForm({ from: '', to: '', distance: '', duration: '', price: '' });
      setShowForm(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  const inputCls = 'w-full min-h-[44px] px-4 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30';

  return (
    <Protected roles={['transfer_operator', 'transfer', 'admin']}>
      <div className="max-w-5xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Route className="w-6 h-6 text-[var(--accent)]" />
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">Маршруты</h1>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void load()} disabled={loading}
              className="min-h-[44px] px-3 py-2 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)] inline-flex items-center gap-2 hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={() => setShowForm(!showForm)}
              className="min-h-[44px] px-4 py-2 bg-[var(--accent)] text-white rounded-xl font-medium inline-flex items-center gap-2 hover:opacity-90 transition-opacity">
              <Plus className="w-4 h-4" /> Добавить маршрут
            </button>
          </div>
        </div>

        {showForm && (
          <form onSubmit={handleAdd} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5 mb-6 space-y-4">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Новый маршрут</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="block">
                <span className="text-sm text-[var(--text-secondary)] mb-1.5 block">Откуда</span>
                <input value={form.from} onChange={e => setForm(p => ({ ...p, from: e.target.value }))} className={inputCls} required placeholder="Аэропорт Елизово" />
              </label>
              <label className="block">
                <span className="text-sm text-[var(--text-secondary)] mb-1.5 block">Куда</span>
                <input value={form.to} onChange={e => setForm(p => ({ ...p, to: e.target.value }))} className={inputCls} required placeholder="Петропавловск-Камчатский" />
              </label>
              <label className="block">
                <span className="text-sm text-[var(--text-secondary)] mb-1.5 block">Расстояние (км)</span>
                <input type="number" value={form.distance} onChange={e => setForm(p => ({ ...p, distance: e.target.value }))} className={inputCls} />
              </label>
              <label className="block">
                <span className="text-sm text-[var(--text-secondary)] mb-1.5 block">Время (мин)</span>
                <input type="number" value={form.duration} onChange={e => setForm(p => ({ ...p, duration: e.target.value }))} className={inputCls} />
              </label>
              <label className="block">
                <span className="text-sm text-[var(--text-secondary)] mb-1.5 block">Базовая цена (руб)</span>
                <input type="number" value={form.price} onChange={e => setForm(p => ({ ...p, price: e.target.value }))} className={inputCls} required />
              </label>
            </div>
            {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
            <button type="submit" disabled={saving} className="min-h-[44px] px-4 py-2 bg-[var(--accent)] text-white rounded-xl font-medium inline-flex items-center gap-2 disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {saving ? 'Сохранение...' : 'Добавить'}
            </button>
          </form>
        )}

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" /></div>
        ) : error && !showForm ? (
          <div className="text-center py-16">
            <p className="text-[var(--danger)] mb-3">{error}</p>
            <button onClick={() => void load()} className="min-h-[44px] px-4 py-2 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)]">Повторить</button>
          </div>
        ) : routes.length === 0 ? (
          <div className="text-center py-16">
            <Route className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-3" />
            <p className="text-[var(--text-secondary)]">Нет маршрутов</p>
            <p className="text-sm text-[var(--text-muted)]">Добавьте первый маршрут трансфера</p>
          </div>
        ) : (
          <div className="space-y-3">
            {routes.map(route => {
              const price = Number(route.base_price) || 0;
              return (
                <div key={route.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
                  <div className="flex items-center gap-2 text-[var(--text-primary)] font-medium">
                    <MapPin className="w-4 h-4 text-[var(--accent)] shrink-0" />
                    {route.from_location}
                    <span className="text-[var(--text-muted)]">&rarr;</span>
                    {route.to_location}
                  </div>
                  <div className="flex items-center gap-4 mt-1.5 text-sm text-[var(--text-secondary)] flex-wrap">
                    {route.distance_km != null && <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> {route.distance_km} км</span>}
                    {route.duration_minutes != null && <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {route.duration_minutes} мин</span>}
                    <span className="flex items-center gap-1 text-[var(--accent)] font-medium"><Banknote className="w-3.5 h-3.5" /> {price.toLocaleString('ru-RU')} ₽</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Protected>
  );
}

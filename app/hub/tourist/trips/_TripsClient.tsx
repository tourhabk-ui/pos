'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Protected } from '@/components/auth/Protected';
import {
  MapPin, Calendar, Trash2, Plus, Loader, AlertTriangle, Route,
} from 'lucide-react';

function DeleteTripModal({ title, onConfirm, onCancel }: { title: string; onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg w-full max-w-sm p-6 shadow-xl">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-9 h-9 rounded-full bg-[var(--danger)]/10 flex items-center justify-center">
            <Trash2 className="w-4 h-4 text-[var(--danger)]" />
          </div>
          <h3 className="font-semibold text-[var(--text-primary)]">Удалить маршрут?</h3>
        </div>
        <p className="text-sm text-[var(--text-secondary)] mb-6">
          <span className="font-medium">{title}</span> будет удалён без возможности восстановления.
        </p>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel}
            className="px-4 py-2 text-sm text-[var(--text-secondary)] border border-[var(--border)] rounded-lg hover:bg-[var(--bg-hover)] transition-colors">
            Отмена
          </button>
          <button onClick={onConfirm}
            className="px-4 py-2 text-sm bg-[var(--danger)] text-[var(--bg-primary)] rounded-lg hover:opacity-90 transition-opacity">
            Удалить
          </button>
        </div>
      </div>
    </div>
  );
}

interface TripListItem {
  id: string;
  title: string;
  arrival_date: string | null;
  departure_date: string | null;
  places: string[];
  activities: string[];
  days_count: string;
  created_at: string;
  updated_at: string;
}

function fmt(d: string | null): string {
  if (!d) return '';
  return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function TripCard({ trip, deleting, onRequestDelete }: { trip: TripListItem; deleting: boolean; onRequestDelete: (id: string, title: string) => void }) {
  const days = Number(trip.days_count);

  return (
    <Link href={`/hub/tourist/trips/${trip.id}`}
      className="group ds-card p-4 flex flex-col gap-3 hover:border-[var(--accent)] transition-all">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors">
            {trip.title}
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Обновлён {fmt(trip.updated_at)}
          </p>
        </div>
        <button
          onClick={e => { e.preventDefault(); onRequestDelete(trip.id, trip.title); }}
          disabled={deleting}
          className="w-7 h-7 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors shrink-0 disabled:opacity-50">
          {deleting ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </div>

      <div className="flex flex-wrap gap-2 text-xs text-[var(--text-secondary)]">
        {trip.arrival_date && (
          <span className="flex items-center gap-1">
            <Calendar className="w-3.5 h-3.5" />
            {fmt(trip.arrival_date)}{trip.departure_date ? ` — ${fmt(trip.departure_date)}` : ''}
          </span>
        )}
        {days > 0 && (
          <span className="flex items-center gap-1">
            <MapPin className="w-3.5 h-3.5" />
            {days} {days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}
          </span>
        )}
      </div>

      {(trip.places.length > 0 || trip.activities.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {[...trip.places, ...trip.activities].slice(0, 5).map(tag => (
            <span key={tag}
              className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-muted)]">
              {tag}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}

export function TripsClient() {
  const [trips, setTrips] = useState<TripListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetch('/api/trips')
      .then(r => r.json())
      .then(d => {
        if (d.success) setTrips(d.data);
        else setError(d.error ?? 'Ошибка');
      })
      .catch(() => setError('Нет соединения'))
      .finally(() => setLoading(false));
  }, []);

  async function executeDelete(id: string) {
    setDeleteTarget(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/trips/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setTrips(prev => prev.filter(t => t.id !== id));
        toast.success('Маршрут удалён');
      } else {
        toast.error('Не удалось удалить маршрут');
      }
    } catch {
      toast.error('Ошибка сети');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Protected roles={['tourist', 'admin']}>
      {deleteTarget && (
        <DeleteTripModal
          title={deleteTarget.title}
          onConfirm={() => executeDelete(deleteTarget.id)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      <div className="ds-page max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="ds-h1">Мои маршруты</h1>
            <p className="text-sm text-[var(--text-secondary)] mt-1">
              Сохранённые планы из конструктора
            </p>
          </div>
          <Link href="/planner"
            className="ds-btn ds-btn-primary flex items-center gap-2 px-4 py-2.5 text-sm font-medium">
            <Plus className="w-4 h-4" />
            Новый маршрут
          </Link>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16 gap-2 text-[var(--text-muted)]">
            <Loader className="w-5 h-5 animate-spin" />
            <span className="text-sm">Загружаем маршруты...</span>
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center gap-2 p-4 bg-[var(--danger)]/10 border border-[var(--danger)]/30 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-[var(--danger)] shrink-0" />
            <p className="text-sm text-[var(--danger)]">{error}</p>
          </div>
        )}

        {!loading && !error && trips.length === 0 && (
          <div className="text-center py-20">
            <div className="w-16 h-16 rounded-full bg-[var(--bg-hover)] flex items-center justify-center mx-auto mb-4">
              <Route className="w-7 h-7 text-[var(--text-muted)]" />
            </div>
            <p className="text-[var(--text-secondary)] mb-4">Пока нет сохранённых маршрутов</p>
            <Link href="/planner" className="ds-btn ds-btn-primary px-5 py-2.5 text-sm font-medium">
              Построить первый маршрут
            </Link>
          </div>
        )}

        {!loading && trips.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {trips.map(t => (
              <TripCard key={t.id} trip={t} deleting={deleting} onRequestDelete={(id, title) => setDeleteTarget({ id, title })} />
            ))}
          </div>
        )}
      </div>
    </Protected>
  );
}

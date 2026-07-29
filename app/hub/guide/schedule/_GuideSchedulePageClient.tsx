'use client';

import { useState } from 'react';
import { LoadingSpinner } from '@/components/admin/shared';
import { Calendar, CalendarDays, Clock, MapPin, Users, Plus, Loader2 } from 'lucide-react';
import { useApiFetch } from '@/hooks/use-api-fetch';

/**
 * Контракт — ровно тот, что отдаёт GET /api/guide/schedule.
 *
 * Раньше здесь были поля tourName/date/time/participants, которых API не
 * отдаёт; ответ разбирался как массив (`(d) => d ?? []`), хотя приходит
 * `data: { schedule }`; а фильтр слался как `?date=`, тогда как роут читает
 * dateFrom/dateTo — выбор даты молча ни на что не влиял. Три контрактные
 * лжи в одном экране (аудит 27.07, тот же класс, что витрина снаряжения).
 */
interface ScheduleItem {
  id: string;
  startTime: string;
  endTime: string;
  title: string | null;
  tourTitle: string | null;
  locationName: string | null;
  maxParticipants: number | null;
  currentParticipants: number | null;
  status: string | null;
}

interface ScheduleApiResponse { schedule: ScheduleItem[] }

function getStatusStyle(status: string): { color: string; borderColor: string; backgroundColor: string } {
  switch (status) {
    case 'scheduled':
    case 'upcoming':
      return {
        color: 'var(--accent)',
        borderColor: 'var(--accent)',
        backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)',
      };
    case 'in_progress':
      return {
        color: 'var(--success)',
        borderColor: 'var(--success)',
        backgroundColor: 'color-mix(in srgb, var(--success) 10%, transparent)',
      };
    case 'completed':
    default:
      return {
        color: 'var(--text-muted)',
        borderColor: 'var(--border)',
        backgroundColor: 'var(--bg-hover)',
      };
  }
}

function getStatusLabel(status: string) {
  switch (status) {
    case 'scheduled':
    case 'upcoming':    return 'Предстоит';
    case 'in_progress': return 'В процессе';
    case 'completed':   return 'Завершен';
    case 'cancelled':   return 'Отменён';
    default:            return status;
  }
}

const INPUT_DATE = 'px-3.5 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';
const INPUT = 'w-full px-3 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';

const EMPTY_FORM = { title: '', startTime: '', endTime: '', locationName: '', maxParticipants: '', notes: '' };

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export default function GuideSchedulePageClient() {
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // dateFrom/dateTo — параметры, которые роут действительно читает.
  const { data: schedule, loading, refetch } = useApiFetch<ScheduleApiResponse, ScheduleItem[]>(
    `/api/guide/schedule?dateFrom=${selectedDate}&dateTo=${selectedDate}`,
    (d) => d?.schedule ?? [],
  );

  const items = schedule ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (form.endTime <= form.startTime) {
      setFormError('Время окончания должно быть позже начала');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/guide/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title.trim(),
          startTime: new Date(`${selectedDate}T${form.startTime}`).toISOString(),
          endTime: new Date(`${selectedDate}T${form.endTime}`).toISOString(),
          ...(form.locationName.trim() ? { locationName: form.locationName.trim() } : {}),
          ...(form.maxParticipants.trim() ? { maxParticipants: Number(form.maxParticipants) } : {}),
          ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFormError(json.error || 'Не удалось добавить запись');
        return;
      }
      setForm(EMPTY_FORM);
      setShowForm(false);
      await refetch();
    } catch {
      setFormError('Не удалось добавить запись — проверьте соединение');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-5 lg:p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="ds-h1 flex items-center gap-2">
            <CalendarDays className="w-6 h-6 text-[var(--ocean)]" />
            Расписание
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">Ваши предстоящие туры</p>
        </div>
        <button
          onClick={() => setShowForm(s => !s)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg text-sm font-medium transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          Добавить запись
        </button>
      </div>

      {/* Date Selector */}
      <div>
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className={INPUT_DATE}
        />
      </div>

      {showForm && (
        <form onSubmit={submit} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 space-y-4">
          <p className="text-xs text-[var(--text-muted)]">
            Запись создаётся на выбранную дату — {new Date(selectedDate).toLocaleDateString('ru-RU')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="ds-label">Название</label>
              <input required value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Восхождение на Авачинский" className={INPUT} />
            </div>
            <div>
              <label className="ds-label">Начало</label>
              <input required type="time" value={form.startTime} onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))} className={INPUT} />
            </div>
            <div>
              <label className="ds-label">Окончание</label>
              <input required type="time" value={form.endTime} onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))} className={INPUT} />
            </div>
            <div>
              <label className="ds-label">Место сбора (необязательно)</label>
              <input value={form.locationName} onChange={e => setForm(f => ({ ...f, locationName: e.target.value }))} className={INPUT} />
            </div>
            <div>
              <label className="ds-label">Мест максимум (необязательно)</label>
              <input type="number" min={1} value={form.maxParticipants} onChange={e => setForm(f => ({ ...f, maxParticipants: e.target.value }))} className={INPUT} />
            </div>
            <div className="sm:col-span-2">
              <label className="ds-label">Заметка (необязательно)</label>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className={INPUT} />
            </div>
          </div>
          {formError && <p className="text-sm text-[var(--danger)]">{formError}</p>}
          <div className="flex gap-3">
            <button type="button" onClick={() => { setShowForm(false); setFormError(''); }} className="px-4 py-2.5 border border-[var(--border)] text-[var(--text-secondary)] rounded-lg text-sm hover:text-[var(--text-primary)] transition-colors">
              Отмена
            </button>
            <button type="submit" disabled={saving} className="flex items-center gap-2 px-4 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Добавить
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <LoadingSpinner message="Загрузка расписания..." />
      ) : items.length === 0 ? (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-12 text-center">
          <Calendar className="w-14 h-14 mx-auto mb-4 text-[var(--text-muted)]" />
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
            Нет запланированных туров
          </h2>
          <p className="text-sm text-[var(--text-muted)]">
            На выбранную дату туры не назначены
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.id}
              className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-5 py-4 hover:bg-[var(--bg-hover)] transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
                    {item.tourTitle ?? item.title ?? 'Запись расписания'}
                  </h3>
                  <div className="flex flex-wrap gap-4 text-xs text-[var(--text-muted)]">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      {timeOf(item.startTime)}–{timeOf(item.endTime)}
                    </span>
                    {item.locationName && (
                      <span className="flex items-center gap-1">
                        <MapPin className="w-3.5 h-3.5" />
                        {item.locationName}
                      </span>
                    )}
                    {item.maxParticipants !== null && (
                      <span className="flex items-center gap-1">
                        <Users className="w-3.5 h-3.5" />
                        {item.currentParticipants ?? 0} / {item.maxParticipants} чел.
                      </span>
                    )}
                  </div>
                </div>
                {item.status && (
                  <span
                    className="shrink-0 px-2.5 py-1 rounded-full text-xs border"
                    style={getStatusStyle(item.status)}
                  >
                    {getStatusLabel(item.status)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

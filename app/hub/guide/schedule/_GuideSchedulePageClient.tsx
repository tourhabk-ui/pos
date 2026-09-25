'use client';

import { useState } from 'react';
import Link from 'next/link';
import { LoadingSpinner } from '@/components/admin/shared';
import { Calendar, CalendarDays, Clock, MapPin, Users, Plus, Loader2, AlertCircle, RefreshCw, ClipboardList } from 'lucide-react';
import { useApiFetch } from '@/hooks/use-api-fetch';
import { plural } from '@/lib/home/data-freshness';

/**
 * Контракт — ровно тот, что отдаёт GET /api/guide/schedule (миграция 1019):
 * записи личного календаря гида (`schedule`) и брони, на которые его назначил
 * оператор (`assignments`, без ПД — контакт туриста живёт в «Группах»).
 *
 * Время — «ЧЧ:ММ» местное, как ввёл гид: колонка `time`, без часовых поясов.
 * До 25.09 экран слал ISO-метку в колонку time, а отказ загрузки рисовал как
 * «Нет запланированных туров» — теперь ошибка показывается ошибкой.
 */
interface ScheduleItem {
  id: string;
  date: string;
  startTime: string;
  endTime: string | null;
  title: string | null;
  tourTitle: string | null;
  locationName: string | null;
  maxParticipants: number | null;
  participantsCount: number | null;
  status: string | null;
}

interface Assignment {
  bookingId: string;
  date: string;
  tourTitle: string;
  participants: number;
  status: string;
}

interface ScheduleApiResponse { schedule: ScheduleItem[]; assignments: Assignment[] }

function getStatusStyle(status: string): { color: string; borderColor: string; backgroundColor: string } {
  switch (status) {
    case 'scheduled':
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
    case 'scheduled':   return 'Предстоит';
    case 'in_progress': return 'В процессе';
    case 'completed':   return 'Завершен';
    case 'cancelled':   return 'Отменён';
    default:            return status;
  }
}

const INPUT_DATE = 'px-3.5 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';
const INPUT = 'w-full px-3 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';

const EMPTY_FORM = { title: '', startTime: '', endTime: '', locationName: '', maxParticipants: '', notes: '', operatorBookingId: '' };

/** Сегодня по Камчатке — дата по умолчанию, а не UTC-дата браузера. */
function kamchatkaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kamchatka' }).format(new Date());
}

export default function GuideSchedulePageClient() {
  const [selectedDate, setSelectedDate] = useState(kamchatkaToday);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const { data, loading, error, refetch } = useApiFetch<ScheduleApiResponse, ScheduleApiResponse>(
    `/api/guide/schedule?dateFrom=${selectedDate}&dateTo=${selectedDate}`,
    (d) => ({ schedule: d?.schedule ?? [], assignments: d?.assignments ?? [] }),
    { errorMessage: 'Не удалось загрузить расписание' },
  );

  const items = data?.schedule ?? [];
  const assignments = data?.assignments ?? [];

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
          date: selectedDate,
          title: form.title.trim(),
          startTime: form.startTime,
          endTime: form.endTime,
          ...(form.operatorBookingId ? { operatorBookingId: form.operatorBookingId } : {}),
          ...(form.locationName.trim() ? { locationName: form.locationName.trim() } : {}),
          ...(form.maxParticipants.trim() ? { maxParticipants: Number(form.maxParticipants) } : {}),
          ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
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
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="ds-h1 flex items-center gap-2">
            <CalendarDays className="w-6 h-6 text-[var(--ocean)]" />
            Расписание
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">Ваш календарь и назначения оператора</p>
        </div>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="ds-btn ds-btn-primary flex items-center gap-2 shrink-0"
        >
          <Plus className="w-4 h-4" />
          Добавить запись
        </button>
      </div>

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
            Запись создаётся на выбранную дату — {new Date(`${selectedDate}T00:00:00`).toLocaleDateString('ru-RU')}. Время — местное.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="ds-label">Название</label>
              <input required value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="Восхождение на Авачинский" className={INPUT} />
            </div>
            {assignments.length > 0 && (
              <div className="sm:col-span-2">
                <label className="ds-label">Бронь, на которую вас назначили (необязательно)</label>
                <select value={form.operatorBookingId} onChange={(e) => setForm((f) => ({ ...f, operatorBookingId: e.target.value }))} className={INPUT}>
                  <option value="">— личная запись —</option>
                  {assignments.map((a) => (
                    <option key={a.bookingId} value={a.bookingId}>
                      {a.tourTitle} · бронь #{a.bookingId} · {a.participants} чел.
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="ds-label">Начало</label>
              <input required type="time" value={form.startTime} onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))} className={INPUT} />
            </div>
            <div>
              <label className="ds-label">Окончание</label>
              <input required type="time" value={form.endTime} onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))} className={INPUT} />
            </div>
            <div>
              <label className="ds-label">Место сбора (необязательно)</label>
              <input value={form.locationName} onChange={(e) => setForm((f) => ({ ...f, locationName: e.target.value }))} className={INPUT} />
            </div>
            <div>
              <label className="ds-label">Мест максимум (необязательно)</label>
              <input type="number" min={1} value={form.maxParticipants} onChange={(e) => setForm((f) => ({ ...f, maxParticipants: e.target.value }))} className={INPUT} />
            </div>
            <div className="sm:col-span-2">
              <label className="ds-label">Заметка (необязательно)</label>
              <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} className={INPUT} />
            </div>
          </div>
          {formError && <p className="text-sm text-[var(--danger)]">{formError}</p>}
          <div className="flex gap-3">
            <button type="button" onClick={() => { setShowForm(false); setFormError(''); }} className="ds-btn ds-btn-secondary">
              Отмена
            </button>
            <button type="submit" disabled={saving} className="ds-btn ds-btn-primary flex items-center gap-2 disabled:opacity-50">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Добавить
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <LoadingSpinner message="Загрузка расписания..." />
      ) : error ? (
        // Отказ — не «пусто»: пустой календарь при упавшем запросе звучал бы
        // как «на этот день у вас ничего нет».
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--danger)]" />
          <div className="flex-1 min-w-0 text-sm">
            <p className="font-medium text-[var(--text-primary)]">{error}</p>
            <p className="text-[var(--text-secondary)] mt-0.5">Расписание не показано — мы не знаем, что у вас на этот день.</p>
          </div>
          <button type="button" onClick={() => void refetch()} className="ds-btn ds-btn-secondary inline-flex items-center gap-1.5 shrink-0">
            <RefreshCw className="w-4 h-4" /> Повторить
          </button>
        </div>
      ) : items.length === 0 && assignments.length === 0 ? (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-12 text-center">
          <Calendar className="w-14 h-14 mx-auto mb-4 text-[var(--text-muted)]" />
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2">На этот день пока пусто</h2>
          <p className="text-sm text-[var(--text-muted)]">Нет ни ваших записей, ни назначений оператора</p>
        </div>
      ) : (
        <div className="space-y-3">
          {assignments.map((a) => (
            <Link
              key={`b-${a.bookingId}`}
              href="/hub/guide/groups"
              className="block bg-[var(--bg-card)] border border-[var(--accent)]/30 rounded-lg px-5 py-4 hover:bg-[var(--bg-hover)] transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">{a.tourTitle}</h3>
                  <p className="text-xs text-[var(--text-muted)] flex items-center gap-3">
                    <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" /> {a.participants} {plural(a.participants, 'человек', 'человека', 'человек')}</span>
                    <span>бронь #{a.bookingId}</span>
                  </p>
                </div>
                <span className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border border-[var(--accent)] text-[var(--accent)]">
                  <ClipboardList className="w-3.5 h-3.5" /> Назначение
                </span>
              </div>
            </Link>
          ))}
          {items.map((item) => (
            <div
              key={item.id}
              className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-5 py-4 hover:bg-[var(--bg-hover)] transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
                    {item.title ?? item.tourTitle ?? 'Запись расписания'}
                  </h3>
                  <div className="flex flex-wrap gap-4 text-xs text-[var(--text-muted)]">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      {item.startTime}{item.endTime ? `–${item.endTime}` : ''}
                    </span>
                    {item.tourTitle && item.title && <span>{item.tourTitle}</span>}
                    {item.locationName && (
                      <span className="flex items-center gap-1">
                        <MapPin className="w-3.5 h-3.5" />
                        {item.locationName}
                      </span>
                    )}
                    {item.maxParticipants !== null && (
                      <span className="flex items-center gap-1">
                        <Users className="w-3.5 h-3.5" />
                        {item.participantsCount ?? 0} / {item.maxParticipants} чел.
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

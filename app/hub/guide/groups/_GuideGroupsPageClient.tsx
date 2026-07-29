'use client';

import { useState, useEffect } from 'react';
import { LoadingSpinner } from '@/components/admin/shared';
import { Users, Calendar, Phone, Mail, Plus, Loader2 } from 'lucide-react';
import { useApiFetch } from '@/hooks/use-api-fetch';

interface GroupMember {
  id?: string;
  name: string;
  phone?: string;
  email?: string;
}

/**
 * Контракт — ровно тот, что отдаёт GET /api/guide/groups.
 *
 * Раньше здесь были поля date/members/notes, которых API не отдавал, а сам
 * ответ разбирался как массив (`(d) => d ?? []`), хотя приходит
 * `data: { groups }` — объект. Итог: `list.map` по объекту, страница падала.
 * Тот же класс, что camelCase-баг витрины снаряжения (аудит 27.07).
 */
interface Group {
  id: string;
  groupName: string;
  tourName: string;
  tourDate: string;
  startTime: string | null;
  participants: GroupMember[];
  specialNeeds: string | null;
  status: string | null;
}

interface GroupsApiResponse { groups: Group[] }

/** Запись расписания — источник scheduleId для новой группы. */
interface ScheduleEntry { id: string; title?: string; tourName?: string; tourDate?: string; startTime?: string }

const INPUT = 'w-full px-3 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';

const EMPTY_FORM = { scheduleId: '', groupName: '', specialNeeds: '' };

export default function GuideGroupsPageClient() {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [schedule, setSchedule] = useState<ScheduleEntry[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

  const { data: groups, loading, refetch } = useApiFetch<GroupsApiResponse, Group[]>(
    '/api/guide/groups',
    (d) => d?.groups ?? [],
  );

  // Расписание — только при открытии формы: группа создаётся НА запись
  // расписания (scheduleId в схеме), иначе привязывать её не к чему.
  useEffect(() => {
    if (!showForm || schedule.length > 0) return;
    let cancelled = false;
    setOptionsLoading(true);
    fetch('/api/guide/schedule')
      .then(r => r.json())
      .then(j => { if (!cancelled) setSchedule((j?.data?.schedule ?? j?.data ?? []) as ScheduleEntry[]); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setOptionsLoading(false); });
    return () => { cancelled = true; };
  }, [showForm, schedule.length]);

  const list = groups ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      const res = await fetch('/api/guide/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduleId: form.scheduleId,
          groupName: form.groupName.trim(),
          ...(form.specialNeeds.trim() ? { specialNeeds: form.specialNeeds.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFormError(json.error || 'Не удалось создать группу');
        return;
      }
      setForm(EMPTY_FORM);
      setShowForm(false);
      await refetch();
    } catch {
      setFormError('Не удалось создать группу — проверьте соединение');
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
            <Users className="w-6 h-6 text-[var(--ocean)]" />
            Мои группы
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            Участники предстоящих туров
          </p>
        </div>
        <button
          onClick={() => setShowForm(s => !s)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg text-sm font-medium transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          Новая группа
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 space-y-4">
          {optionsLoading ? (
            <LoadingSpinner message="Загрузка расписания..." />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="ds-label">Запись расписания</label>
                <select required value={form.scheduleId} onChange={e => setForm(f => ({ ...f, scheduleId: e.target.value }))} className={INPUT}>
                  <option value="">— выберите тур из расписания —</option>
                  {schedule.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.tourName ?? s.title ?? 'Запись'}
                      {s.tourDate ? ` — ${new Date(s.tourDate).toLocaleDateString('ru-RU')}` : ''}
                    </option>
                  ))}
                </select>
                {schedule.length === 0 && (
                  <p className="text-xs text-[var(--text-muted)] mt-1">Расписание пусто — добавьте запись в разделе «Расписание»</p>
                )}
              </div>
              <div>
                <label className="ds-label">Название группы</label>
                <input required value={form.groupName} onChange={e => setForm(f => ({ ...f, groupName: e.target.value }))} placeholder="Группа Иванова, 6 чел." className={INPUT} />
              </div>
              <div className="sm:col-span-2">
                <label className="ds-label">Особые потребности (необязательно)</label>
                <input value={form.specialNeeds} onChange={e => setForm(f => ({ ...f, specialNeeds: e.target.value }))} placeholder="Вегетарианское питание, ребёнок 8 лет" className={INPUT} />
              </div>
            </div>
          )}
          {formError && <p className="text-sm text-[var(--danger)]">{formError}</p>}
          <div className="flex gap-3">
            <button type="button" onClick={() => { setShowForm(false); setFormError(''); }} className="px-4 py-2.5 border border-[var(--border)] text-[var(--text-secondary)] rounded-lg text-sm hover:text-[var(--text-primary)] transition-colors">
              Отмена
            </button>
            <button type="submit" disabled={saving || optionsLoading} className="flex items-center gap-2 px-4 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Создать
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <LoadingSpinner message="Загрузка групп..." />
      ) : list.length === 0 ? (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-12 text-center">
          <Users className="w-14 h-14 mx-auto mb-4 text-[var(--text-muted)]" />
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
            Нет активных групп
          </h2>
          <p className="text-sm text-[var(--text-muted)]">
            Создайте группу на запись расписания — участников добавите позже
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((group) => (
            <div
              key={group.id}
              className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden"
            >
              <button
                onClick={() => setExpandedGroup(expandedGroup === group.id ? null : group.id)}
                className="w-full px-5 py-4 text-left hover:bg-[var(--bg-hover)] transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                      {group.groupName}
                    </h3>
                    <div className="flex items-center gap-4 mt-1.5 text-xs text-[var(--text-muted)]">
                      <span>{group.tourName}</span>
                      {group.tourDate && (
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5" />
                          {new Date(group.tourDate).toLocaleDateString('ru-RU')}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Users className="w-3.5 h-3.5" />
                        {group.participants.length} участников
                      </span>
                    </div>
                  </div>
                  <span className="text-lg text-[var(--text-muted)]">
                    {expandedGroup === group.id ? '−' : '+'}
                  </span>
                </div>
              </button>

              {expandedGroup === group.id && (
                <div className="border-t border-[var(--border)] px-5 py-4">
                  {group.specialNeeds && (
                    <div
                      className="mb-4 px-3.5 py-2.5 rounded-md text-sm border"
                      style={{
                        color: 'var(--warning)',
                        borderColor: 'var(--warning)',
                        backgroundColor: 'color-mix(in srgb, var(--warning) 10%, transparent)',
                      }}
                    >
                      <strong>Особые потребности:</strong> {group.specialNeeds}
                    </div>
                  )}
                  {group.participants.length === 0 ? (
                    <p className="text-sm text-[var(--text-muted)]">Участники пока не добавлены</p>
                  ) : (
                    <div className="space-y-2">
                      {group.participants.map((member, i) => (
                        <div
                          key={member.id ?? `${group.id}-${i}`}
                          className="flex items-center justify-between px-3.5 py-2.5 bg-[var(--bg-hover)] rounded-md"
                        >
                          <span className="text-sm font-medium text-[var(--text-primary)]">
                            {member.name}
                          </span>
                          <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
                            {member.phone && (
                              <a
                                href={`tel:${member.phone}`}
                                className="flex items-center gap-1 hover:text-[var(--accent)] transition-colors"
                              >
                                <Phone className="w-3.5 h-3.5" />
                                {member.phone}
                              </a>
                            )}
                            {member.email && (
                              <a
                                href={`mailto:${member.email}`}
                                className="flex items-center gap-1 hover:text-[var(--accent)] transition-colors"
                              >
                                <Mail className="w-3.5 h-3.5" />
                                {member.email}
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

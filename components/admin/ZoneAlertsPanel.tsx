'use client';

/**
 * Ограничения по зонам — экран администратора.
 *
 * Таблица `safety_alerts` существует с миграции 065 и до 22.08.2026 не имела
 * ни одного пишущего: администратор не мог завести предупреждение никаким
 * способом, хотя планировщик его ждал. Повод нашёлся живой — временное
 * ограничение посещения природного парка «Ключевской» из-за паводка на реке
 * Студёной и разрушенной подъездной дороги.
 *
 * Отличие от вкладки «Алерты»: та показывает то, что притащили ленты КБГС и
 * МЧС (`external_alerts`), — машинное. Здесь человек говорит своими словами
 * то, чего в лентах нет: парк закрыт, дорога размыта, проезд перекрыт.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Plus, X, Loader2 } from 'lucide-react';

const ZONES = [
  { value: 'northern',   label: 'Северная Камчатка (Ключевская группа, Шивелуч, Толбачик)' },
  { value: 'avachinsky', label: 'Авачинская группа' },
  { value: 'eastern',    label: 'Восточная Камчатка' },
  { value: 'western',    label: 'Западная Камчатка' },
  { value: 'all',        label: 'Вся Камчатка' },
] as const;

const SEVERITIES = [
  { value: 'critical',  label: 'Критично — выход опасен или закрыт' },
  { value: 'important', label: 'Важно — планы надо менять' },
  { value: 'info',      label: 'Информация' },
] as const;

interface AlertRow {
  id: string;
  zone: string;
  severity: string;
  title: string;
  message: string;
  source: string;
  active_until: string | null;
  is_active: boolean;
  created_at: string;
}

const SEVERITY_STYLE: Record<string, string> = {
  critical:  'text-[var(--danger)] border-[var(--danger)]/30 bg-[var(--danger)]/10',
  important: 'text-[var(--warning)] border-[var(--warning)]/30 bg-[var(--warning)]/10',
  info:      'text-[var(--ocean)] border-[var(--ocean)]/25 bg-[var(--ocean)]/8',
};

export function ZoneAlertsPanel() {
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [zone, setZone] = useState<string>('northern');
  const [severity, setSeverity] = useState<string>('critical');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [source, setSource] = useState('МЧС Камчатка');
  const [until, setUntil] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/safety/alerts');
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setRows(data.alerts ?? []);
      setLoadState('ok');
    } catch {
      // Пустой список и несостоявшийся запрос выглядят одинаково, если не
      // различить их явно: «ограничений нет» — сильное утверждение (§4.0).
      setLoadState('failed');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/safety/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          zone, severity, title, message, source,
          active_until: until === '' ? null : new Date(until).toISOString(),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.success !== true) {
        setError(data?.error ?? 'Предупреждение не сохранено');
        return;
      }
      setTitle(''); setMessage(''); setUntil('');
      setOpen(false);
      await load();
    } catch {
      setError('Предупреждение не сохранено: сеть недоступна');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    try {
      const res = await fetch(`/api/admin/safety/alerts/${id}`, { method: 'PATCH' });
      if (res.ok) await load();
    } catch {
      // Молча не оставляем: список перечитается и покажет настоящее состояние.
      await load();
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="ds-h2 text-base">Ограничения по зонам</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-2xl leading-relaxed">
            То, чего нет в лентах КБГС и МЧС: закрытый парк, размытая дорога, перекрытый
            проезд. Видно туристу на карточке маршрута и тура и учитывается планировщиком.
          </p>
        </div>
        <button onClick={() => setOpen(v => !v)} className="ds-btn ds-btn-primary flex-shrink-0">
          <Plus className="w-4 h-4" />
          Завести
        </button>
      </div>

      {open && (
        <div className="ds-card p-4 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="ds-label">Зона</span>
              <select className="ds-input" value={zone} onChange={e => setZone(e.target.value)}>
                {ZONES.map(z => <option key={z.value} value={z.value}>{z.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="ds-label">Важность</span>
              <select className="ds-input" value={severity} onChange={e => setSeverity(e.target.value)}>
                {SEVERITIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="ds-label">Заголовок</span>
            <input
              className="ds-input" value={title} onChange={e => setTitle(e.target.value)}
              placeholder="Посещение природного парка «Ключевской» временно ограничено"
              maxLength={200}
            />
          </label>

          <label className="block">
            <span className="ds-label">Что произошло и что делать</span>
            <textarea
              className="ds-input min-h-28" value={message} onChange={e => setMessage(e.target.value)}
              placeholder="Паводок на реке Студёной, разрушена подъездная дорога. На отрезке 10–20 км вдоль Лавового языка покрытие повреждено, сквозной проезд перекрыт. До восстановления от поездок в зону воздержаться."
            />
          </label>

          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="ds-label">Источник</span>
              <input className="ds-input" value={source} onChange={e => setSource(e.target.value)} maxLength={100} />
            </label>
            <label className="block">
              <span className="ds-label">Действует до (пусто — до снятия рукой)</span>
              <input type="datetime-local" className="ds-input" value={until} onChange={e => setUntil(e.target.value)} />
            </label>
          </div>

          {error !== null && (
            <p className="text-sm text-[var(--danger)]">{error}</p>
          )}

          <div className="flex gap-2">
            <button onClick={submit} disabled={saving} className="ds-btn ds-btn-primary">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Опубликовать
            </button>
            <button onClick={() => setOpen(false)} className="ds-btn ds-btn-secondary">Отмена</button>
          </div>
        </div>
      )}

      {loadState === 'loading' && (
        <p className="text-sm text-[var(--text-muted)]">Загрузка…</p>
      )}

      {loadState === 'failed' && (
        <p className="text-sm text-[var(--danger)]">
          Список ограничений прочитать не удалось. Это НЕ значит, что ограничений нет.
        </p>
      )}

      {loadState === 'ok' && rows.length === 0 && (
        <p className="text-sm text-[var(--text-muted)]">Действующих ограничений нет.</p>
      )}

      <div className="space-y-2">
        {rows.map(r => (
          <div key={r.id} className={`rounded-lg border px-4 py-3 ${SEVERITY_STYLE[r.severity] ?? SEVERITY_STYLE.info}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  <span className="font-semibold text-sm">{r.title}</span>
                </div>
                <p className="text-sm text-[var(--text-secondary)] leading-relaxed mt-1">{r.message}</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  {ZONES.find(z => z.value === r.zone)?.label ?? r.zone} · {r.source}
                  {r.active_until !== null && ` · до ${new Date(r.active_until).toLocaleString('ru-RU')}`}
                </p>
              </div>
              <button
                onClick={() => remove(r.id)}
                className="ds-btn ds-btn-secondary flex-shrink-0"
                title="Снять ограничение"
              >
                <X className="w-4 h-4" />
                Снять
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  AlertTriangle, Plus, Pencil, Trash2, X, Save, Loader2,
  Calendar, MapPin, Users, ExternalLink, ShieldAlert,
} from 'lucide-react';

interface Incident {
  id: number;
  slug: string;
  incident_date: string;
  title: string;
  location_name: string;
  location_type: string;
  casualties: number;
  injured: number;
  description: string;
  cause: string;
  lessons: string[];
  mchs_involved: boolean;
  source_url: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  volcano: 'Вулкан',
  river:   'Река',
  trail:   'Маршрут',
  sea:     'Море',
  glacier: 'Ледник',
};

const EMPTY_FORM: Omit<Incident, 'id'> = {
  slug: '', incident_date: '', title: '', location_name: '',
  location_type: 'volcano', casualties: 0, injured: 0,
  description: '', cause: '', lessons: [], mchs_involved: true, source_url: null,
};

function slugify(s: string) {
  return s.toLowerCase()
    .replace(/[а-яёА-ЯЁ]/g, c => {
      const map: Record<string, string> = {
        а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',
        к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',
        х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
      };
      return map[c.toLowerCase()] ?? '';
    })
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ── Modal form ──────────────────────────────────────────────────────────────

interface ModalProps {
  initial?: Incident | null;
  onSave: (data: Omit<Incident, 'id'>) => Promise<void>;
  onClose: () => void;
  saving: boolean;
}

function IncidentModal({ initial, onSave, onClose, saving }: ModalProps) {
  const [form, setForm] = useState<Omit<Incident, 'id'>>(
    initial ? { ...initial } : { ...EMPTY_FORM }
  );
  const [lessonsText, setLessonsText] = useState(
    (initial?.lessons ?? []).join('\n')
  );

  function set<K extends keyof typeof form>(k: K, v: typeof form[K]) {
    setForm(prev => ({ ...prev, [k]: v }));
  }

  function handleTitleChange(v: string) {
    set('title', v);
    if (!initial) set('slug', slugify(v));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const lessons = lessonsText.split('\n').map(l => l.trim()).filter(Boolean);
    await onSave({ ...form, lessons });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 overflow-y-auto py-8 px-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg w-full max-w-2xl shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <h2 className="font-semibold text-[var(--text-primary)]">
            {initial ? 'Редактировать инцидент' : 'Добавить инцидент'}
          </h2>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={e => void handleSubmit(e)} className="p-6 space-y-4">

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="ds-label">Дата *</label>
              <input type="date" required value={form.incident_date}
                onChange={e => set('incident_date', e.target.value)}
                className="ds-input w-full" />
            </div>
            <div>
              <label className="ds-label">Тип локации *</label>
              <select value={form.location_type}
                onChange={e => set('location_type', e.target.value)}
                className="ds-input w-full">
                {Object.entries(TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="ds-label">Название *</label>
            <input type="text" required maxLength={500} value={form.title}
              onChange={e => handleTitleChange(e.target.value)}
              placeholder="Гибель N туристов на ..."
              className="ds-input w-full" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="ds-label">Slug (URL) *</label>
              <input type="text" required maxLength={120}
                pattern="[a-z0-9-]+"
                value={form.slug}
                onChange={e => set('slug', e.target.value)}
                className="ds-input w-full font-mono text-sm" />
            </div>
            <div>
              <label className="ds-label">Локация *</label>
              <input type="text" required value={form.location_name}
                onChange={e => set('location_name', e.target.value)}
                placeholder="Вулкан Ключевская сопка"
                className="ds-input w-full" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="ds-label">Погибших *</label>
              <input type="number" min={0} required value={form.casualties}
                onChange={e => set('casualties', +e.target.value)}
                className="ds-input w-full" />
            </div>
            <div>
              <label className="ds-label">Пострадавших</label>
              <input type="number" min={0} value={form.injured}
                onChange={e => set('injured', +e.target.value)}
                className="ds-input w-full" />
            </div>
          </div>

          <div>
            <label className="ds-label">Что произошло *</label>
            <textarea required rows={5} value={form.description}
              onChange={e => set('description', e.target.value)}
              className="ds-input w-full resize-y text-sm" />
          </div>

          <div>
            <label className="ds-label">Причины трагедии *</label>
            <textarea required rows={4} value={form.cause}
              onChange={e => set('cause', e.target.value)}
              className="ds-input w-full resize-y text-sm" />
          </div>

          <div>
            <label className="ds-label">
              Уроки безопасности * <span className="font-normal text-[var(--text-muted)]">(каждый урок с новой строки)</span>
            </label>
            <textarea required rows={5} value={lessonsText}
              onChange={e => setLessonsText(e.target.value)}
              placeholder={"Первый урок\nВторой урок\nТретий урок"}
              className="ds-input w-full resize-y text-sm" />
          </div>

          <div className="grid grid-cols-2 gap-4 items-center">
            <div>
              <label className="ds-label">Источник (URL)</label>
              <input type="url" value={form.source_url ?? ''}
                onChange={e => set('source_url', e.target.value || null)}
                placeholder="https://..."
                className="ds-input w-full text-sm" />
            </div>
            <div className="flex items-center gap-2 pt-5">
              <input type="checkbox" id="mchs" checked={form.mchs_involved}
                onChange={e => set('mchs_involved', e.target.checked)}
                className="w-4 h-4" />
              <label htmlFor="mchs" className="text-sm text-[var(--text-secondary)]">МЧС участвовало</label>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="ds-btn ds-btn-secondary text-sm px-4 py-2">
              Отмена
            </button>
            <button type="submit" disabled={saving}
              className="ds-btn ds-btn-primary text-sm px-4 py-2 flex items-center gap-2">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {initial ? 'Сохранить' : 'Добавить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Delete confirm ──────────────────────────────────────────────────────────

function DeleteModal({ title, onConfirm, onCancel, deleting }: {
  title: string; onConfirm: () => void; onCancel: () => void; deleting: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg w-full max-w-sm p-6 shadow-xl">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-9 h-9 rounded-full bg-[var(--danger)]/10 flex items-center justify-center">
            <Trash2 className="w-4 h-4 text-[var(--danger)]" />
          </div>
          <h3 className="font-semibold text-[var(--text-primary)]">Удалить инцидент?</h3>
        </div>
        <p className="text-sm text-[var(--text-secondary)] mb-5">
          «{title}» будет удалён безвозвратно.
        </p>
        <div className="flex gap-3">
          <button onClick={onCancel} className="ds-btn ds-btn-secondary flex-1 text-sm py-2">Отмена</button>
          <button onClick={onConfirm} disabled={deleting}
            className="ds-btn ds-btn-danger flex-1 text-sm py-2 flex items-center justify-center gap-2">
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Удалить
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export default function IncidentsAdminPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);

  const [editTarget, setEditTarget]     = useState<Incident | null>(null);
  const [showAdd, setShowAdd]           = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Incident | null>(null);

  const [saving, setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/incidents');
      const d = await r.json() as { success: boolean; data?: Incident[]; error?: string };
      if (!d.success) throw new Error(d.error ?? 'Ошибка загрузки');
      setIncidents(d.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleSave(data: Omit<Incident, 'id'>) {
    setSaving(true);
    try {
      const url  = editTarget ? `/api/admin/incidents/${editTarget.id}` : '/api/admin/incidents';
      const method = editTarget ? 'PATCH' : 'POST';
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const d = await r.json() as { success: boolean; error?: unknown };
      if (!d.success) throw new Error(JSON.stringify(d.error));
      setShowAdd(false);
      setEditTarget(null);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/admin/incidents/${deleteTarget.id}`, { method: 'DELETE' });
      const d = await r.json() as { success: boolean };
      if (!d.success) throw new Error('Ошибка удаления');
      setDeleteTarget(null);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setDeleting(false);
    }
  }

  const totalDeaths = incidents.reduce((s, r) => s + r.casualties, 0);

  return (
    <div className="p-5 lg:p-6 space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <ShieldAlert className="w-5 h-5 text-[var(--danger)]" />
            <h1 className="text-xl font-bold text-[var(--text-primary)]">Трагедии на маршрутах</h1>
          </div>
          <p className="text-sm text-[var(--text-muted)]">
            База задокументированных инцидентов · {incidents.length} записей · {totalDeaths} погибших
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="ds-btn ds-btn-primary flex items-center gap-2 text-sm px-4 py-2"
        >
          <Plus className="w-4 h-4" />
          Добавить
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="p-4 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/5 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Загрузка...
        </div>
      )}

      {/* Table */}
      {!loading && incidents.length === 0 && (
        <div className="text-center py-12 text-[var(--text-muted)] text-sm">
          Нет инцидентов. Добавьте первый.
        </div>
      )}

      {!loading && incidents.length > 0 && (
        <div className="space-y-2">
          {incidents.map(inc => (
            <div
              key={inc.id}
              className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 flex items-start gap-4"
            >
              {/* Icon */}
              <div className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--danger)]/10 mt-0.5">
                <AlertTriangle className="w-4 h-4 text-[var(--danger)]" />
              </div>

              {/* Main content */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[var(--text-primary)] leading-snug">
                  {inc.title}
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs text-[var(--text-muted)]">
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {formatDate(inc.incident_date)}
                  </span>
                  <span className="flex items-center gap-1">
                    <MapPin className="w-3 h-3" />
                    {inc.location_name}
                  </span>
                  <span className="flex items-center gap-1 text-[var(--danger)] font-medium">
                    <Users className="w-3 h-3" />
                    {inc.casualties} погибло
                  </span>
                  {inc.injured > 0 && (
                    <span className="text-[var(--warning)]">{inc.injured} пострадало</span>
                  )}
                  <span className="ds-badge text-[10px] px-2 py-0.5" style={{ background: 'var(--danger)', color: 'white', opacity: 0.85 }}>
                    {TYPE_LABELS[inc.location_type] ?? inc.location_type}
                  </span>
                  <span className="font-mono text-[var(--text-muted)]">/{inc.slug}</span>
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-1.5 line-clamp-2 leading-relaxed">
                  {inc.lessons.length} уроков · {inc.mchs_involved ? 'МЧС участвовало' : 'МЧС не участвовало'}
                  {inc.source_url && ' · '}
                  {inc.source_url && (
                    <a href={inc.source_url} target="_blank" rel="noopener noreferrer"
                      className="text-[var(--ocean)] hover:underline inline-flex items-center gap-0.5">
                      источник <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  )}
                </p>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <a
                  href={`/safety/incidents/${inc.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--ocean)] hover:bg-[var(--bg-hover)] transition-colors"
                  title="Открыть страницу"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <button
                  onClick={() => setEditTarget(inc)}
                  className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
                  title="Редактировать"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setDeleteTarget(inc)}
                  className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--bg-hover)] transition-colors"
                  title="Удалить"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modals */}
      {(showAdd || editTarget) && (
        <IncidentModal
          initial={editTarget}
          onSave={handleSave}
          onClose={() => { setShowAdd(false); setEditTarget(null); }}
          saving={saving}
        />
      )}

      {deleteTarget && (
        <DeleteModal
          title={deleteTarget.title}
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteTarget(null)}
          deleting={deleting}
        />
      )}
    </div>
  );
}

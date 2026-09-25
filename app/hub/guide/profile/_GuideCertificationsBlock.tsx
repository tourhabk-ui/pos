'use client';

import { useCallback, useEffect, useState } from 'react';
import { Award, Loader2, AlertTriangle, Plus, Pencil, Check, Clock, XCircle } from 'lucide-react';

/**
 * Аттестация гида: гид вносит аттестат сам (номер, дата выдачи, срок).
 *
 * До этого единственным писателем аттестатов был импорт реестра — без даты
 * выдачи, поэтому расчёт переаттестации (срок 01.10) отвечал «не знаю» почти
 * всем. Внесённое здесь уходит на проверку администратору и до его решения
 * не считается подтверждённым: витрина `/guides` показывает только
 * подтверждённые аттестаты.
 */

type Review = 'verified' | 'pending' | 'rejected';

interface Cert {
  id: string;
  name: string;
  issuingAuthority: string;
  certificateNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  review: Review;
  reviewComment: string | null;
}

interface FormState {
  id: string | null;
  name: string;
  issuingAuthority: string;
  certificateNumber: string;
  issueDate: string;
  expiryDate: string;
}

const EMPTY: FormState = {
  id: null,
  name: 'Аттестация инструктора-проводника',
  issuingAuthority: '',
  certificateNumber: '',
  issueDate: '',
  expiryDate: '',
};

const INPUT =
  'w-full min-h-[44px] px-4 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)] transition-colors';

const REVIEW_VIEW: Record<Review, { label: string; cls: string; Icon: typeof Check }> = {
  verified: { label: 'Подтверждён', cls: 'text-[var(--success)]', Icon: Check },
  pending: { label: 'На проверке', cls: 'text-[var(--warning)]', Icon: Clock },
  rejected: { label: 'Отклонён', cls: 'text-[var(--danger)]', Icon: XCircle },
};

function fmt(iso: string | null): string {
  if (!iso) return 'не указана';
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? 'не указана' : d.toLocaleDateString('ru-RU');
}

export default function GuideCertificationsBlock() {
  const [items, setItems] = useState<Cert[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/guide/certifications');
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok || (json as { success?: boolean } | null)?.success !== true) {
        setLoadError((json as { error?: string } | null)?.error ?? 'Не удалось загрузить аттестаты');
        return;
      }
      setItems((json as { data: { items: Cert[] } }).data.items);
    } catch {
      setLoadError('Сеть недоступна — аттестаты не загружены');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = JSON.stringify({
        name: form.name,
        issuingAuthority: form.issuingAuthority,
        certificateNumber: form.certificateNumber,
        issueDate: form.issueDate,
        expiryDate: form.expiryDate || null,
      });
      const headers = { 'Content-Type': 'application/json' };
      const res = form.id
        ? await fetch(`/api/guide/certifications/${form.id}`, { method: 'PUT', headers, body: payload })
        : await fetch('/api/guide/certifications', { method: 'POST', headers, body: payload });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok || (json as { success?: boolean } | null)?.success !== true) {
        setSaveError((json as { error?: string } | null)?.error ?? `Аттестат не сохранён (HTTP ${res.status})`);
        return;
      }
      setForm(null);
      await load();
    } catch {
      setSaveError('Сеть недоступна — аттестат не сохранён');
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Award className="w-5 h-5 text-[var(--ocean)]" /> Аттестация
        </h2>
        {!form && !loadError && (
          <button type="button" onClick={() => { setSaveError(null); setForm(EMPTY); }}
            className="inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-lg border border-[var(--border)] text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
            <Plus className="w-4 h-4" /> Добавить аттестат
          </button>
        )}
      </div>
      <p className="text-sm text-[var(--text-secondary)]">
        Укажите дату выдачи — по ней платформа видит, нужна ли вам переаттестация до 1 октября.
        Внесённый аттестат проверяет администратор; до проверки он не показывается туристам.
      </p>

      {loading ? (
        <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>
      ) : loadError ? (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 text-sm text-[var(--text-primary)]">
          <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--danger)] flex-shrink-0" />
          <span>{loadError}</span>
        </div>
      ) : items.length === 0 && !form ? (
        <p className="text-sm text-[var(--text-muted)]">Аттестатов пока нет.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {items.map((c) => {
            const view = REVIEW_VIEW[c.review];
            return (
              <li key={c.id} className="py-3 flex items-start justify-between gap-3">
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-[var(--text-primary)]">{c.name}</p>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">
                    {c.issuingAuthority} · № {c.certificateNumber ?? 'не указан'} · выдан {fmt(c.issueDate)}
                    {c.expiryDate ? ` · действует до ${fmt(c.expiryDate)}` : ''}
                  </p>
                  <p className={`text-xs mt-1 inline-flex items-center gap-1 ${view.cls}`}>
                    <view.Icon className="w-3.5 h-3.5" /> {view.label}
                  </p>
                  {c.review === 'rejected' && c.reviewComment && (
                    <p className="text-xs text-[var(--text-secondary)] mt-1">Причина: {c.reviewComment}</p>
                  )}
                </div>
                <button type="button"
                  onClick={() => {
                    setSaveError(null);
                    setForm({
                      id: c.id, name: c.name, issuingAuthority: c.issuingAuthority,
                      certificateNumber: c.certificateNumber ?? '', issueDate: c.issueDate ?? '', expiryDate: c.expiryDate ?? '',
                    });
                  }}
                  className="inline-flex items-center gap-1 text-xs text-[var(--ocean)] hover:underline shrink-0">
                  <Pencil className="w-3 h-3" /> Изменить
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {form && (
        <form onSubmit={save} className="space-y-3 border-t border-[var(--border)] pt-4">
          {form.id && (
            <p className="text-xs text-[var(--text-muted)]">
              После правки аттестат снова уйдёт на проверку.
            </p>
          )}
          <label className="block">
            <span className="text-sm text-[var(--text-secondary)] mb-1.5 block">Вид аттестации</span>
            <input value={form.name} onChange={set('name')} className={INPUT} required />
          </label>
          <label className="block">
            <span className="text-sm text-[var(--text-secondary)] mb-1.5 block">Кем выдан</span>
            <input value={form.issuingAuthority} onChange={set('issuingAuthority')} className={INPUT}
              placeholder="Федерация спортивного туризма России" required />
          </label>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="block">
              <span className="text-sm text-[var(--text-secondary)] mb-1.5 block">Номер</span>
              <input value={form.certificateNumber} onChange={set('certificateNumber')} className={INPUT} required />
            </label>
            <label className="block">
              <span className="text-sm text-[var(--text-secondary)] mb-1.5 block">Дата выдачи</span>
              <input type="date" value={form.issueDate} onChange={set('issueDate')} className={INPUT} required />
            </label>
            <label className="block">
              <span className="text-sm text-[var(--text-secondary)] mb-1.5 block">Действует до (если указано)</span>
              <input type="date" value={form.expiryDate} onChange={set('expiryDate')} className={INPUT} />
            </label>
          </div>
          {saveError && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 text-sm text-[var(--text-primary)]">
              <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--danger)] flex-shrink-0" />
              <span>{saveError}</span>
            </div>
          )}
          <div className="flex gap-2">
            <button type="submit" disabled={saving}
              className="min-h-[44px] px-5 bg-[var(--accent)] hover:opacity-90 text-white rounded-lg font-medium inline-flex items-center gap-2 disabled:opacity-50 transition-all duration-200">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Отправить на проверку
            </button>
            <button type="button" onClick={() => setForm(null)}
              className="min-h-[44px] px-4 rounded-lg border border-[var(--border)] text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
              Отмена
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

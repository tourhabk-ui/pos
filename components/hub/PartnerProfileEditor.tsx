'use client';

import { useEffect, useState } from 'react';
import { Loader2, Check, Phone, Globe } from 'lucide-react';

/**
 * Общий редактор профиля партнёра (гид, агент, ...): загрузка из
 * GET /api/partners/profile, сохранение через PATCH /api/partners/profile
 * (тот же контракт, что онбординг-визард). Единая реализация для
 * партнёрских кабинетов — раньше жила отдельно в _GuideProfileForm.
 */

const INPUT = 'w-full px-3.5 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors';
const LABEL = 'block text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1.5';

interface PartnerProfile {
  name: string;
  description: string | null;
  contact: Record<string, string> | null;
}

export default function PartnerProfileEditor({ namePlaceholder }: { namePlaceholder: string }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [phone, setPhone] = useState('');
  const [telegram, setTelegram] = useState('');
  const [website, setWebsite] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/partners/profile')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: { partner?: PartnerProfile } } | null) => {
        if (cancelled) return;
        const p = d?.data?.partner;
        if (!p) { setFailed(true); return; }
        setName(p.name ?? '');
        setDescription(p.description ?? '');
        setPhone(p.contact?.phone ?? '');
        setTelegram(p.contact?.telegram ?? '');
        setWebsite(p.contact?.website ?? '');
      })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function save() {
    if (!name.trim()) { setError('Укажите имя'); return; }
    if (!description.trim()) { setError('Заполните описание'); return; }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/partners/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description, phone, telegram, website }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !d.success) { setError(d.error || 'Не удалось сохранить'); return; }
      setSaved(true);
    } catch {
      setError('Сетевая ошибка');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (failed) {
    return <p className="text-sm text-[var(--danger)]">Не удалось загрузить профиль. Обновите страницу.</p>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 space-y-3">
        <p className="text-xs font-medium text-[var(--text-secondary)]">Основное</p>
        <div>
          <label htmlFor="pp-name" className={LABEL}>Имя / название</label>
          <input id="pp-name" className={INPUT} value={name} maxLength={255}
            placeholder={namePlaceholder} onChange={e => { setName(e.target.value); setSaved(false); }} />
        </div>
        <div>
          <label htmlFor="pp-desc" className={LABEL}>О себе</label>
          <textarea id="pp-desc" className={`${INPUT} resize-none`} rows={4} value={description} maxLength={2000}
            placeholder="Опыт, специализация, чем отличаетесь..."
            onChange={e => { setDescription(e.target.value); setSaved(false); }} />
          <p className="text-[10px] text-[var(--text-muted)] mt-1">{description.length}/2000</p>
        </div>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 space-y-3">
        <p className="text-xs font-medium text-[var(--text-secondary)]">Контакты</p>
        <div>
          <label htmlFor="pp-phone" className={LABEL}><Phone className="w-3 h-3 inline mr-1" />Телефон</label>
          <input id="pp-phone" className={INPUT} value={phone}
            placeholder="+7 (900) 000-00-00" onChange={e => { setPhone(e.target.value); setSaved(false); }} />
        </div>
        <div>
          <label htmlFor="pp-tg" className={LABEL}>Telegram</label>
          <input id="pp-tg" className={INPUT} value={telegram}
            placeholder="@username" onChange={e => { setTelegram(e.target.value); setSaved(false); }} />
        </div>
        <div>
          <label htmlFor="pp-web" className={LABEL}><Globe className="w-3 h-3 inline mr-1" />Сайт</label>
          <input id="pp-web" className={INPUT} value={website}
            placeholder="https://yoursite.ru" onChange={e => { setWebsite(e.target.value); setSaved(false); }} />
        </div>
      </div>

      <div className="lg:col-span-2 flex items-center justify-end gap-3">
        {error && <span className="text-xs text-[var(--danger)]">{error}</span>}
        {saved && <span className="text-xs text-[var(--success)] flex items-center gap-1"><Check className="w-3.5 h-3.5" />Сохранено</span>}
        <button onClick={save} disabled={saving}
          className="px-4 py-2 text-xs font-medium bg-[var(--accent)] text-white rounded-md hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Сохранить изменения
        </button>
      </div>
    </div>
  );
}

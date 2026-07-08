'use client';

import { useState } from 'react';
import { ChevronRight, Loader2, Phone, Globe } from 'lucide-react';

/**
 * Шаг «профиль» онбординга партнёра (gear/stay): название, описание,
 * контакты → PATCH /api/partners/profile. Общий для визардов.
 */

export interface PartnerProfileData {
  name: string;
  description: string | null;
  contact: Record<string, string> | null;
}

export default function PartnerProfileStep({
  profile,
  namePlaceholder,
  onNext,
}: {
  profile: PartnerProfileData;
  namePlaceholder: string;
  onNext: () => void;
}) {
  const [name, setName] = useState(profile.name ?? '');
  const [description, setDescription] = useState(profile.description ?? '');
  const [phone, setPhone] = useState(profile.contact?.phone ?? '');
  const [telegram, setTelegram] = useState(profile.contact?.telegram ?? '');
  const [website, setWebsite] = useState(profile.contact?.website ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!name.trim()) { setError('Укажите название'); return; }
    if (!description.trim()) { setError('Заполните описание'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/partners/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description, phone, telegram, website }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !d.success) {
        setError(d.error || 'Ошибка сохранения');
        return;
      }
      onNext();
    } catch {
      setError('Сетевая ошибка');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <label className="ds-label">Название <span className="text-[var(--danger)]">*</span></label>
        <input className="ds-input" value={name} placeholder={namePlaceholder}
          maxLength={255} onChange={e => setName(e.target.value)} />
      </div>

      <div>
        <label className="ds-label">Описание <span className="text-[var(--danger)]">*</span></label>
        <textarea className="ds-input resize-none" rows={4} value={description} maxLength={2000}
          placeholder="Расскажите о себе: опыт, что предлагаете, чем отличаетесь..."
          onChange={e => setDescription(e.target.value)} />
        <p className="text-[10px] text-[var(--text-muted)] mt-1">{description.length}/2000</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="ds-label"><Phone className="w-3.5 h-3.5 inline mr-1" />Телефон</label>
          <input className="ds-input" value={phone} placeholder="+7 (900) 000-00-00"
            onChange={e => setPhone(e.target.value)} />
        </div>
        <div>
          <label className="ds-label">Telegram</label>
          <input className="ds-input" value={telegram} placeholder="@username"
            onChange={e => setTelegram(e.target.value)} />
        </div>
      </div>

      <div>
        <label className="ds-label"><Globe className="w-3.5 h-3.5 inline mr-1" />Сайт (необязательно)</label>
        <input className="ds-input" value={website} placeholder="https://yoursite.ru"
          onChange={e => setWebsite(e.target.value)} />
      </div>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      <button
        onClick={save}
        disabled={saving}
        className="w-full flex items-center justify-center gap-2 py-3 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
      >
        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
        Сохранить и продолжить
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );
}

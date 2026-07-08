'use client';

import { useState } from 'react';
import { Building2, Home, Loader2, Check } from 'lucide-react';
import OnboardingWizard from '@/components/hub/OnboardingWizard';
import PartnerProfileStep from '@/components/hub/PartnerProfileStep';
import { usePartnerOnboarding } from '@/components/hub/usePartnerOnboarding';
import { ACCOMMODATION_TYPES, ACCOMMODATION_TYPE_LABELS } from '@/lib/stay/accommodation-types';

/**
 * Онбординг владельца жилья: профиль → первый объект.
 * Объект создаётся через POST /api/stay/accommodations (owner-create) —
 * раньше это мог только администратор. Координаты обязательны по схеме
 * (coordinates NOT NULL) — честно спрашиваем, не подставляем выдуманные.
 */

const STEPS = [
  { icon: Building2, label: 'Профиль владельца' },
  { icon: Home, label: 'Первый объект' },
];

function FirstObjectStep({ onFinish }: { onFinish: (created: boolean) => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('guesthouse');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [totalRooms, setTotalRooms] = useState('1');
  const [priceFrom, setPriceFrom] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Валидация зеркалит серверную Zod-схему (включая диапазоны координат)
  const latNum = Number(lat);
  const lngNum = Number(lng);
  const valid =
    name.trim().length >= 3 &&
    description.trim().length >= 10 &&
    address.trim().length >= 5 &&
    lat !== '' && Number.isFinite(latNum) && latNum >= -90 && latNum <= 90 &&
    lng !== '' && Number.isFinite(lngNum) && lngNum >= -180 && lngNum <= 180 &&
    Number(totalRooms) >= 1 &&
    Number(priceFrom) > 0;

  async function create() {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/stay/accommodations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          type,
          description: description.trim(),
          address: address.trim(),
          coordinates: { lat: Number(lat), lng: Number(lng) },
          totalRooms: Number(totalRooms),
          pricePerNightFrom: Number(priceFrom),
        }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !d.success) {
        setError(d.error || 'Не удалось создать объект');
        return;
      }
      onFinish(true);
    } catch {
      setError('Сетевая ошибка');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="ds-label">Название объекта <span className="text-[var(--danger)]">*</span></label>
        <input className="ds-input" value={name} placeholder="Гостевой дом «У вулкана»"
          onChange={e => setName(e.target.value)} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="ds-label">Тип</label>
          <select className="ds-input" value={type} onChange={e => setType(e.target.value)}>
            {ACCOMMODATION_TYPES.map(t => <option key={t} value={t}>{ACCOMMODATION_TYPE_LABELS[t]}</option>)}
          </select>
        </div>
        <div>
          <label className="ds-label">Номеров всего <span className="text-[var(--danger)]">*</span></label>
          <input className="ds-input" type="number" min="1" value={totalRooms}
            onChange={e => setTotalRooms(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="ds-label">Описание <span className="text-[var(--danger)]">*</span></label>
        <textarea className="ds-input resize-none" rows={3} value={description} maxLength={5000}
          placeholder="Что за место, что рядом, чем удобно туристу..."
          onChange={e => setDescription(e.target.value)} />
      </div>
      <div>
        <label className="ds-label">Адрес <span className="text-[var(--danger)]">*</span></label>
        <input className="ds-input" value={address} placeholder="Паратунка, ул. Термальная, 1"
          onChange={e => setAddress(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="ds-label">Широта <span className="text-[var(--danger)]">*</span></label>
          <input className="ds-input" type="number" step="any" value={lat} placeholder="52.9646"
            onChange={e => setLat(e.target.value)} />
        </div>
        <div>
          <label className="ds-label">Долгота <span className="text-[var(--danger)]">*</span></label>
          <input className="ds-input" type="number" step="any" value={lng} placeholder="158.2465"
            onChange={e => setLng(e.target.value)} />
        </div>
      </div>
      <p className="text-[10px] text-[var(--text-muted)]">
        Координаты можно скопировать из Яндекс.Карт или Organic Maps — правый клик по точке.
      </p>
      <div>
        <label className="ds-label">Цена от, ₽/ночь <span className="text-[var(--danger)]">*</span></label>
        <input className="ds-input" type="number" min="1" value={priceFrom}
          onChange={e => setPriceFrom(e.target.value)} />
      </div>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      <div className="flex gap-3">
        <button
          onClick={() => onFinish(false)}
          disabled={saving}
          className="flex-1 py-3 border border-[var(--border)] text-[var(--text-secondary)] rounded-lg text-sm hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
        >
          Добавить позже
        </button>
        <button
          onClick={create}
          disabled={!valid || saving}
          className="flex-1 flex items-center justify-center gap-2 py-3 bg-[var(--accent)] hover:bg-[var(--accent)]/90 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          Создать объект
        </button>
      </div>
    </div>
  );
}

export default function StayOnboardingClient() {
  const [step, setStep] = useState(0);
  const { profile, loading, completeOnboarding } = usePartnerOnboarding('/hub/stay');

  async function finish(created: boolean) {
    await completeOnboarding(created ? '/hub/stay/accommodations' : '/hub/stay');
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (!profile) {
    return <div className="text-center py-20 text-[var(--text-secondary)]">Профиль не найден</div>;
  }

  return (
    <OnboardingWizard
      title="Кабинет владельца жилья"
      subtitle="Профиль и первый объект — и брони начнут приходить сюда"
      steps={STEPS}
      current={step}
    >
      {step === 0 && (
        <PartnerProfileStep
          profile={profile}
          namePlaceholder="Гостевой дом «У вулкана»"
          onNext={() => setStep(1)}
        />
      )}
      {step === 1 && <FirstObjectStep onFinish={finish} />}
    </OnboardingWizard>
  );
}

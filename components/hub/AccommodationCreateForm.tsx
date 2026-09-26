'use client';

import { useState } from 'react';
import { Loader2, Check } from 'lucide-react';
import { ACCOMMODATION_TYPES, ACCOMMODATION_TYPE_LABELS } from '@/lib/stay/accommodation-types';
import { ZONE_IDS, ZONE_NAMES, type ZoneId } from '@/lib/planner/constants';

/**
 * Форма нового объекта жилья — одна на онбординг и на «Добавить объект»
 * в кабинете (/hub/stay/accommodations/new). До 26.09 форма жила только в
 * онбординге, а онбординг уводит прошедших его обратно в /hub/stay:
 * второй объект завести было негде.
 *
 * Шлёт POST /api/stay/accommodations. Объект создаётся НА ПРОВЕРКЕ и на
 * витрину выходит после одобрения администратором (миграция 1027).
 *
 * Координаты обязательны по схеме (coordinates NOT NULL) — спрашиваем
 * честно, не подставляем выдуманные. Адрес, число номеров и цена «от» —
 * необязательны, как и на сервере (миграция 1006): «не знаю» лучше выдумки.
 *
 * Зона для планера обязательна (решение владельца 26.09, миграция 1030):
 * по ней планер поездки предлагает объект на ночи плана. Выбирает владелец —
 * он знает, где стоит его дом; по тексту адреса зону не угадываем.
 */

interface Props {
  onCreated: () => void | Promise<void>;
  /** Вторая кнопка: «Добавить позже» в онбординге, «Отмена» в кабинете. */
  secondary?: { label: string; onClick: () => void };
  submitLabel?: string;
}

export default function AccommodationCreateForm({ onCreated, secondary, submitLabel = 'Создать объект' }: Props) {
  const [name, setName] = useState('');
  const [type, setType] = useState('guesthouse');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [totalRooms, setTotalRooms] = useState('');
  const [priceFrom, setPriceFrom] = useState('');
  const [plannerZone, setPlannerZone] = useState<ZoneId | ''>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Валидация зеркалит серверную Zod-схему: обязательные — всегда,
  // необязательные — только если заполнены.
  const latNum = Number(lat);
  const lngNum = Number(lng);
  const addressOk = address.trim() === '' || address.trim().length >= 5;
  const roomsOk = totalRooms === '' || (Number.isInteger(Number(totalRooms)) && Number(totalRooms) >= 1);
  const priceOk = priceFrom === '' || (Number.isFinite(Number(priceFrom)) && Number(priceFrom) >= 0);
  const valid =
    name.trim().length >= 3 &&
    description.trim().length >= 10 &&
    lat !== '' && Number.isFinite(latNum) && latNum >= -90 && latNum <= 90 &&
    lng !== '' && Number.isFinite(lngNum) && lngNum >= -180 && lngNum <= 180 &&
    addressOk && roomsOk && priceOk && plannerZone !== '';

  async function create() {
    setSaving(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        type,
        description: description.trim(),
        coordinates: { lat: latNum, lng: lngNum },
        plannerZone,
      };
      if (address.trim()) payload.address = address.trim();
      if (totalRooms !== '') payload.totalRooms = Number(totalRooms);
      if (priceFrom !== '') payload.pricePerNightFrom = Number(priceFrom);

      const res = await fetch('/api/stay/accommodations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !d.success) {
        setError(d.error || 'Не удалось создать объект');
        return;
      }
      await onCreated();
    } catch {
      setError('Сетевая ошибка');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="ds-label" htmlFor="acc-name">Название объекта <span className="text-[var(--danger)]">*</span></label>
        <input id="acc-name" className="ds-input" value={name} placeholder="Гостевой дом «У вулкана»"
          onChange={e => setName(e.target.value)} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="ds-label" htmlFor="acc-type">Тип</label>
          <select id="acc-type" className="ds-input" value={type} onChange={e => setType(e.target.value)}>
            {ACCOMMODATION_TYPES.map(t => <option key={t} value={t}>{ACCOMMODATION_TYPE_LABELS[t]}</option>)}
          </select>
        </div>
        <div>
          <label className="ds-label" htmlFor="acc-rooms">Номеров всего (необязательно)</label>
          <input id="acc-rooms" className="ds-input" type="number" min="1" value={totalRooms}
            onChange={e => setTotalRooms(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="ds-label" htmlFor="acc-desc">Описание <span className="text-[var(--danger)]">*</span></label>
        <textarea id="acc-desc" className="ds-input resize-none" rows={3} value={description} maxLength={5000}
          placeholder="Что за место, что рядом, чем удобно туристу..."
          onChange={e => setDescription(e.target.value)} />
      </div>
      <div>
        <label className="ds-label" htmlFor="acc-address">Адрес (необязательно)</label>
        <input id="acc-address" className="ds-input" value={address} placeholder="Паратунка, ул. Термальная, 1"
          onChange={e => setAddress(e.target.value)} />
        {!addressOk && <p className="text-xs text-[var(--danger)] mt-1">Адрес — не короче 5 символов или оставьте пустым</p>}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="ds-label" htmlFor="acc-lat">Широта <span className="text-[var(--danger)]">*</span></label>
          <input id="acc-lat" className="ds-input" type="number" step="any" value={lat} placeholder="52.9646"
            onChange={e => setLat(e.target.value)} />
        </div>
        <div>
          <label className="ds-label" htmlFor="acc-lng">Долгота <span className="text-[var(--danger)]">*</span></label>
          <input id="acc-lng" className="ds-input" type="number" step="any" value={lng} placeholder="158.2465"
            onChange={e => setLng(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="ds-label" htmlFor="acc-planner-zone">
          Зона для планера <span className="text-[var(--danger)]">*</span>
        </label>
        <select id="acc-planner-zone" className="ds-input" value={plannerZone} required
          onChange={e => {
            const v = e.target.value;
            setPlannerZone((ZONE_IDS as readonly string[]).includes(v) ? v as ZoneId : '');
          }}>
          <option value="">Выберите зону</option>
          {ZONE_IDS.map(z => <option key={z} value={z}>{ZONE_NAMES[z]}</option>)}
        </select>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          По зоне планер поездок предложит ваш объект туристу, который ночует в этом районе.
        </p>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Координаты можно скопировать из Яндекс.Карт или Organic Maps — правый клик по точке.
      </p>
      <div>
        <label className="ds-label" htmlFor="acc-price">Цена от, ₽/ночь (необязательно)</label>
        <input id="acc-price" className="ds-input" type="number" min="0" value={priceFrom}
          onChange={e => setPriceFrom(e.target.value)} />
      </div>

      <p className="text-xs text-[var(--text-secondary)]">
        Новый объект уходит на проверку платформы и появится на витрине после одобрения.
      </p>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      <div className="flex gap-3">
        {secondary && (
          <button
            type="button"
            onClick={secondary.onClick}
            disabled={saving}
            className="ds-btn ds-btn-secondary flex-1"
          >
            {secondary.label}
          </button>
        )}
        <button
          type="button"
          onClick={create}
          disabled={!valid || saving}
          className="ds-btn ds-btn-primary flex-1 inline-flex items-center justify-center gap-2"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

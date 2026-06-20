'use client';

import React, { useState } from 'react';
import { X, MapPin, CheckCircle } from 'lucide-react';
import type { NearbyPlace } from '@/hooks/usePlaceProximity';

interface Props {
  place: NearbyPlace;
  userPos?: { lat: number; lng: number } | null;
  onDismiss: () => void;
}

const CONDITIONS = [
  { id: 'trail_ok',      label: 'Тропа проходима' },
  { id: 'trail_blocked', label: 'Тропа закрыта / размыта' },
  { id: 'bears',         label: 'Медведи замечены' },
  { id: 'crowded',       label: 'Многолюдно' },
  { id: 'quiet',         label: 'Безлюдно' },
  { id: 'signal_ok',     label: 'Связь есть' },
  { id: 'signal_none',   label: 'Связи нет' },
  { id: 'access_closed', label: 'Проход закрыт' },
];

type Step = 'prompt' | 'detail' | 'done';

export function SafetyReportPrompt({ place, userPos, onDismiss }: Props) {
  const [step, setStep]             = useState<Step>('prompt');
  const [selected, setSelected]     = useState<Set<string>>(new Set());
  const [note, setNote]             = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(is_ok: boolean) {
    setSubmitting(true);
    try {
      await fetch(`/api/places/${place.id}/safety-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_ok,
          conditions: [...selected],
          note: note.trim() || undefined,
          lat: userPos?.lat,
          lng: userPos?.lng,
        }),
      });
    } catch { /* офлайн — не критично */ }
    setStep('done');
  }

  function toggleCondition(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  if (step === 'done') {
    return (
      <div
        className="fixed bottom-20 left-3 right-3 z-[499] rounded-lg shadow-xl p-4 flex items-center gap-3"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
      >
        <CheckCircle size={20} style={{ color: 'var(--success)', flexShrink: 0 }} />
        <p className="text-sm flex-1" style={{ color: 'var(--text-secondary)' }}>
          Ваш отчёт поможет тем, кто пойдёт сюда после вас
        </p>
        <button onClick={onDismiss} className="p-1" style={{ color: 'var(--text-muted)' }} aria-label="Закрыть">
          <X size={16} />
        </button>
      </div>
    );
  }

  if (step === 'detail') {
    return (
      <div
        className="fixed bottom-20 left-3 right-3 z-[499] rounded-lg shadow-xl"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
            Что важно знать следующему туристу?
          </p>
          <button onClick={onDismiss} className="p-1" style={{ color: 'var(--text-muted)' }} aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>

        <div className="px-4 pb-2 flex flex-wrap gap-2">
          {CONDITIONS.map(c => (
            <button
              key={c.id}
              onClick={() => toggleCondition(c.id)}
              className="text-xs px-2.5 py-1 rounded-full border transition-colors"
              style={{
                background: selected.has(c.id) ? 'var(--accent)' : 'var(--bg-hover)',
                color: selected.has(c.id) ? 'var(--bg-card)' : 'var(--text-secondary)',
                borderColor: selected.has(c.id) ? 'var(--accent)' : 'var(--border)',
              }}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="px-4 pb-3">
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            maxLength={300}
            placeholder="Дополнительно (необязательно)"
            rows={2}
            className="ds-input w-full text-sm resize-none"
          />
        </div>

        <div className="px-4 pb-4 flex gap-2">
          <button
            onClick={() => submit(selected.size === 0)}
            disabled={submitting}
            className="ds-btn ds-btn-primary flex-1 text-sm py-2"
          >
            {submitting ? 'Отправляю...' : 'Отправить'}
          </button>
        </div>
      </div>
    );
  }

  // step === 'prompt'
  return (
    <div
      className="fixed bottom-20 left-3 right-3 z-[499] rounded-lg shadow-xl"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-start gap-3 p-4">
        <MapPin size={18} style={{ color: 'var(--ocean)', flexShrink: 0, marginTop: 2 }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold leading-tight" style={{ color: 'var(--text-primary)' }}>
            Вы у {place.title}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Как сейчас обстановка? Помогите тем, кто пойдёт сюда после вас
          </p>
        </div>
        <button onClick={onDismiss} className="p-1 -mr-1 -mt-1" style={{ color: 'var(--text-muted)' }} aria-label="Закрыть">
          <X size={16} />
        </button>
      </div>

      <div className="px-4 pb-4 flex gap-2">
        <button
          onClick={() => submit(true)}
          className="ds-btn ds-btn-secondary flex-1 text-xs py-2"
        >
          Всё нормально
        </button>
        <button
          onClick={() => setStep('detail')}
          className="ds-btn ds-btn-primary flex-1 text-xs py-2"
        >
          Есть что отметить
        </button>
      </div>
    </div>
  );
}

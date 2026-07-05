'use client';

/**
 * TrailReportSheet — bottom-sheet «Сообщить о наблюдении» (медведь, камнепад,
 * погода) с мобильного дашборда. Простой sheet на Tailwind-транзишенах,
 * без сторонних библиотек (vaul/shadcn — против стека, CLAUDE.md §3).
 *
 * Trust-first: репорт уходит в status=pending и появится в радаре только
 * после модерации владельцем — говорим это туристу прямо.
 */

import { useState } from 'react';
import { PawPrint, Mountain, CloudRain, CircleHelp, MapPin, X, LoaderCircle } from 'lucide-react';

const REPORT_TYPES = [
  { value: 'bear',     label: 'Медведь',  icon: PawPrint },
  { value: 'rockfall', label: 'Камнепад', icon: Mountain },
  { value: 'weather',  label: 'Погода',   icon: CloudRain },
  { value: 'other',    label: 'Другое',   icon: CircleHelp },
] as const;

type ReportType = typeof REPORT_TYPES[number]['value'];

interface TrailReportSheetProps {
  open: boolean;
  onClose: () => void;
}

export function TrailReportSheet({ open, onClose }: TrailReportSheetProps) {
  const [type, setType] = useState<ReportType>('bear');
  const [text, setText] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const attachLocation = () => {
    if (!('geolocation' in navigator)) return;
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      pos => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGeoBusy(false);
      },
      () => setGeoBusy(false),
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch('/api/safety/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_type: type,
          text: text.trim(),
          ...(coords ?? {}),
        }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success) {
        setResult({ ok: true, message: json.message ?? 'Наблюдение отправлено на проверку.' });
        setText('');
        setCoords(null);
      } else {
        setResult({ ok: false, message: json?.error ?? 'Не удалось отправить. Попробуйте позже.' });
      }
    } catch {
      setResult({ ok: false, message: 'Нет связи. Попробуйте, когда появится сеть.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={`fixed inset-0 z-[110] transition-all duration-200 ${open ? 'visible' : 'invisible'}`}
      aria-hidden={!open}
    >
      {/* Затемнение */}
      <button
        type="button"
        aria-label="Закрыть"
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
      />

      {/* Панель */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Сообщить о наблюдении"
        className={`absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-[var(--border)] bg-[var(--bg-card)] p-5 pb-8 transition-transform duration-200 ${open ? 'translate-y-0' : 'translate-y-full'}`}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-playfair text-lg font-bold text-[var(--text-primary)]">
            Сообщить о наблюдении
          </h2>
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] transition-all duration-200 active:bg-[var(--bg-hover)]"
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          Появится в радаре после проверки модератором — как наблюдение туриста, не официальные данные.
        </p>

        <form onSubmit={submit} className="mt-4">
          <div className="grid grid-cols-4 gap-2">
            {REPORT_TYPES.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setType(value)}
                aria-pressed={type === value}
                className="flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-xs transition-all duration-200"
                style={{
                  borderColor: type === value ? 'var(--accent)' : 'var(--border)',
                  color: type === value ? 'var(--accent)' : 'var(--text-secondary)',
                  background: type === value ? 'var(--bg-hover)' : 'transparent',
                }}
              >
                <Icon size={18} strokeWidth={1.5} aria-hidden />
                {label}
              </button>
            ))}
          </div>

          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            required
            minLength={3}
            maxLength={500}
            rows={3}
            placeholder="Что и где вы видели? Например: медведица с медвежатами у тропы к перевалу"
            className="mt-3 w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
            aria-label="Описание наблюдения"
          />

          <button
            type="button"
            onClick={attachLocation}
            disabled={geoBusy}
            className="mt-2 flex items-center gap-1.5 text-xs text-[var(--ocean)] transition-all duration-200 active:opacity-70"
          >
            {geoBusy
              ? <LoaderCircle size={14} strokeWidth={1.5} className="animate-spin" aria-hidden />
              : <MapPin size={14} strokeWidth={1.5} aria-hidden />}
            {coords
              ? `Координаты прикреплены: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`
              : 'Прикрепить мои координаты'}
          </button>

          {result && (
            <p
              className="mt-3 text-sm"
              style={{ color: result.ok ? 'var(--success)' : 'var(--danger)' }}
              role="status"
            >
              {result.message}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || text.trim().length < 3}
            className="mt-4 w-full rounded-lg bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition-all duration-200 active:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Отправляем…' : 'Отправить на проверку'}
          </button>
        </form>
      </div>
    </div>
  );
}

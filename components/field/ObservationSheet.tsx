'use client';

/**
 * Наблюдение с экрана маршрута (владелец 27.08).
 *
 * Перенос с главной: там форма (TrailReportSheet) жила без контекста —
 * координаты просили отдельной кнопкой, фото не было, а без сети текст
 * ПРОПАДАЛ. На экране «На маршруте» координаты и офлайн-статус система
 * знает сама; человеку остаются категория, описание и снимок.
 *
 * Дисциплина отправки — та же, что у полевых проверок (/field-check):
 * СНАЧАЛА на диск (IndexedDB), потом попытка отправить; слушатель `online`
 * дожимает очередь. Фото не блокирует наблюдение: сначала уходят текст и
 * координаты, затем снимки по одному (см. /api/safety/reports/photo).
 *
 * Категории — полевые (миграция 917): Животное, Растение, Опасность,
 * Тропа, Другое. Кнопка сохранения честна о судьбе записи: онлайн —
 * «Отправить», без сети — «Сохранить — отправится, когда появится сеть».
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PawPrint, Leaf, AlertTriangle, Footprints, MoreHorizontal, Camera, ImagePlus, MapPin, X, CheckCircle2 } from 'lucide-react';
import { shrinkPhoto } from '@/lib/images/shrink-photo';
import {
  queueTrailObservation, listTrailObservations, deleteTrailObservation,
  type TrailObservationDraft,
} from '@/lib/offline/db';

const PHOTO_LIMIT = 3;
/** Полевая цель под палец в перчатке — не меньше 44 px, лучше больше. */
const TAP = 48;

const CATEGORIES = [
  { value: 'animal', label: 'Животное', icon: PawPrint },
  { value: 'plant', label: 'Растение', icon: Leaf },
  { value: 'hazard', label: 'Опасность', icon: AlertTriangle },
  { value: 'trail', label: 'Тропа', icon: Footprints },
  { value: 'other', label: 'Другое', icon: MoreHorizontal },
] as const;

/**
 * Дожать очередь: по одной записи, у каждой — сначала текст, потом снимки.
 * Отказ сети/приёмника останавливает проход (запись остаётся на диске) —
 * тот же порядок, что у flushQueue формы /field-check.
 */
export async function flushTrailObservations(): Promise<void> {
  const queue = await listTrailObservations();
  for (const item of queue) {
    try {
      const res = await fetch('/api/safety/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_type: item.reportType,
          text: item.text,
          ...(item.lat != null && item.lng != null ? { lat: item.lat, lng: item.lng } : {}),
        }),
      });
      const j = await res.json().catch(() => null) as
        { success?: boolean; data?: { id?: string } } | null;
      if (!res.ok || !j?.success) break;
      const reportId = j.data?.id;
      if (reportId) {
        for (const photo of item.photos) {
          const pr = await fetch('/api/safety/reports/photo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ report_id: reportId, mime: 'image/jpeg', data: photo }),
          });
          if (!pr.ok) break;
        }
      }
      await deleteTrailObservation(item.id);
    } catch {
      break;
    }
  }
}

/** Очередь наблюдений: счётчик для бейджа + автодожим при появлении сети. */
export function useTrailObservationQueue(): number {
  const [len, setLen] = useState(0);

  const refresh = useCallback(() => {
    void listTrailObservations().then(q => setLen(q.length)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const onOnline = () => { void flushTrailObservations().then(refresh); };
    window.addEventListener('online', onOnline);
    window.addEventListener('trail-observation-queued', refresh);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('trail-observation-queued', refresh);
    };
  }, [refresh]);

  return len;
}

interface ObservationSheetProps {
  open: boolean;
  onClose: () => void;
  /** Текущий фикс с экрана маршрута; null — экран его ещё не поймал. */
  lat: number | null;
  lng: number | null;
}

type SendState = 'idle' | 'saving' | 'sent' | 'queued';

export function ObservationSheet({ open, onClose, lat, lng }: ObservationSheetProps) {
  const [category, setCategory] = useState<string>('animal');
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [state, setState] = useState<SendState>('idle');
  const [error, setError] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setCategory('animal');
    setText('');
    setPhotos([]);
    setState('idle');
    setError(null);
  }, []);

  const addPhotos = useCallback(async (files: FileList | null) => {
    if (!files) return;
    const room = PHOTO_LIMIT - photos.length;
    const added: string[] = [];
    for (const f of Array.from(files).slice(0, room)) {
      const b64 = await shrinkPhoto(f);
      if (b64) added.push(b64);
    }
    if (added.length > 0) setPhotos(p => [...p, ...added]);
  }, [photos.length]);

  const submit = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length < 3) {
      setError('Опишите наблюдение — хотя бы пару слов');
      return;
    }
    setError(null);
    setState('saving');

    const draft: TrailObservationDraft = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      reportType: category,
      text: trimmed,
      lat, lng,
      photos,
      queuedAt: Date.now(),
    };

    // Сначала на диск: наблюдение существует независимо от исхода отправки.
    try {
      await queueTrailObservation(draft);
    } catch {
      // Приватный режим/переполненный диск: очереди нет, шлём напрямую —
      // и честно скажем, если не вышло.
    }
    window.dispatchEvent(new Event('trail-observation-queued'));

    await flushTrailObservations();
    const left = await listTrailObservations().then(q => q.some(i => i.id === draft.id)).catch(() => true);
    window.dispatchEvent(new Event('trail-observation-queued'));
    setState(left ? 'queued' : 'sent');
  }, [text, category, lat, lng, photos]);

  if (!open) return null;

  const online = typeof navigator === 'undefined' || navigator.onLine;

  return (
    <div className="fixed inset-0 z-[1100] flex items-end" role="dialog" aria-label="Новое наблюдение">
      <button className="absolute inset-0 bg-black/50" onClick={onClose} aria-label="Закрыть" />
      <div
        className="relative w-full max-h-[85vh] overflow-y-auto rounded-t-2xl border-t p-5"
        style={{
          background: 'var(--bg-card)',
          borderColor: 'var(--border)',
          paddingBottom: 'calc(20px + env(safe-area-inset-bottom))',
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>
            Новое наблюдение
          </h2>
          <button
            onClick={() => { reset(); onClose(); }}
            className="flex items-center justify-center rounded-full"
            style={{ width: 44, height: 44, background: 'var(--bg-hover)' }}
            aria-label="Закрыть"
          >
            <X className="w-5 h-5 text-[var(--text-muted)]" />
          </button>
        </div>

        {state === 'sent' || state === 'queued' ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <CheckCircle2 className="w-10 h-10" style={{ color: 'var(--success)' }} />
            <p className="font-semibold text-[var(--text-primary)]">
              {state === 'sent' ? 'Наблюдение отправлено' : 'Сохранено на телефоне'}
            </p>
            <p className="text-sm text-[var(--text-secondary)] max-w-[36ch]">
              {state === 'sent'
                ? 'Появится в радаре после проверки модератором.'
                : 'Отправится само, когда появится сеть. Ничего не потеряется.'}
            </p>
            <button onClick={() => { reset(); onClose(); }} className="ds-btn ds-btn-secondary mt-2 text-sm">
              Готово
            </button>
          </div>
        ) : (
          <>
            {/* Фото: не блокирует наблюдение — можно отправить и без снимка */}
            <div className="flex gap-3 mb-4">
              <div className="flex flex-wrap gap-2 flex-1">
                {photos.map((p, i) => (
                  <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden bg-[var(--bg-hover)]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`data:image/jpeg;base64,${p}`} alt={`Снимок ${i + 1}`} className="w-full h-full object-cover" />
                    <button
                      onClick={() => setPhotos(ph => ph.filter((_, j) => j !== i))}
                      className="absolute top-0.5 right-0.5 rounded-full bg-black/60 p-1"
                      aria-label="Убрать снимок"
                    >
                      <X className="w-3 h-3 text-white" />
                    </button>
                  </div>
                ))}
                {photos.length < PHOTO_LIMIT && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => cameraRef.current?.click()}
                      className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs"
                      style={{ width: 76, height: 64, borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                    >
                      <Camera className="w-4 h-4" /> Камера
                    </button>
                    <button
                      onClick={() => galleryRef.current?.click()}
                      className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs"
                      style={{ width: 76, height: 64, borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                    >
                      <ImagePlus className="w-4 h-4" /> Из галереи
                    </button>
                  </div>
                )}
              </div>
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden"
                onChange={e => { void addPhotos(e.target.files); e.target.value = ''; }} />
              <input ref={galleryRef} type="file" accept="image/*" multiple className="hidden"
                onChange={e => { void addPhotos(e.target.files); e.target.value = ''; }} />
            </div>

            {/* Категории */}
            <div className="flex flex-wrap gap-2 mb-4">
              {CATEGORIES.map(c => {
                const active = category === c.value;
                const Icon = c.icon;
                return (
                  <button
                    key={c.value}
                    onClick={() => setCategory(c.value)}
                    aria-pressed={active}
                    className="inline-flex items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors duration-200"
                    style={{
                      minHeight: 40,
                      background: active ? 'var(--accent)' : 'var(--bg-hover)',
                      color: active ? '#FFFFFF' : 'var(--text-secondary)',
                      border: active ? '1px solid transparent' : '1px solid var(--border)',
                    }}
                  >
                    <Icon className="w-4 h-4" /> {c.label}
                  </button>
                );
              })}
            </div>

            <label className="block text-sm font-medium text-[var(--text-primary)] mb-1.5">
              Что заметили?
            </label>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="Короткое описание"
              className="ds-input w-full text-sm resize-none mb-3"
            />

            {/* Координаты — от экрана маршрута, отдельной кнопки не нужно */}
            <p className="flex items-center gap-2 text-sm mb-4" style={{ color: lat != null ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
              <MapPin className="w-4 h-4 shrink-0" style={{ color: lat != null ? 'var(--ocean)' : 'var(--text-muted)' }} />
              {lat != null && lng != null
                ? `Координаты сохранены · ${lat.toFixed(4)}, ${lng.toFixed(4)}`
                : 'Без координат: GPS ещё не поймал точку — наблюдение уйдёт без привязки'}
            </p>

            {error && <p className="text-sm mb-3" style={{ color: 'var(--danger)' }}>{error}</p>}

            <button
              onClick={() => void submit()}
              disabled={state === 'saving'}
              className="ds-btn ds-btn-primary w-full justify-center text-sm disabled:opacity-60"
              style={{ minHeight: TAP }}
            >
              {state === 'saving'
                ? 'Сохраняю...'
                : online ? 'Отправить наблюдение' : 'Сохранить — отправится, когда появится сеть'}
            </button>
            <p className="text-xs text-center mt-2" style={{ color: 'var(--text-muted)' }}>
              Появится в радаре после проверки модератором.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

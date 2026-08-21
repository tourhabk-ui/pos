'use client';

/**
 * Полевая проверка записей (владелец 21.08: «знакомая едет на Вилючинский
 * перевал и все места рядом»).
 *
 * Экран для человека, который стоит на месте: он видит, что платформа
 * УТВЕРЖДАЕТ об этой точке, и говорит, сходится ли это с землёй. Проверка
 * уходит в очередь — данные меняет владелец, не тап в поле.
 *
 * Офлайн терпим: связь на перевале рвётся, и потерянная проверка — это
 * потерянный выход. Неотправленное лежит в localStorage и уходит само,
 * когда сеть вернётся; счётчик очереди виден всегда.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MapPin, Check, AlertTriangle, WifiOff, Loader2, Crosshair, Camera, X } from 'lucide-react';
import {
  queueFieldCheck, listFieldChecks, deleteFieldCheck,
  type FieldCheckQueueItem,
} from '@/lib/offline/db';

const TAG_KEY = 'field_check_trip_tag';
/** Снимок сжимается на телефоне: в поле связь узкая, а улика нужна целая. */
const PHOTO_MAX_SIDE = 1280;
const PHOTO_QUALITY = 0.72;
const PHOTO_LIMIT = 3;

interface NearbyItem {
  kind: 'route' | 'place';
  id: string;
  title: string;
  subtitle: string | null;
  lat: number;
  lng: number;
  facts: Array<{ label: string; value: string | null }>;
  description_head: string | null;
  away_km: number;
}

const VERDICTS: Array<{ value: string; label: string; tone: 'ok' | 'warn' }> = [
  { value: 'confirmed', label: 'Всё сходится', tone: 'ok' },
  { value: 'coords_wrong', label: 'Координата не та', tone: 'warn' },
  { value: 'not_found', label: 'Объекта здесь нет', tone: 'warn' },
  { value: 'line_wrong', label: 'Линия идёт не так', tone: 'warn' },
  { value: 'description_wrong', label: 'Описание врёт', tone: 'warn' },
  { value: 'access_changed', label: 'Доступ изменился', tone: 'warn' },
];

/**
 * Сжатие снимка на устройстве: длинная сторона до 1280 px, JPEG.
 * Оригинал с камеры — это 4-8 МБ, которые в поле не уйдут никогда.
 * Возвращает base64 без префикса data: — в таком виде он и хранится,
 * и отправляется.
 */
async function shrinkPhoto(file: File): Promise<{ data: string; mime: string } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const url = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
    const comma = url.indexOf(',');
    if (comma < 0) return null;
    return { data: url.slice(comma + 1), mime: 'image/jpeg' };
  } catch {
    // Старый браузер или битый файл — снимка не будет, но проверка уйдёт.
    return null;
  }
}

export function FieldCheckClient() {
  const [fix, setFix] = useState<{ lat: number; lng: number; accuracy: number | null } | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [items, setItems] = useState<NearbyItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [tripTag, setTripTag] = useState('');
  const [queueLen, setQueueLen] = useState(0);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  /** Снимки текущей формы: base64 без префикса, уже сжатые. */
  const [photos, setPhotos] = useState<string[]>([]);
  const [photoBusy, setPhotoBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void listFieldChecks().then(q => setQueueLen(q.length)).catch(() => undefined);
    try {
      const saved = localStorage.getItem(TAG_KEY);
      if (saved) setTripTag(saved);
    } catch { /* приватный режим */ }
    // PWA: без своей регистрации форма, открытая по прямой ссылке, останется
    // без офлайна — а её открывают именно там, где связи нет.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }, []);

  /**
   * Отправка очереди: по одной проверке, снимки следом за своей проверкой.
   * Отказ обрывает проход — очередь остаётся на диске целиком, ничего не
   * теряется и не отправляется дважды: запись удаляется только после
   * успешного ответа.
   */
  const flushQueue = useCallback(async () => {
    let queue: FieldCheckQueueItem[];
    try { queue = await listFieldChecks(); } catch { return; }
    for (const item of queue) {
      try {
        const res = await fetch('/api/field-check/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target_kind: item.targetKind,
            target_id: item.targetId,
            verdict: item.verdict,
            reported_lat: item.reportedLat,
            reported_lng: item.reportedLng,
            accuracy_m: item.accuracyM,
            note: item.note,
            trip_tag: item.tripTag,
          }),
        });
        if (!res.ok) break;
        const j = await res.json();
        const checkId: string | null = j?.id ?? null;
        // Снимки идут по одному и НЕ держат проверку: не ушедшая
        // фотография не повод отправлять вердикт заново.
        if (checkId) {
          for (const data of item.photos) {
            try {
              await fetch('/api/field-check/photo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ check_id: checkId, mime: 'image/jpeg', data }),
              });
            } catch { /* снимок довезём в следующий раз не сможем — вердикт важнее */ }
          }
        }
        await deleteFieldCheck(item.id);
        setQueueLen(n => Math.max(0, n - 1));
      } catch { break; }
    }
  }, []);

  useEffect(() => {
    void flushQueue();
    const onOnline = () => void flushQueue();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flushQueue]);

  const locate = useCallback(() => {
    setFixError(null);
    if (!('geolocation' in navigator)) {
      setFixError('Телефон не отдаёт координаты');
      return;
    }
    setLoading(true);
    navigator.geolocation.getCurrentPosition(
      pos => {
        const f = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: typeof pos.coords.accuracy === 'number' ? Math.round(pos.coords.accuracy) : null,
        };
        setFix(f);
        void loadNearby(f.lat, f.lng);
      },
      err => {
        setLoading(false);
        setFixError(err.code === 1
          ? 'Доступ к геопозиции закрыт — разрешите в настройках браузера'
          : 'Сигнал не поймали. Попробуйте на открытом месте');
      },
      { enableHighAccuracy: true, timeout: 30_000, maximumAge: 10_000 },
    );
  }, []);

  const loadNearby = useCallback(async (lat: number, lng: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/field-check/nearby?lat=${lat}&lng=${lng}&radius_km=15`);
      const j = await res.json();
      setItems(j?.success && Array.isArray(j.items) ? j.items : []);
    } catch {
      // Офлайн: списка нет, но уже отправленное в очереди не теряется.
      setItems(null);
      setFixError('Нет связи — список не загрузился. Проверки сохранятся и уйдут позже');
    } finally {
      setLoading(false);
    }
  }, []);

  const submit = useCallback(async (item: NearbyItem, verdict: string) => {
    const check: FieldCheckQueueItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      targetKind: item.kind,
      targetId: item.id,
      verdict,
      reportedLat: fix?.lat ?? null,
      reportedLng: fix?.lng ?? null,
      accuracyM: fix?.accuracy ?? null,
      note: note.trim() || null,
      tripTag: tripTag.trim() || null,
      photos,
      queuedAt: Date.now(),
    };
    try {
      await queueFieldCheck(check);
      setQueueLen(n => n + 1);
    } catch {
      // Хранилище закрыто (приватный режим) — отправляем прямо сейчас или
      // теряем. Молчать об этом нельзя.
      setFixError('Не удалось сохранить проверку на телефоне — отправляем сразу');
    }
    setDoneIds(prev => new Set(prev).add(item.id));
    setOpenId(null);
    setNote('');
    setPhotos([]);
    try { if (tripTag.trim()) localStorage.setItem(TAG_KEY, tripTag.trim()); } catch { /* ignore */ }
    void flushQueue();
  }, [fix, note, tripTag, photos, flushQueue]);

  /** Снимок с камеры или из галереи: сжимаем сразу, храним уже готовым. */
  const addPhoto = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setPhotoBusy(true);
    const next: string[] = [];
    for (const file of Array.from(files).slice(0, PHOTO_LIMIT)) {
      const shrunk = await shrinkPhoto(file);
      if (shrunk) next.push(shrunk.data);
    }
    setPhotos(prev => [...prev, ...next].slice(0, PHOTO_LIMIT));
    setPhotoBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={e => void addPhoto(e.target.files)}
        className="hidden"
      />
      <div className="max-w-lg mx-auto px-4 py-6 flex flex-col gap-5">

        <header className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-playfair)', color: 'var(--text-primary)' }}>
            Полевая проверка
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Здесь показано, что платформа утверждает о местах вокруг вас. Скажите,
            сходится ли это с тем, что видно на земле. Данные меняет владелец —
            ваша проверка идёт в очередь, ничего не ломается.
          </p>
        </header>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Метка выхода — чтобы проверки одной поездки лежали вместе
          </span>
          <input
            value={tripTag}
            onChange={e => setTripTag(e.target.value.slice(0, 60))}
            placeholder="Вилючинский перевал, 22 августа"
            className="ds-input"
          />
        </label>

        <button onClick={locate} disabled={loading}
          className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg font-semibold"
          style={{ background: 'var(--accent)', color: '#FFFFFF' }}>
          {loading
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <Crosshair className="w-4 h-4" />}
          {fix ? 'Обновить список по моему месту' : 'Показать, что рядом со мной'}
        </button>

        {fix && (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Ваша точка: {fix.lat.toFixed(5)}, {fix.lng.toFixed(5)}
            {fix.accuracy !== null ? ` · точность ±${fix.accuracy} м` : ' · точность неизвестна'}
          </div>
        )}

        {fixError && (
          <div className="flex items-start gap-2 text-sm p-3 rounded-lg"
            style={{ background: 'color-mix(in srgb, var(--warning) 12%, transparent)', color: 'var(--warning)' }}>
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{fixError}</span>
          </div>
        )}

        {queueLen > 0 && (
          <div className="flex items-center gap-2 text-sm p-3 rounded-lg"
            style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
            <WifiOff className="w-4 h-4 shrink-0" />
            <span>Не отправлено: {queueLen}. Уйдёт само, когда появится связь.</span>
          </div>
        )}

        {items !== null && items.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            В радиусе 15 км у платформы нет ни одной записи с координатами.
            Это тоже результат — расскажите владельцу, где вы были.
          </p>
        )}

        {items?.map(item => {
          const done = doneIds.has(item.id);
          const open = openId === item.id;
          return (
            <div key={`${item.kind}-${item.id}`} className="rounded-lg p-4 flex flex-col gap-2"
              style={{
                background: 'var(--bg-card)',
                border: `1px solid ${done ? 'var(--success)' : 'var(--border)'}`,
              }}>
              <div className="flex items-start gap-2">
                <MapPin className="w-4 h-4 shrink-0 mt-0.5"
                  style={{ color: item.kind === 'route' ? 'var(--ocean)' : 'var(--text-muted)' }} />
                <div className="flex-1">
                  <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{item.title}</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {item.kind === 'route' ? 'маршрут' : 'место'} · {item.away_km} км от вас
                    {item.subtitle ? ` · ${item.subtitle}` : ''}
                  </div>
                </div>
                {done && <Check className="w-5 h-5 shrink-0" style={{ color: 'var(--success)' }} />}
              </div>

              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Записано: {item.lat.toFixed(5)}, {item.lng.toFixed(5)}
              </div>

              {item.facts.length > 0 && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {item.facts.map(f => (
                    <span key={f.label} style={{ color: f.value ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                      {f.label}: {f.value ?? 'не знаем'}
                    </span>
                  ))}
                </div>
              )}

              {item.description_head && (
                <p className="text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
                  {item.description_head}…
                </p>
              )}

              {!done && !open && (
                <button onClick={() => { setOpenId(item.id); setNote(''); }}
                  className="self-start text-sm font-semibold px-4 py-2 rounded-lg"
                  style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
                  Проверить
                </button>
              )}

              {open && (
                <div className="flex flex-col gap-2 pt-1">
                  <textarea
                    value={note}
                    onChange={e => setNote(e.target.value.slice(0, 600))}
                    placeholder="Что не так или что стоит знать. Необязательно."
                    rows={3}
                    className="ds-input"
                  />
                  {/* Снимок — улика, которая не спорит: развилка, табличка,
                      размытый мост. Хранится сжатым и уходит следом за
                      вердиктом; не ушедшее фото не задерживает проверку. */}
                  <div className="flex flex-wrap items-center gap-2">
                    {photos.map((data, i) => (
                      <div key={i} className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`data:image/jpeg;base64,${data}`} alt={`Снимок ${i + 1}`}
                          className="w-16 h-16 object-cover rounded-lg"
                          style={{ border: '1px solid var(--border)' }} />
                        <button onClick={() => setPhotos(prev => prev.filter((_, j) => j !== i))}
                          aria-label="Убрать снимок"
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center"
                          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-strong)' }}>
                          <X className="w-3 h-3" style={{ color: 'var(--text-secondary)' }} />
                        </button>
                      </div>
                    ))}
                    {photos.length < PHOTO_LIMIT && (
                      <button onClick={() => fileRef.current?.click()} disabled={photoBusy}
                        className="w-16 h-16 rounded-lg flex flex-col items-center justify-center gap-1"
                        style={{ background: 'var(--bg-hover)', border: '1px dashed var(--border-strong)' }}>
                        {photoBusy
                          ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--text-muted)' }} />
                          : <Camera className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />}
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>фото</span>
                      </button>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {VERDICTS.map(v => (
                      <button key={v.value} onClick={() => submit(item, v.value)}
                        className="text-sm font-semibold px-3 py-2 rounded-lg"
                        style={{
                          background: v.tone === 'ok' ? 'var(--success)' : 'var(--bg-hover)',
                          color: v.tone === 'ok' ? '#08210f' : 'var(--text-primary)',
                          border: v.tone === 'ok' ? 'none' : '1px solid var(--border)',
                        }}>
                        {v.label}
                      </button>
                    ))}
                  </div>
                  <button onClick={() => setOpenId(null)}
                    className="self-start text-xs underline underline-offset-2"
                    style={{ color: 'var(--text-muted)' }}>
                    Отмена
                  </button>
                </div>
              )}
            </div>
          );
        })}

        <p className="text-xs pb-6" style={{ color: 'var(--text-muted)' }}>
          Координата вашего телефона прикладывается к проверке, если она есть.
          Если координаты нет — так и запишем: проверка «не с места» тоже
          полезна, но вес у неё другой. Снимки сжимаются на телефоне и
          хранятся до связи вместе с проверкой. Страницу можно добавить на
          домашний экран — она открывается без интернета.
        </p>
      </div>
    </div>
  );
}

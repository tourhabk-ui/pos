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

import { useCallback, useEffect, useState } from 'react';
import { MapPin, Check, AlertTriangle, WifiOff, Loader2, Crosshair } from 'lucide-react';

const QUEUE_KEY = 'field_check_queue_v1';
const TAG_KEY = 'field_check_trip_tag';

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

interface QueuedCheck {
  target_kind: 'route' | 'place';
  target_id: string;
  verdict: string;
  reported_lat: number | null;
  reported_lng: number | null;
  accuracy_m: number | null;
  note: string | null;
  trip_tag: string | null;
}

const VERDICTS: Array<{ value: string; label: string; tone: 'ok' | 'warn' }> = [
  { value: 'confirmed', label: 'Всё сходится', tone: 'ok' },
  { value: 'coords_wrong', label: 'Координата не та', tone: 'warn' },
  { value: 'not_found', label: 'Объекта здесь нет', tone: 'warn' },
  { value: 'line_wrong', label: 'Линия идёт не так', tone: 'warn' },
  { value: 'description_wrong', label: 'Описание врёт', tone: 'warn' },
  { value: 'access_changed', label: 'Доступ изменился', tone: 'warn' },
];

function readQueue(): QueuedCheck[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writeQueue(q: QueuedCheck[]): void {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* приватный режим */ }
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

  useEffect(() => {
    setQueueLen(readQueue().length);
    try {
      const saved = localStorage.getItem(TAG_KEY);
      if (saved) setTripTag(saved);
    } catch { /* приватный режим */ }
  }, []);

  /** Отправка очереди: молча, по одной, без потери при отказе. */
  const flushQueue = useCallback(async () => {
    let q = readQueue();
    while (q.length > 0) {
      const head = q[0];
      try {
        const res = await fetch('/api/field-check/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(head),
        });
        if (!res.ok) break;
      } catch { break; }
      q = q.slice(1);
      writeQueue(q);
      setQueueLen(q.length);
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

  const submit = useCallback((item: NearbyItem, verdict: string) => {
    const check: QueuedCheck = {
      target_kind: item.kind,
      target_id: item.id,
      verdict,
      reported_lat: fix?.lat ?? null,
      reported_lng: fix?.lng ?? null,
      accuracy_m: fix?.accuracy ?? null,
      note: note.trim() || null,
      trip_tag: tripTag.trim() || null,
    };
    const q = [...readQueue(), check];
    writeQueue(q);
    setQueueLen(q.length);
    setDoneIds(prev => new Set(prev).add(item.id));
    setOpenId(null);
    setNote('');
    try { if (tripTag.trim()) localStorage.setItem(TAG_KEY, tripTag.trim()); } catch { /* ignore */ }
    void flushQueue();
  }, [fix, note, tripTag, flushQueue]);

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
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
          полезна, но вес у неё другой.
        </p>
      </div>
    </div>
  );
}

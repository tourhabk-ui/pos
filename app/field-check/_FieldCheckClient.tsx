'use client';

/**
 * Полевая проверка записей (владелец 21.08: «знакомая едет на Вилючинский
 * перевал»; «нужно юзабилити»).
 *
 * Экран рассчитан на руку в перчатке, ветер и сесть батарею: крупные цели,
 * минимум решений на шаг, ничего не теряется при потере связи.
 *
 * Поток — два шага, не больше:
 *   1. Где я. GPS одной кнопкой; если спутников нет — координаты руками,
 *      иначе экран бесполезен именно там, где нужен.
 *   2. Список того, что платформа УТВЕРЖДАЕТ рядом. По каждой записи
 *      сначала один вопрос: сходится или нет. Подробности (что именно не
 *      так, правильная точка, снимок, заметка) спрашиваются только у того,
 *      кто ответил «не сходится» — большинству записей они не нужны.
 *
 * Проверка ничего не меняет в данных: она уходит в очередь, правит
 * владелец. Очередь и снимки живут в IndexedDB и переживают перезагрузку.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MapPin, Check, AlertTriangle, WifiOff, Loader2, Crosshair,
  Camera, X, Search, ChevronLeft, Route as RouteIcon, Send, Download,
} from 'lucide-react';
import {
  queueFieldCheck, listFieldChecks, deleteFieldCheck,
  saveFieldCheckArea, getFieldCheckArea,
  type FieldCheckQueueItem,
} from '@/lib/offline/db';

const TAG_KEY = 'field_check_trip_tag';
const DONE_KEY = 'field_check_done_v1';
/** Снимок сжимается на телефоне: в поле связь узкая, а улика нужна целая. */
const PHOTO_MAX_SIDE = 1280;
const PHOTO_QUALITY = 0.72;
const PHOTO_LIMIT = 3;
/** Полевая цель под палец в перчатке — не меньше 56 px. */
const TAP = 56;

/**
 * «1 точек пути» — мелочь, которая читается как небрежность ко всему
 * остальному: человек, увидевший в поле кривую форму слова, не поверит и
 * цифре рядом с ним. Склонение по последним разрядам, как в русском.
 */
/**
 * Слово вместо кода базы.
 *
 * `medium`, `waterfall`, `hot_spring` — это наши внутренние ярлыки. Человек
 * в поле читает их как знак, что мы писали экран для себя, а не для него.
 * Незнакомый ярлык не переводится и НЕ показывается: показать код честнее
 * не становится, а место на экране он занимает.
 */
const SUBTITLE_WORD: Record<string, string> = {
  easy: 'просто', medium: 'средне', hard: 'тяжело', expert: 'очень тяжело',
  volcano: 'вулкан', lake: 'озеро', hot_spring: 'горячий источник',
  waterfall: 'водопад', mountain: 'гора', geyser: 'гейзер', river: 'река',
  bay: 'бухта', beach: 'пляж', glacier: 'ледник', cave: 'пещера',
  canyon: 'каньон', valley: 'долина', island: 'остров', pass: 'перевал',
};

export function subtitleWord(subtitle: string | null): string | null {
  if (!subtitle) return null;
  return SUBTITLE_WORD[subtitle] ?? null;
}

/**
 * Число по-русски: «12,1 км» вместо «12.10 км».
 *
 * Точка вместо запятой и хвост нулей — след того, что число пришло из
 * колонки NUMERIC как есть. Мелочь того же рода, что «1 точек пути».
 */
export function ruAmount(raw: string): string {
  const m = /^(\d+(?:\.\d+)?)(.*)$/.exec(raw.trim());
  if (m === null) return raw;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return raw;
  const body = (Math.round(n * 10) / 10).toString().replace('.', ',');
  return `${body}${m[2]}`;
}

/**
 * Одно обещание для свёрнутой карточки.
 *
 * У маршрута это дистанция: её опровергают чаще всего и проще всего.
 * У места отдельного обещания нет — тип уже стоит строкой выше, и повторять
 * его значит занимать строку ничем.
 *
 * Нечего обещать — строки нет: пустое место честнее слов «не знаем»,
 * которые человек читает как нашу небрежность, а не как честный пропуск.
 */
export function headlineClaim(item: {
  kind: 'route' | 'place';
  subtitle: string | null;
  facts: Array<{ label: string; value: string | null }>;
}): string | null {
  if (item.kind !== 'route') return null;
  const d = item.facts.find(f => f.label === 'дистанция')?.value;
  return d ? `обещаем ${ruAmount(d)}` : null;
}

export function waypointsPhrase(n: number): string {
  const t = Math.abs(n) % 100;
  const o = t % 10;
  const word = t >= 11 && t <= 14 ? 'точек'
    : o === 1 ? 'точка'
    : o >= 2 && o <= 4 ? 'точки'
    : 'точек';
  return `${n} ${word} пути`;
}

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

/** Что именно расходится. Спрашивается только у того, кто сказал «не так». */
const PROBLEMS: Array<{ value: string; label: string }> = [
  { value: 'coords_wrong', label: 'Точка стоит не там' },
  { value: 'not_found', label: 'Объекта здесь нет' },
  { value: 'line_wrong', label: 'Линия идёт не так' },
  { value: 'description_wrong', label: 'Описание врёт' },
  { value: 'access_changed', label: 'Доступ изменился' },
  { value: 'other', label: 'Другое' },
];

const VERDICT_LABEL: Record<string, string> = {
  confirmed: 'всё сходится',
  ...Object.fromEntries(PROBLEMS.map(p => [p.value, p.label.toLowerCase()])),
};

async function shrinkPhoto(file: File): Promise<string | null> {
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
    return comma < 0 ? null : url.slice(comma + 1);
  } catch {
    // Старый браузер или битый файл — снимка не будет, но проверка уйдёт.
    return null;
  }
}

function readDone(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DONE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

export function FieldCheckClient() {
  const [fix, setFix] = useState<{ lat: number; lng: number; accuracy: number | null } | null>(null);
  const [radiusKm, setRadiusKm] = useState(15);
  const [manualCenter, setManualCenter] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [items, setItems] = useState<NearbyItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [onlyPending, setOnlyPending] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  /** Вторая ступень карточки: человек сказал «не сходится». */
  const [problemFor, setProblemFor] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const [note, setNote] = useState('');
  const [tripTag, setTripTag] = useState('');
  const [showTag, setShowTag] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [photoBusy, setPhotoBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [objCoord, setObjCoord] = useState<{ lat: number; lng: number; source: 'my_fix' | 'manual' } | null>(null);
  const [manualCoord, setManualCoord] = useState('');
  const [coordError, setCoordError] = useState<string | null>(null);

  const [queueLen, setQueueLen] = useState(0);
  const [done, setDone] = useState<Record<string, string>>({});

  /** Выход по маршруту: поиск и выбор — дома, пока есть сеть. */
  const [routeQuery, setRouteQuery] = useState('');
  const [routeHits, setRouteHits] = useState<Array<{ id: string; title: string; waypoints: number }> | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);
  const [areaLabel, setAreaLabel] = useState<string | null>(null);
  const [savedArea, setSavedArea] = useState<{ label: string; savedAt: number; count: number } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDone(readDone());
    void listFieldChecks().then(q => setQueueLen(q.length)).catch(() => undefined);
    void getFieldCheckArea().then(area => {
      if (area) {
        setSavedArea({
          label: area.label,
          savedAt: area.savedAt,
          count: Array.isArray(area.items) ? area.items.length : 0,
        });
      }
    }).catch(() => undefined);
    try {
      const saved = localStorage.getItem(TAG_KEY);
      if (saved) setTripTag(saved);
    } catch { /* приватный режим */ }
    // PWA: форму открывают по прямой ссылке там, где связи нет — без своей
    // регистрации она осталась бы без офлайна.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }, []);

  const rememberDone = useCallback((id: string, verdict: string) => {
    setDone(prev => {
      const next = { ...prev, [id]: verdict };
      try { localStorage.setItem(DONE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

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
            object_lat: item.objectLat,
            object_lng: item.objectLng,
            object_source: item.objectSource,
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
            } catch { /* довезём в следующий заход */ }
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

  const loadNearby = useCallback(async (lat: number, lng: number, radius: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/field-check/nearby?lat=${lat}&lng=${lng}&radius_km=${radius}`);
      const j = await res.json();
      setItems(j?.success && Array.isArray(j.items) ? j.items : []);
      setError(null);
    } catch {
      setItems(null);
      setError('Нет связи — список не загрузился. Проверки всё равно сохранятся и уйдут позже');
    } finally {
      setLoading(false);
    }
  }, []);

  const locate = useCallback(() => {
    setError(null);
    if (!('geolocation' in navigator)) {
      setError('Телефон не отдаёт координаты — введите их вручную');
      setShowMore(true);
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
        void loadNearby(f.lat, f.lng, radiusKm);
      },
      err => {
        setLoading(false);
        setError(err.code === 1
          ? 'Доступ к геопозиции закрыт. Разрешите его или введите координаты вручную'
          : 'Сигнал не поймали. Попробуйте на открытом месте или введите координаты вручную');
        setShowMore(true);
      },
      { enableHighAccuracy: true, timeout: 30_000, maximumAge: 10_000 },
    );
  }, [loadNearby, radiusKm]);

  /** Разбор пары чисел: «53.2669, 158.3874» или «53.2669 158.3874». */
  const parsePair = (raw: string): { lat: number; lng: number } | null => {
    const parts = raw.replace(',', ' ').split(/\s+/).filter(Boolean);
    const lat = Number(parts[0]?.replace(',', '.'));
    const lng = Number(parts[1]?.replace(',', '.'));
    if (parts.length < 2 || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  };

  const applyManualCenter = useCallback(() => {
    const pair = parsePair(manualCenter);
    if (!pair) { setError('Нужны два числа: широта и долгота'); return; }
    setError(null);
    setFix({ lat: pair.lat, lng: pair.lng, accuracy: null });
    void loadNearby(pair.lat, pair.lng, radiusKm);
  }, [manualCenter, loadNearby, radiusKm]);

  /** Поиск маршрута по названию — только дома: в поле сети нет. */
  const searchRoutes = useCallback(async () => {
    const q = routeQuery.trim();
    if (q.length < 2) { setRouteHits([]); return; }
    setRouteBusy(true);
    try {
      const res = await fetch(`/api/field-check/routes?q=${encodeURIComponent(q)}`);
      const j = await res.json();
      setRouteHits(j?.success && Array.isArray(j.items) ? j.items : []);
    } catch {
      setRouteHits(null);
      setError('Нет связи — маршрут ищется только там, где есть сеть');
    } finally {
      setRouteBusy(false);
    }
  }, [routeQuery]);

  /**
   * Список по маршруту: центр и радиус считает сервер по путевым точкам —
   * выход идёт не в одну локацию, и радиус должен накрыть весь путь.
   */
  const loadByRoute = useCallback(async (routeId: string, title: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/field-check/nearby?route_id=${encodeURIComponent(routeId)}`);
      const j = await res.json();
      if (!j?.success) {
        setError(j?.error ?? 'Маршрут не открылся');
        setItems(null);
        return;
      }
      setItems(Array.isArray(j.items) ? j.items : []);
      setAreaLabel(title);
      setFix({
        lat: j.center?.lat ?? 0,
        lng: j.center?.lng ?? 0,
        accuracy: null,
      });
      setRadiusKm(typeof j.radius_km === 'number' ? j.radius_km : radiusKm);
    } catch {
      setError('Нет связи — маршрут не загрузился');
    } finally {
      setLoading(false);
    }
  }, [radiusKm]);

  /** Сохранить район на телефон: в поле его уже не скачать. */
  const saveArea = useCallback(async () => {
    if (!items || !fix) return;
    setSaving(true);
    try {
      const label = areaLabel ?? `${fix.lat.toFixed(3)}, ${fix.lng.toFixed(3)}`;
      await saveFieldCheckArea({
        id: 'current',
        label,
        centerLat: fix.lat,
        centerLng: fix.lng,
        radiusKm,
        items,
        savedAt: Date.now(),
      });
      setSavedArea({ label, savedAt: Date.now(), count: items.length });
    } catch {
      setError('Не удалось сохранить район на телефон');
    } finally {
      setSaving(false);
    }
  }, [items, fix, areaLabel, radiusKm]);

  /** Открыть сохранённое: единственный способ работать без сети. */
  const openSavedArea = useCallback(async () => {
    try {
      const area = await getFieldCheckArea();
      if (!area) return;
      setItems(Array.isArray(area.items) ? (area.items as NearbyItem[]) : []);
      setFix({ lat: area.centerLat, lng: area.centerLng, accuracy: null });
      setRadiusKm(area.radiusKm);
      setAreaLabel(area.label);
      setError(null);
    } catch {
      setError('Сохранённый район не читается');
    }
  }, []);

  const takeMyFix = useCallback(() => {
    setCoordError(null);
    if (!('geolocation' in navigator)) {
      setCoordError('Телефон не отдаёт координаты');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      // Свежий фикс, а не тот, по которому строился список: между открытием
      // экрана и этим нажатием человек дошёл до объекта.
      pos => setObjCoord({ lat: pos.coords.latitude, lng: pos.coords.longitude, source: 'my_fix' }),
      () => setCoordError('Сигнал не поймали — можно ввести координаты руками'),
      { enableHighAccuracy: true, timeout: 30_000, maximumAge: 0 },
    );
  }, []);

  const applyManualCoord = useCallback(() => {
    const pair = parsePair(manualCoord);
    if (!pair) { setCoordError('Нужны два числа: широта и долгота'); return; }
    setCoordError(null);
    setObjCoord({ ...pair, source: 'manual' });
  }, [manualCoord]);

  const addPhoto = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setPhotoBusy(true);
    const next: string[] = [];
    for (const file of Array.from(files).slice(0, PHOTO_LIMIT)) {
      const shrunk = await shrinkPhoto(file);
      if (shrunk) next.push(shrunk);
    }
    setPhotos(prev => [...prev, ...next].slice(0, PHOTO_LIMIT));
    setPhotoBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  const resetForm = useCallback(() => {
    setOpenId(null);
    setProblemFor(null);
    setProblem(null);
    setNote('');
    setPhotos([]);
    setObjCoord(null);
    setManualCoord('');
    setCoordError(null);
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
      objectLat: objCoord?.lat ?? null,
      objectLng: objCoord?.lng ?? null,
      objectSource: objCoord?.source ?? null,
      photos,
      queuedAt: Date.now(),
    };
    try {
      await queueFieldCheck(check);
      setQueueLen(n => n + 1);
    } catch {
      // Хранилище закрыто (приватный режим) — молчать об этом нельзя.
      setError('Не удалось сохранить проверку на телефоне — отправляем сразу');
    }
    rememberDone(item.id, verdict);
    resetForm();
    try { if (tripTag.trim()) localStorage.setItem(TAG_KEY, tripTag.trim()); } catch { /* ignore */ }
    void flushQueue();
  }, [fix, note, tripTag, photos, objCoord, rememberDone, resetForm, flushQueue]);

  const visible = useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    return items.filter(i => {
      if (onlyPending && done[i.id]) return false;
      if (q && !i.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, query, onlyPending, done]);

  const checkedCount = items ? items.filter(i => done[i.id]).length : 0;

  // ── Шаг 1: где я ───────────────────────────────────────────────────────────
  if (!fix) {
    return (
      <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
        <div className="max-w-lg mx-auto px-4 py-8 flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-bold leading-tight"
              style={{ fontFamily: 'var(--font-playfair)', color: 'var(--text-primary)' }}>
              Полевая проверка
            </h1>
            <p className="text-base leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Покажем, что мы обещаем о местах вокруг вас. Скажете, сходится ли
              это с землёй. Сломать ничего нельзя.
            </p>
          </div>

          <button onClick={locate} disabled={loading}
            className="inline-flex items-center justify-center gap-3 rounded-lg font-semibold text-lg"
            style={{ background: 'var(--accent)', color: '#FFFFFF', minHeight: 64 }}>
            {loading
              ? <Loader2 className="w-5 h-5 animate-spin" />
              : <Crosshair className="w-5 h-5" />}
            Найти меня
          </button>

          {error && (
            <div className="flex items-start gap-2 text-sm p-3 rounded-lg"
              style={{ background: 'color-mix(in srgb, var(--warning) 12%, transparent)', color: 'var(--warning)' }}>
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {savedArea && (
            <button onClick={() => void openSavedArea()}
              className="rounded-lg px-4 py-3 flex items-center gap-3 text-left"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--success)', minHeight: TAP }}>
              <Download className="w-5 h-5 shrink-0" style={{ color: 'var(--success)' }} />
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                  Открыть выход: {savedArea.label}
                </span>
                <span className="block text-xs" style={{ color: 'var(--text-muted)' }}>
                  {savedArea.count} записей на телефоне — работает без интернета
                </span>
              </span>
            </button>
          )}

          {/* Выход по маршруту: несколько локаций сразу, готовится дома. */}
          <div className="flex flex-col gap-2">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Едете по маршруту — найдите его заранее, пока есть сеть
            </span>
            <div className="flex gap-2">
              <input value={routeQuery}
                onChange={e => setRouteQuery(e.target.value.slice(0, 80))}
                onKeyDown={e => { if (e.key === 'Enter') void searchRoutes(); }}
                placeholder="Вилючинский" className="ds-input flex-1" />
              <button onClick={() => void searchRoutes()} disabled={routeBusy}
                className="px-5 rounded-lg font-semibold"
                style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)', minHeight: TAP }}>
                {routeBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Найти'}
              </button>
            </div>
            {routeHits?.length === 0 && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Маршрутов с таким именем нет
              </span>
            )}
            {routeHits && routeHits.length > 0 && (
              <div className="flex flex-col gap-2">
                {routeHits.map(r => (
                  <button key={r.id} onClick={() => void loadByRoute(r.id, r.title)}
                    className="rounded-lg px-4 py-3 text-left"
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', minHeight: TAP }}>
                    <span className="block text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {r.title}
                    </span>
                    <span className="block text-xs" style={{ color: 'var(--text-muted)' }}>
                      {r.waypoints > 0 ? waypointsPhrase(r.waypoints) : 'точек пути нет — проверим, что рядом'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/*
            Всё редкое — под одну ссылку. Шесть решений на первом экране
            человек в перчатке не принимает: он ищет ту кнопку, ради которой
            открыл страницу. Спрятанное не удалено — оно в одном касании.
          */}
          {!showMore ? (
            <button onClick={() => setShowMore(true)}
              className="text-sm underline underline-offset-2 self-start"
              style={{ color: 'var(--text-muted)' }}>
              Ещё: координаты вручную, радиус
            </button>
          ) : (
            <div className="flex flex-col gap-2">
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Координаты из другого навигатора — широта и долгота
              </span>
              <div className="flex gap-2">
                <input value={manualCenter} onChange={e => setManualCenter(e.target.value.slice(0, 48))}
                  placeholder="52.7050, 158.2820" inputMode="decimal" className="ds-input flex-1" />
                <button onClick={applyManualCenter}
                  className="px-5 rounded-lg font-semibold"
                  style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)', minHeight: TAP }}>
                  Дальше
                </button>
              </div>
            </div>
          )}

          {showMore && (
            <div className="flex flex-col gap-2">
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Насколько далеко смотреть</span>
              <div className="flex gap-2">
                {[5, 15, 40].map(r => (
                  <button key={r} onClick={() => setRadiusKm(r)}
                    className="flex-1 rounded-lg font-semibold"
                    style={{
                      background: radiusKm === r ? 'var(--ocean)' : 'var(--bg-card)',
                      color: radiusKm === r ? '#FFFFFF' : 'var(--text-primary)',
                      border: radiusKm === r ? 'none' : '1px solid var(--border)',
                      minHeight: TAP,
                    }}>
                    {r} км
                  </button>
                ))}
              </div>
            </div>
          )}

          {queueLen > 0 && (
            <div className="flex items-center gap-2 text-sm p-3 rounded-lg"
              style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              <WifiOff className="w-4 h-4 shrink-0" />
              <span>Не отправлено: {queueLen}. Уйдёт само, когда появится связь.</span>
            </div>
          )}

          {showMore && (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Добавьте страницу на домашний экран — она открывается без интернета,
              и проверки не потеряются в местах без связи.
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── Шаг 2: список ──────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple
        onChange={e => void addPhoto(e.target.files)} className="hidden" />

      {/* Липкая шапка: где я, сколько сделано, сколько ждёт связи. */}
      <div className="sticky top-0 z-10"
        style={{ background: 'var(--bg-primary)', borderBottom: '1px solid var(--border)' }}>
        <div className="max-w-lg mx-auto px-4 py-3 flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <button onClick={() => { setFix(null); setItems(null); resetForm(); }}
              aria-label="Назад к выбору места"
              className="shrink-0 rounded-lg flex items-center justify-center"
              style={{ width: 40, height: 40, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <ChevronLeft className="w-5 h-5" style={{ color: 'var(--text-primary)' }} />
            </button>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {items ? `Проверено ${checkedCount} из ${items.length}` : 'Загружаем список'}
              </div>
              <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                {areaLabel ? `${areaLabel} · ` : ''}
                {fix.lat.toFixed(4)}, {fix.lng.toFixed(4)}
                {fix.accuracy !== null ? ` · ±${fix.accuracy} м` : ' · точность неизвестна'}
                {queueLen > 0 ? ` · в очереди ${queueLen}` : ''}
              </div>
            </div>
            {loading && <Loader2 className="w-5 h-5 animate-spin shrink-0" style={{ color: 'var(--text-muted)' }} />}
          </div>

          <div className="flex gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 rounded-lg"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', minHeight: 44 }}>
              <Search className="w-4 h-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
              <input value={query} onChange={e => setQuery(e.target.value)}
                placeholder="Найти по названию"
                className="flex-1 bg-transparent outline-none text-sm"
                style={{ color: 'var(--text-primary)' }} />
              {query && (
                <button onClick={() => setQuery('')} aria-label="Очистить">
                  <X className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                </button>
              )}
            </div>
            <button onClick={() => setOnlyPending(v => !v)}
              className="px-3 rounded-lg text-sm font-semibold"
              style={{
                background: onlyPending ? 'var(--ocean)' : 'var(--bg-card)',
                color: onlyPending ? '#FFFFFF' : 'var(--text-secondary)',
                border: onlyPending ? 'none' : '1px solid var(--border)',
                minHeight: 44,
              }}>
              {onlyPending ? 'Непроверенные' : 'Все'}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-4 flex flex-col gap-3">
        {error && (
          <div className="flex items-start gap-2 text-sm p-3 rounded-lg"
            style={{ background: 'color-mix(in srgb, var(--warning) 12%, transparent)', color: 'var(--warning)' }}>
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {items !== null && items.length > 0 && (
          <button onClick={() => void saveArea()} disabled={saving}
            className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold text-sm"
            style={{
              background: savedArea ? 'var(--bg-card)' : 'var(--ocean)',
              color: savedArea ? 'var(--text-secondary)' : '#FFFFFF',
              border: savedArea ? '1px solid var(--border)' : 'none',
              minHeight: 48,
            }}>
            {saving
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Download className="w-4 h-4" />}
            {savedArea
              ? `Сохранено на телефон: ${savedArea.count} записей — обновить`
              : 'Сохранить на телефон для выхода без сети'}
          </button>
        )}

        {!showTag ? (
          <button onClick={() => setShowTag(true)}
            className="text-xs underline underline-offset-2 self-start"
            style={{ color: 'var(--text-muted)' }}>
            {tripTag ? `Выход: ${tripTag}` : 'Отметить выход (необязательно)'}
          </button>
        ) : (
          <input value={tripTag} onChange={e => setTripTag(e.target.value.slice(0, 60))}
            onBlur={() => setShowTag(false)}
            placeholder="Вилючинский перевал, 22 августа"
            className="ds-input" autoFocus />
        )}

        {items !== null && items.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            В радиусе {radiusKm} км у платформы нет ни одной записи с координатами.
            Это тоже результат — расскажите об этом владельцу.
          </p>
        )}

        {items !== null && items.length > 0 && visible.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {onlyPending ? 'Всё вокруг проверено. Спасибо.' : 'По этому запросу ничего нет.'}
          </p>
        )}

        {visible.map(item => {
          const verdict = done[item.id];
          const open = openId === item.id;
          const asking = problemFor === item.id;

          if (verdict && !open) {
            return (
              <button key={`${item.kind}-${item.id}`} onClick={() => { setOpenId(item.id); setProblemFor(null); }}
                className="rounded-lg px-4 py-3 flex items-center gap-3 text-left"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--success)' }}>
                <Check className="w-5 h-5 shrink-0" style={{ color: 'var(--success)' }} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {item.title}
                  </span>
                  <span className="block text-xs" style={{ color: 'var(--text-muted)' }}>
                    {VERDICT_LABEL[verdict] ?? verdict}
                  </span>
                </span>
              </button>
            );
          }

          return (
            <div key={`${item.kind}-${item.id}`} className="rounded-lg p-4 flex flex-col gap-3"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div className="flex items-start gap-2">
                {item.kind === 'route'
                  ? <RouteIcon className="w-4 h-4 shrink-0 mt-1" style={{ color: 'var(--ocean)' }} />
                  : <MapPin className="w-4 h-4 shrink-0 mt-1" style={{ color: 'var(--text-muted)' }} />}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>
                    {item.title}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {item.kind === 'route' ? 'маршрут' : 'место'} · {item.away_km} км от вас
                    {subtitleWord(item.subtitle) ? ` · ${subtitleWord(item.subtitle)}` : ''}
                  </div>
                </div>
              </div>

              {/*
                Свёрнутая карточка несёт ОДНО обещание — то, что человек
                может опровергнуть, не открывая ничего. Координаты, прочие
                факты и описание нужны уже отвечающему, и показываются, когда
                он открыл запись. Список из двадцати таких карточек иначе
                читается как выгрузка из базы, а не как вопрос.
              */}
              {!open && headlineClaim(item) && (
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {headlineClaim(item)}
                </div>
              )}

              {open && (
                <>
                  <div className="text-xs flex flex-wrap gap-x-3 gap-y-1" style={{ color: 'var(--text-secondary)' }}>
                    <span className="tabular-nums">{item.lat.toFixed(5)}, {item.lng.toFixed(5)}</span>
                    {item.facts.map(f => (
                      <span key={f.label} style={{ color: f.value ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                        {f.label}: {f.value ?? 'не знаем'}
                      </span>
                    ))}
                  </div>
                  {item.description_head && (
                    <p className="text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
                      {item.description_head}…
                    </p>
                  )}
                </>
              )}

              {!open && (
                <button onClick={() => { setOpenId(item.id); setProblemFor(null); }}
                  className="rounded-lg font-semibold"
                  style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border)', minHeight: TAP }}>
                  Проверить
                </button>
              )}

              {open && !asking && (
                <div className="flex flex-col gap-2">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    Сходится с тем, что видите?
                  </span>
                  <button onClick={() => void submit(item, 'confirmed')}
                    className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold text-base"
                    style={{ background: 'var(--success)', color: '#08210f', minHeight: TAP }}>
                    <Check className="w-5 h-5" />
                    Да, всё сходится
                  </button>
                  <button onClick={() => { setProblemFor(item.id); setProblem(null); }}
                    className="rounded-lg font-semibold text-base"
                    style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)', minHeight: TAP }}>
                    Нет, что-то не так
                  </button>
                  <button onClick={resetForm}
                    className="text-xs underline underline-offset-2 self-center pt-1"
                    style={{ color: 'var(--text-muted)' }}>
                    Пропустить
                  </button>
                </div>
              )}

              {open && asking && (
                <div className="flex flex-col gap-3">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Что именно?</span>
                  <div className="grid grid-cols-2 gap-2">
                    {PROBLEMS.map(p => (
                      <button key={p.value} onClick={() => setProblem(p.value)}
                        className="rounded-lg text-sm font-semibold px-2"
                        style={{
                          background: problem === p.value ? 'var(--accent)' : 'var(--bg-hover)',
                          color: problem === p.value ? '#FFFFFF' : 'var(--text-primary)',
                          border: problem === p.value ? 'none' : '1px solid var(--border)',
                          minHeight: TAP,
                        }}>
                        {p.label}
                      </button>
                    ))}
                  </div>

                  {/* Правильная точка. Вердикт «точка стоит не там» без неё —
                      жалоба без адреса. Происхождение пишется вместе с
                      числами: фикс на объекте и цифры из чужого навигатора —
                      улики разного веса.

                      Спрашивается ТОЛЬКО у того, кто сказал, что точка не там.
                      Раньше блок висел всегда — человек, жалующийся на
                      описание, читал вопрос о координате как обязательный и
                      либо застревал, либо вводил лишь бы что. */}
                  {problem === 'coords_wrong' && (
                  <div className="flex flex-col gap-2 p-3 rounded-lg"
                    style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}>
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      Где точка на самом деле — если знаете
                    </span>
                    {objCoord ? (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm tabular-nums" style={{ color: 'var(--text-primary)' }}>
                          {objCoord.lat.toFixed(5)}, {objCoord.lng.toFixed(5)}
                          <span className="text-xs ml-2" style={{ color: 'var(--text-muted)' }}>
                            {objCoord.source === 'my_fix' ? 'с телефона на месте' : 'введено руками'}
                          </span>
                        </span>
                        <button onClick={() => { setObjCoord(null); setManualCoord(''); }}
                          className="text-xs underline underline-offset-2" style={{ color: 'var(--text-muted)' }}>
                          убрать
                        </button>
                      </div>
                    ) : (
                      <>
                        <button onClick={takeMyFix}
                          className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold"
                          style={{ background: 'var(--ocean)', color: '#FFFFFF', minHeight: TAP }}>
                          <Crosshair className="w-4 h-4" />
                          Я стою на этой точке
                        </button>
                        <div className="flex gap-2">
                          <input value={manualCoord} onChange={e => setManualCoord(e.target.value.slice(0, 48))}
                            placeholder="53.2669, 158.3874" inputMode="decimal" className="ds-input flex-1" />
                          <button onClick={applyManualCoord}
                            className="px-4 rounded-lg text-sm font-semibold"
                            style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border)', minHeight: 44 }}>
                            Взять
                          </button>
                        </div>
                      </>
                    )}
                    {coordError && (
                      <span className="text-xs" style={{ color: 'var(--warning)' }}>{coordError}</span>
                    )}
                  </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    {photos.map((data, i) => (
                      <div key={i} className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`data:image/jpeg;base64,${data}`} alt={`Снимок ${i + 1}`}
                          className="w-16 h-16 object-cover rounded-lg"
                          style={{ border: '1px solid var(--border)' }} />
                        <button onClick={() => setPhotos(prev => prev.filter((_, j) => j !== i))}
                          aria-label="Убрать снимок"
                          className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full flex items-center justify-center"
                          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-strong)' }}>
                          <X className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
                        </button>
                      </div>
                    ))}
                    {photos.length < PHOTO_LIMIT && (
                      <button onClick={() => fileRef.current?.click()} disabled={photoBusy}
                        className="rounded-lg flex flex-col items-center justify-center gap-1"
                        style={{ width: 64, height: 64, background: 'var(--bg-hover)', border: '1px dashed var(--border-strong)' }}>
                        {photoBusy
                          ? <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-muted)' }} />
                          : <Camera className="w-5 h-5" style={{ color: 'var(--text-secondary)' }} />}
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>фото</span>
                      </button>
                    )}
                  </div>

                  <textarea value={note} onChange={e => setNote(e.target.value.slice(0, 600))}
                    placeholder="Что не так. Необязательно, но помогает." rows={3} className="ds-input" />

                  <button onClick={() => problem && void submit(item, problem)} disabled={!problem}
                    className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold text-base"
                    style={{
                      background: problem ? 'var(--accent)' : 'var(--bg-hover)',
                      color: problem ? '#FFFFFF' : 'var(--text-muted)',
                      minHeight: TAP,
                    }}>
                    <Send className="w-4 h-4" />
                    {problem ? 'Отправить проверку' : 'Выберите, что не так'}
                  </button>
                  <button onClick={resetForm}
                    className="text-xs underline underline-offset-2 self-center"
                    style={{ color: 'var(--text-muted)' }}>
                    Отмена
                  </button>
                </div>
              )}
            </div>
          );
        })}

        <p className="text-xs pt-2 pb-8" style={{ color: 'var(--text-muted)' }}>
          Проверки сохраняются на телефоне и уходят сами, когда появляется связь.
          Координата и снимки прикладываются, если они есть; проверка без них
          тоже принимается — так и запишем.
        </p>
      </div>
    </div>
  );
}

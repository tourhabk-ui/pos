'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Image from 'next/image';
import { Search, Upload, CheckCircle, XCircle, Loader2, ImageIcon, Layers, AlertTriangle, Trash2 } from 'lucide-react';

interface Place {
  id: string;
  arkId: string | null;
  name: string;
  locationType: string | null;
  hasPhoto: boolean;
  photoUrl: string | null;
}

interface DuplicatePlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  locationType: string | null;
  arkId: string | null;
  hasPhoto: boolean;
  hasSafetyProfile: boolean;
}

interface DuplicatePair {
  distanceM: number;
  nameSimilarity: number;
  places: [DuplicatePlace, DuplicatePlace];
}

interface MergedPlace {
  id: string;
  name: string;
  locationType: string | null;
  arkId: string | null;
  mergedAt: string | null;
  keepId: string;
  keepName: string;
  hasSafetyProfile: boolean;
}

const LOCATION_LABELS: Record<string, string> = {
  volcano: 'Вулкан', lake: 'Озеро', hot_spring: 'Источник', mountain: 'Гора',
  river: 'Река', bay: 'Бухта', cape: 'Мыс', island: 'Остров',
  glacier: 'Ледник', forest: 'Лес', beach: 'Пляж', waterfall: 'Водопад',
  rock: 'Скала', viewpoint: 'Смотровая', settlement: 'Поселение',
  museum: 'Музей', historical: 'Историческое',
};

export default function PlacesPhotosClient() {
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [filter, setFilter] = useState<'all' | 'no-photo' | 'with-photo'>('all');
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const [showDupes, setShowDupes] = useState(false);
  const [dupesLoaded, setDupesLoaded] = useState(false);
  const [loadingDupes, setLoadingDupes] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicatePair[]>([]);
  const [keepChoice, setKeepChoice] = useState<Record<number, string>>({});
  const [merging, setMerging] = useState<number | null>(null);
  const [dupeFeedback, setDupeFeedback] = useState<Record<number, { ok: boolean; msg: string }>>({});
  const [mergedPairs, setMergedPairs] = useState<Set<number>>(new Set());

  const [showMerged, setShowMerged] = useState(false);
  const [mergedLoaded, setMergedLoaded] = useState(false);
  const [loadingMerged, setLoadingMerged] = useState(false);
  const [mergedPlaces, setMergedPlaces] = useState<MergedPlace[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteFeedback, setDeleteFeedback] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const fetchMergedPlaces = useCallback(async () => {
    setLoadingMerged(true);
    try {
      const res = await fetch('/api/admin/places/merged?limit=200');
      if (!res.ok) throw new Error('Не удалось загрузить список объединённых мест');
      const data = await res.json() as { items: MergedPlace[] };
      setMergedPlaces(data.items);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMerged(false);
      setMergedLoaded(true);
    }
  }, []);

  const toggleMergedPanel = () => {
    const next = !showMerged;
    setShowMerged(next);
    if (next && !mergedLoaded) void fetchMergedPlaces();
  };

  const handleDelete = async (placeId: string, force: boolean) => {
    setDeleting(placeId);
    setDeleteFeedback((prev) => ({ ...prev, [placeId]: { ok: true, msg: 'Удаляю…' } }));

    try {
      const res = await fetch(`/api/admin/places/${placeId}${force ? '?force=true' : ''}`, {
        method: 'DELETE',
      });
      const data = await res.json() as { ok?: boolean; error?: string };

      if (!res.ok || !data.ok) {
        setDeleteFeedback((prev) => ({ ...prev, [placeId]: { ok: false, msg: data.error ?? 'Ошибка удаления' } }));
        return;
      }

      setDeleteFeedback((prev) => ({ ...prev, [placeId]: { ok: true, msg: 'Удалено' } }));
      setDeletedIds((prev) => new Set(prev).add(placeId));
    } catch (err) {
      setDeleteFeedback((prev) => ({
        ...prev,
        [placeId]: { ok: false, msg: err instanceof Error ? err.message : 'Ошибка сети' },
      }));
    } finally {
      setDeleting(null);
      setConfirmingDelete(null);
    }
  };

  const fetchDuplicates = useCallback(async () => {
    setLoadingDupes(true);
    try {
      const res = await fetch('/api/admin/places/duplicates?limit=100');
      if (!res.ok) throw new Error('Не удалось найти дубли');
      const data = await res.json() as { pairs: DuplicatePair[] };
      setDuplicates(data.pairs);
      // По умолчанию оставляем ту запись пары, у которой уже есть фото или safety-профиль
      setKeepChoice(Object.fromEntries(
        data.pairs.map((p, i) => {
          const [a, b] = p.places;
          const preferred = (a.hasPhoto || a.hasSafetyProfile) && !(b.hasPhoto || b.hasSafetyProfile) ? a.id : b.id;
          return [i, preferred];
        }),
      ));
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingDupes(false);
      setDupesLoaded(true);
    }
  }, []);

  const toggleDupesPanel = () => {
    const next = !showDupes;
    setShowDupes(next);
    if (next && !dupesLoaded) void fetchDuplicates();
  };

  const handleMerge = async (pairIndex: number) => {
    const pair = duplicates[pairIndex];
    if (!pair) return;
    const keepId = keepChoice[pairIndex];
    const other = pair.places.find((p) => p.id !== keepId);
    if (!keepId || !other) return;

    setMerging(pairIndex);
    setDupeFeedback((prev) => ({ ...prev, [pairIndex]: { ok: true, msg: 'Объединяю…' } }));

    try {
      const res = await fetch('/api/admin/places/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepId, mergeIds: [other.id] }),
      });
      const data = await res.json() as { ok?: boolean; error?: string; warnings?: string[] };

      if (!res.ok || !data.ok) {
        setDupeFeedback((prev) => ({ ...prev, [pairIndex]: { ok: false, msg: data.error ?? 'Ошибка слияния' } }));
        return;
      }

      const warn = data.warnings?.length ? ` · ${data.warnings.join('; ')}` : '';
      setDupeFeedback((prev) => ({ ...prev, [pairIndex]: { ok: true, msg: `Объединено${warn}` } }));
      setMergedPairs((prev) => new Set(prev).add(pairIndex));

      // Убираем объединённую запись из основного списка мест на странице
      setPlaces((prev) => prev.filter((p) => p.id !== other.id));
    } catch (err) {
      setDupeFeedback((prev) => ({
        ...prev,
        [pairIndex]: { ok: false, msg: err instanceof Error ? err.message : 'Ошибка сети' },
      }));
    } finally {
      setMerging(null);
    }
  };

  const fetchPlaces = useCallback(async (q: string) => {
    setLoading(true);
    setSearchError(null);
    try {
      const res = await fetch(`/api/admin/places/search?q=${encodeURIComponent(q)}&limit=200`);
      if (!res.ok) {
        // Тело ошибки — в сообщение: упавший API раньше выглядел как
        // «Ничего не найдено», причину нельзя было увидеть без DevTools.
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
      }
      const data = await res.json() as { items: Place[] };
      setPlaces(data.items);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Не удалось загрузить список мест');
      setPlaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => fetchPlaces(query), 250);
    return () => clearTimeout(t);
  }, [query, fetchPlaces]);

  const handleUpload = async (placeId: string, file: File) => {
    setUploading(placeId);
    setFeedback((prev) => ({ ...prev, [placeId]: { ok: true, msg: 'Загрузка…' } }));

    try {
      const fd = new FormData();
      fd.append('file', file);

      const res = await fetch(`/api/admin/places/${placeId}/photo`, {
        method: 'POST',
        body: fd,
      });

      const data = await res.json() as { ok?: boolean; error?: string; url?: string; sizeKb?: number };

      if (!res.ok || !data.ok) {
        setFeedback((prev) => ({ ...prev, [placeId]: { ok: false, msg: data.error ?? 'Ошибка загрузки' } }));
        return;
      }

      setFeedback((prev) => ({
        ...prev,
        [placeId]: { ok: true, msg: `Готово · ${data.sizeKb} КБ · 1280×720` },
      }));

      // Update place in list
      setPlaces((prev) =>
        prev.map((p) =>
          p.id === placeId ? { ...p, hasPhoto: true, photoUrl: data.url ?? p.photoUrl } : p,
        ),
      );
    } catch (err) {
      setFeedback((prev) => ({
        ...prev,
        [placeId]: { ok: false, msg: err instanceof Error ? err.message : 'Ошибка сети' },
      }));
    } finally {
      setUploading(null);
    }
  };

  const triggerUpload = (placeId: string) => {
    fileInputRefs.current[placeId]?.click();
  };

  const filtered = places.filter((p) =>
    filter === 'no-photo' ? !p.hasPhoto :
    filter === 'with-photo' ? p.hasPhoto :
    true,
  );

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="font-playfair text-3xl font-bold text-[var(--text-primary)] mb-2">
          Загрузка фото мест
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Загрузи фото — оно будет автоматически обрезано до 1280×720 (16:9) и сохранено для карточки места.
        </p>
      </header>

      {/* Duplicates panel */}
      <div className="mb-6 rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        <button
          onClick={toggleDupesPanel}
          className="w-full flex items-center justify-between gap-2 px-4 py-3 text-sm font-medium bg-[var(--bg-card)]"
        >
          <span className="flex items-center gap-2 text-[var(--text-primary)]">
            <Layers className="w-4 h-4" />
            Возможные дубли мест
            {dupesLoaded && !loadingDupes && (
              <span className="text-[var(--text-muted)] font-normal">
                ({duplicates.length - mergedPairs.size} осталось)
              </span>
            )}
          </span>
          {loadingDupes && <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />}
        </button>

        {showDupes && (
          <div className="p-4 border-t space-y-4" style={{ borderColor: 'var(--border)' }}>
            {loadingDupes && <p className="text-sm text-[var(--text-muted)]">Ищу дубли по координатам и похожести названий…</p>}
            {!loadingDupes && dupesLoaded && duplicates.length === 0 && (
              <p className="text-sm text-[var(--text-muted)]">Дублей не найдено.</p>
            )}
            {duplicates.map((pair, i) => {
              if (mergedPairs.has(i)) return null;
              const [a, b] = pair.places;
              const fb = dupeFeedback[i];
              const isMerging = merging === i;
              return (
                <div key={`${a.id}-${b.id}`} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                  <p className="text-xs text-[var(--text-muted)] mb-2">
                    {pair.distanceM <= 300 ? `${pair.distanceM} м друг от друга` : 'далеко, но похожие названия'}
                    {' · '}похожесть названий {Math.round(pair.nameSimilarity * 100)}%
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {[a, b].map((p) => (
                      <label
                        key={p.id}
                        className="flex items-start gap-2 p-2 rounded-lg cursor-pointer text-sm"
                        style={{
                          background: keepChoice[i] === p.id ? 'var(--bg-hover)' : 'transparent',
                          border: `1px solid ${keepChoice[i] === p.id ? 'var(--accent)' : 'var(--border)'}`,
                        }}
                      >
                        <input
                          type="radio"
                          name={`keep-${i}`}
                          checked={keepChoice[i] === p.id}
                          onChange={() => setKeepChoice((prev) => ({ ...prev, [i]: p.id }))}
                          className="mt-1"
                        />
                        <span>
                          <span className="font-medium text-[var(--text-primary)] block">{p.name}</span>
                          <span className="text-[11px] text-[var(--text-muted)] block">
                            {p.locationType ? LOCATION_LABELS[p.locationType] ?? p.locationType : '—'}
                            {p.hasPhoto && ' · есть фото'}
                            {p.hasSafetyProfile && ' · есть safety-профиль'}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>

                  <div className="flex items-center gap-3 mt-3">
                    <button
                      onClick={() => handleMerge(i)}
                      disabled={isMerging}
                      className="ds-btn ds-btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-50"
                    >
                      {isMerging ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
                      Оставить выбранное, объединить со вторым
                    </button>
                    {fb && (
                      <span
                        className="flex items-center gap-1.5 text-xs"
                        style={{ color: fb.ok ? 'var(--success)' : 'var(--danger)' }}
                      >
                        {fb.ok ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                        {fb.msg}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Merged (already-confirmed) duplicates — hard delete */}
      <div className="mb-6 rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        <button
          onClick={toggleMergedPanel}
          className="w-full flex items-center justify-between gap-2 px-4 py-3 text-sm font-medium bg-[var(--bg-card)]"
        >
          <span className="flex items-center gap-2 text-[var(--text-primary)]">
            <Trash2 className="w-4 h-4" />
            Объединённые дубли — удалить насовсем
            {mergedLoaded && !loadingMerged && (
              <span className="text-[var(--text-muted)] font-normal">
                ({mergedPlaces.filter((p) => !deletedIds.has(p.id)).length} осталось)
              </span>
            )}
          </span>
          {loadingMerged && <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />}
        </button>

        {showMerged && (
          <div className="p-4 border-t space-y-3" style={{ borderColor: 'var(--border)' }}>
            {loadingMerged && <p className="text-sm text-[var(--text-muted)]">Загружаю список…</p>}
            {!loadingMerged && mergedLoaded && mergedPlaces.length === 0 && (
              <p className="text-sm text-[var(--text-muted)]">Нет объединённых записей — сначала подтвердите слияние выше.</p>
            )}
            {mergedPlaces.map((p) => {
              if (deletedIds.has(p.id)) return null;
              const fb = deleteFeedback[p.id];
              const isDeleting = deleting === p.id;
              const isConfirming = confirmingDelete === p.id;
              return (
                <div key={p.id} className="rounded-lg border p-3 flex items-start justify-between gap-3" style={{ borderColor: 'var(--border)' }}>
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">{p.name}</p>
                    <p className="text-[11px] text-[var(--text-muted)]">
                      объединено в «{p.keepName}»
                      {p.locationType && ` · ${LOCATION_LABELS[p.locationType] ?? p.locationType}`}
                      {p.hasSafetyProfile && ' · есть непереданный safety-профиль'}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    {!isConfirming ? (
                      <button
                        onClick={() => setConfirmingDelete(p.id)}
                        disabled={isDeleting}
                        className="ds-btn ds-btn-danger text-xs px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Удалить
                      </button>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-[var(--text-secondary)]">Точно удалить?</span>
                        <button
                          onClick={() => handleDelete(p.id, p.hasSafetyProfile)}
                          disabled={isDeleting}
                          className="ds-btn ds-btn-danger text-xs px-2 py-1 disabled:opacity-50"
                        >
                          {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Да, удалить'}
                        </button>
                        <button
                          onClick={() => setConfirmingDelete(null)}
                          disabled={isDeleting}
                          className="ds-btn ds-btn-secondary text-xs px-2 py-1 disabled:opacity-50"
                        >
                          Отмена
                        </button>
                      </div>
                    )}
                    {fb && (
                      <span
                        className="flex items-center gap-1.5 text-xs"
                        style={{ color: fb.ok ? 'var(--success)' : 'var(--danger)' }}
                      >
                        {fb.ok ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                        {fb.msg}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Search + filter */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по названию места…"
            className="w-full pl-10 pr-4 py-2.5 rounded-lg border bg-[var(--bg-card)] text-[var(--text-primary)]"
            style={{ borderColor: 'var(--border)' }}
          />
        </div>
        <div className="flex gap-2">
          {([
            { v: 'all', label: 'Все' },
            { v: 'no-photo', label: 'Без фото' },
            { v: 'with-photo', label: 'С фото' },
          ] as const).map(({ v, label }) => (
            <button
              key={v}
              onClick={() => setFilter(v)}
              className="px-3 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                background: filter === v ? 'var(--accent)' : 'var(--bg-card)',
                color: filter === v ? 'white' : 'var(--text-primary)',
                border: `1px solid ${filter === v ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-[var(--text-muted)] mb-3">
        {loading ? 'Загрузка…' : `Показано: ${filtered.length}`}
      </p>

      {searchError && (
        <div className="mb-3 rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-3 text-sm text-[var(--danger)]">
          Список мест не загрузился: {searchError}
        </div>
      )}

      {/* Places grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((place) => {
          const fb = feedback[place.id];
          const isUploading = uploading === place.id;

          return (
            <div
              key={place.id}
              className="rounded-xl border overflow-hidden bg-[var(--bg-card)]"
              style={{ borderColor: 'var(--border)' }}
            >
              {/* Preview */}
              <div className="aspect-video bg-[var(--bg-hover)] relative overflow-hidden">
                {place.photoUrl ? (
                  <Image
                    src={place.photoUrl}
                    alt={place.name}
                    fill
                    sizes="(max-width: 640px) 100vw, 33vw"
                    className="object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)]">
                    <ImageIcon className="w-8 h-8" />
                  </div>
                )}
                {place.hasPhoto && (
                  <span className="absolute top-2 right-2 text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-[var(--success)] text-white">
                    Есть фото
                  </span>
                )}
              </div>

              {/* Info */}
              <div className="p-3">
                <p className="font-semibold text-sm text-[var(--text-primary)] line-clamp-2 mb-1">
                  {place.name}
                </p>
                <p className="text-[11px] text-[var(--text-muted)] mb-3">
                  {place.locationType ? LOCATION_LABELS[place.locationType] ?? place.locationType : '—'}
                </p>

                {/* Upload button */}
                <input
                  ref={(el) => { fileInputRefs.current[place.id] = el; }}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic"
                  className="hidden"
                  disabled={isUploading || !place.arkId}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleUpload(place.id, f);
                    e.target.value = '';
                  }}
                />
                <button
                  onClick={() => triggerUpload(place.id)}
                  disabled={isUploading || !place.arkId}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    background: 'var(--bg-hover)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {isUploading ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" />Загрузка…</>
                  ) : (
                    <><Upload className="w-3.5 h-3.5" />{place.hasPhoto ? 'Заменить' : 'Загрузить'}</>
                  )}
                </button>

                {!place.arkId && (
                  <p className="text-[10px] text-[var(--danger)] mt-2 leading-tight">
                    У места нет ark_id — загрузка невозможна
                  </p>
                )}

                {fb && (
                  <div
                    className="flex items-start gap-1.5 mt-2 text-[11px] leading-tight"
                    style={{ color: fb.ok ? 'var(--success)' : 'var(--danger)' }}
                  >
                    {fb.ok ? <CheckCircle className="w-3 h-3 mt-0.5 flex-shrink-0" /> : <XCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />}
                    <span>{fb.msg}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!loading && filtered.length === 0 && (
        <p className="text-center text-[var(--text-muted)] py-12">Ничего не найдено</p>
      )}
    </main>
  );
}

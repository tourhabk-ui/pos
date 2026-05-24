'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Image from 'next/image';
import { Search, Upload, CheckCircle, XCircle, Loader2, ImageIcon, ScanLine } from 'lucide-react';

interface Place {
  id: string;
  arkId: string | null;
  name: string;
  locationType: string | null;
  hasPhoto: boolean;
  photoUrl: string | null;
}

interface AuditPhoto {
  id: string;
  imageId: string;
  placeName: string;
  locationType: string | null;
  photoUrl: string;
  photoVerified: boolean | null;
  aiAuditReason: string | null;
}

interface AuditStats {
  total: number;
  verified: number;
  rejected: number;
  unreviewed: number;
}

type AuditFilter = 'all' | 'unreviewed' | 'verified' | 'rejected';

const LOCATION_LABELS: Record<string, string> = {
  volcano: 'Вулкан', lake: 'Озеро', hot_spring: 'Источник', mountain: 'Гора',
  river: 'Река', bay: 'Бухта', cape: 'Мыс', island: 'Остров',
  glacier: 'Ледник', forest: 'Лес', beach: 'Пляж', waterfall: 'Водопад',
  rock: 'Скала', viewpoint: 'Смотровая', settlement: 'Поселение',
  museum: 'Музей', historical: 'Историческое',
};

function UploadTab() {
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [filter, setFilter] = useState<'all' | 'no-photo' | 'with-photo'>('all');
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const fetchPlaces = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/places/search?q=${encodeURIComponent(q)}&limit=200`);
      if (!res.ok) throw new Error('Не удалось загрузить список');
      const data = await res.json() as { items: Place[] };
      setPlaces(data.items);
    } catch (err) {
      console.error(err);
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
    <>
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
                color: filter === v ? 'var(--bg-primary)' : 'var(--text-primary)',
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
                  <span className="absolute top-2 right-2 text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-[var(--success)] text-[var(--bg-primary)]">
                    Есть фото
                  </span>
                )}
              </div>

              <div className="p-3">
                <p className="font-semibold text-sm text-[var(--text-primary)] line-clamp-2 mb-1">
                  {place.name}
                </p>
                <p className="text-[11px] text-[var(--text-muted)] mb-3">
                  {place.locationType ? LOCATION_LABELS[place.locationType] ?? place.locationType : '—'}
                </p>

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
    </>
  );
}

function AuditTab() {
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [photos, setPhotos] = useState<AuditPhoto[]>([]);
  const [loading, setLoading] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [filter, setFilter] = useState<AuditFilter>('all');
  const [verifying, setVerifying] = useState<string | null>(null);

  const fetchAuditStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/photos/audit-status');
      if (!res.ok) throw new Error('Не удалось загрузить данные аудита');
      const data = await res.json() as { stats: AuditStats; photos: AuditPhoto[] };
      setStats(data.stats);
      setPhotos(data.photos);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAuditStatus();
  }, [fetchAuditStatus]);

  const runAudit = async () => {
    setAuditing(true);
    try {
      await fetch('/api/admin/photos/audit', { method: 'POST' });
      await fetchAuditStatus();
    } catch (err) {
      console.error(err);
    } finally {
      setAuditing(false);
    }
  };

  const verifyPhoto = async (imageId: string, verified: boolean) => {
    setVerifying(imageId);
    setPhotos((prev) =>
      prev.map((p) =>
        p.imageId === imageId ? { ...p, photoVerified: verified } : p,
      ),
    );
    try {
      await fetch(`/api/admin/photos/${imageId}/verify`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verified }),
      });
      setStats((prev) => {
        if (!prev) return prev;
        const photo = photos.find((p) => p.imageId === imageId);
        if (!photo) return prev;
        const wasVerified = photo.photoVerified === true;
        const wasRejected = photo.photoVerified === false;
        const wasUnreviewed = photo.photoVerified === null;
        return {
          ...prev,
          verified: prev.verified + (verified ? 1 : 0) - (wasVerified ? 1 : 0),
          rejected: prev.rejected + (!verified ? 1 : 0) - (wasRejected ? 1 : 0),
          unreviewed: prev.unreviewed - (wasUnreviewed ? 1 : 0),
        };
      });
    } catch (err) {
      console.error(err);
      await fetchAuditStatus();
    } finally {
      setVerifying(null);
    }
  };

  const filtered = photos.filter((p) => {
    if (filter === 'unreviewed') return p.photoVerified === null;
    if (filter === 'verified') return p.photoVerified === true;
    if (filter === 'rejected') return p.photoVerified === false;
    return true;
  });

  return (
    <>
      {stats && (
        <div
          className="flex flex-wrap gap-4 items-center px-4 py-3 rounded-lg mb-5 text-sm font-medium"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          <span style={{ color: 'var(--success)' }}>
            {stats.verified} подходят
          </span>
          <span style={{ color: 'var(--text-muted)' }}>/</span>
          <span style={{ color: 'var(--danger)' }}>
            {stats.rejected} не подходят
          </span>
          <span style={{ color: 'var(--text-muted)' }}>/</span>
          <span style={{ color: 'var(--text-secondary)' }}>
            {stats.unreviewed} не проверено
          </span>
          <span className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
            Всего: {stats.total}
          </span>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="flex gap-2 flex-wrap">
          {([
            { v: 'all', label: 'Все' },
            { v: 'unreviewed', label: 'Не проверено' },
            { v: 'verified', label: 'Подходят' },
            { v: 'rejected', label: 'Отклонено' },
          ] as const).map(({ v, label }) => (
            <button
              key={v}
              onClick={() => setFilter(v)}
              className="px-3 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                background: filter === v ? 'var(--accent)' : 'var(--bg-card)',
                color: filter === v ? 'var(--bg-primary)' : 'var(--text-primary)',
                border: `1px solid ${filter === v ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          onClick={runAudit}
          disabled={auditing || loading}
          className="sm:ml-auto flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: 'var(--ocean)',
            color: 'var(--bg-primary)',
          }}
        >
          {auditing ? (
            <><Loader2 className="w-4 h-4 animate-spin" />Запуск…</>
          ) : (
            <><ScanLine className="w-4 h-4" />Запустить AI аудит (10 фото)</>
          )}
        </button>
      </div>

      <p className="text-xs text-[var(--text-muted)] mb-3">
        {loading ? 'Загрузка…' : `Показано: ${filtered.length}`}
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {filtered.map((photo) => {
          const isVerifying = verifying === photo.imageId;
          const statusVerified = photo.photoVerified === true;
          const statusRejected = photo.photoVerified === false;

          return (
            <div
              key={photo.id}
              className="rounded-xl border overflow-hidden bg-[var(--bg-card)]"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="aspect-video bg-[var(--bg-hover)] relative overflow-hidden">
                <Image
                  src={photo.photoUrl}
                  alt={photo.placeName}
                  fill
                  sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                  className="object-cover"
                  unoptimized
                />
                <span
                  className="absolute top-2 right-2 text-[10px] font-bold uppercase px-2 py-1 rounded-full"
                  style={{
                    background: statusVerified ? 'var(--success)' : statusRejected ? 'var(--danger)' : 'var(--text-muted)',
                    color: 'var(--bg-primary)',
                  }}
                >
                  {statusVerified ? 'Подходит' : statusRejected ? 'Отклонено' : 'Не проверено'}
                </span>
              </div>

              <div className="p-3">
                <p className="font-semibold text-xs text-[var(--text-primary)] line-clamp-2 mb-1">
                  {photo.placeName}
                </p>
                {photo.locationType && (
                  <span
                    className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded mb-2"
                    style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}
                  >
                    {LOCATION_LABELS[photo.locationType] ?? photo.locationType}
                  </span>
                )}
                {photo.aiAuditReason && (
                  <p className="text-[10px] italic text-[var(--text-muted)] mb-2 line-clamp-2">
                    {photo.aiAuditReason}
                  </p>
                )}

                <div className="flex gap-2 mt-1">
                  <button
                    onClick={() => verifyPhoto(photo.imageId, true)}
                    disabled={isVerifying}
                    title="Подходит"
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50"
                    style={{
                      background: statusVerified ? 'var(--success)' : 'var(--bg-hover)',
                      color: statusVerified ? 'var(--bg-primary)' : 'var(--text-primary)',
                      border: `1px solid ${statusVerified ? 'var(--success)' : 'var(--border)'}`,
                    }}
                  >
                    {isVerifying ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <CheckCircle className="w-3 h-3" />
                    )}
                  </button>
                  <button
                    onClick={() => verifyPhoto(photo.imageId, false)}
                    disabled={isVerifying}
                    title="Отклонить"
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50"
                    style={{
                      background: statusRejected ? 'var(--danger)' : 'var(--bg-hover)',
                      color: statusRejected ? 'var(--bg-primary)' : 'var(--text-primary)',
                      border: `1px solid ${statusRejected ? 'var(--danger)' : 'var(--border)'}`,
                    }}
                  >
                    {isVerifying ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <XCircle className="w-3 h-3" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {!loading && filtered.length === 0 && (
        <p className="text-center text-[var(--text-muted)] py-12">Нет фото в этой категории</p>
      )}
    </>
  );
}

type Tab = 'upload' | 'audit';

export default function PlacesPhotosClient() {
  const [tab, setTab] = useState<Tab>('upload');

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="font-playfair text-3xl font-bold text-[var(--text-primary)] mb-2">
          Фото мест
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Загрузка и проверка фотографий для карточек мест.
        </p>
      </header>

      <div className="flex gap-1 mb-6 p-1 rounded-lg w-fit" style={{ background: 'var(--bg-hover)' }}>
        {([
          { v: 'upload', label: 'Загрузка фото' },
          { v: 'audit', label: 'Проверка фото' },
        ] as const).map(({ v, label }) => (
          <button
            key={v}
            onClick={() => setTab(v)}
            className="px-4 py-2 rounded-md text-sm font-medium transition-all"
            style={{
              background: tab === v ? 'var(--bg-card)' : 'transparent',
              color: tab === v ? 'var(--text-primary)' : 'var(--text-muted)',
              boxShadow: tab === v ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'upload' ? <UploadTab /> : <AuditTab />}
    </main>
  );
}

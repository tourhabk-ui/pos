'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, X, MapPin, User, Calendar } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

type PhotoStatus = 'pending' | 'approved' | 'rejected';

interface PhotoItem {
  id: string;
  placeId: string;
  placeName: string;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  url: string;
  caption: string | null;
  status: string;
  createdAt: string;
}

type ApiResponse =
  | { success: true; data: PhotoItem[] }
  | { success: false; error: string };

// ── Tabs ──────────────────────────────────────────────────────────────────────

const TABS: { label: string; value: PhotoStatus }[] = [
  { label: 'Ожидают', value: 'pending' },
  { label: 'Одобрены', value: 'approved' },
  { label: 'Отклонены', value: 'rejected' },
];

// ── Main component ────────────────────────────────────────────────────────────

export function UserPhotosClient() {
  const [tab, setTab] = useState<PhotoStatus>('pending');
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const loadPhotos = useCallback(async (status: PhotoStatus) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/user-photos?status=${status}`);
      const json: unknown = await res.json();
      if (
        typeof json === 'object' &&
        json !== null &&
        'success' in json &&
        (json as ApiResponse).success === true
      ) {
        setPhotos((json as { success: true; data: PhotoItem[] }).data);
      } else {
        setPhotos([]);
      }
    } catch {
      setPhotos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPhotos(tab);
  }, [tab, loadPhotos]);

  const handleAction = async (id: string, action: 'approve' | 'reject') => {
    setActionInProgress(id);
    try {
      const res = await fetch(`/api/admin/user-photos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        // Optimistically remove from current list
        setPhotos((prev) => prev.filter((p) => p.id !== id));
      }
    } finally {
      setActionInProgress(null);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="ds-h1 mb-1">Фото туристов</h1>
        <p className="text-[var(--text-secondary)] text-sm">
          Модерация пользовательских фотографий мест перед публикацией.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.value
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="ds-skeleton h-64 rounded-lg" />
          ))}
        </div>
      ) : photos.length === 0 ? (
        <div className="ds-card flex flex-col items-center justify-center py-16 text-center">
          <p className="text-[var(--text-secondary)] text-sm">Нет фото для проверки</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {photos.map((photo) => (
            <PhotoCard
              key={photo.id}
              photo={photo}
              showActions={tab === 'pending'}
              actionInProgress={actionInProgress}
              onApprove={() => handleAction(photo.id, 'approve')}
              onReject={() => handleAction(photo.id, 'reject')}
              formatDate={formatDate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Photo card ────────────────────────────────────────────────────────────────

interface PhotoCardProps {
  photo: PhotoItem;
  showActions: boolean;
  actionInProgress: string | null;
  onApprove: () => void;
  onReject: () => void;
  formatDate: (d: string) => string;
}

function PhotoCard({
  photo,
  showActions,
  actionInProgress,
  onApprove,
  onReject,
  formatDate,
}: PhotoCardProps) {
  const isBusy = actionInProgress === photo.id;

  return (
    <div className="ds-card flex flex-col gap-3">
      {/* Photo */}
      <div className="relative w-full aspect-video rounded overflow-hidden bg-[var(--bg-hover)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photo.url}
          alt={photo.caption ?? photo.placeName}
          className="w-full h-full object-cover"
          loading="lazy"
        />
      </div>

      {/* Info */}
      <div className="flex-1 space-y-1.5">
        <div className="flex items-start gap-1.5">
          <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--ocean)]" />
          <span className="text-sm font-medium text-[var(--text-primary)] leading-tight">
            {photo.placeName || '—'}
          </span>
        </div>

        {(photo.userEmail || photo.userName) && (
          <div className="flex items-center gap-1.5">
            <User className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
            <span className="text-xs text-[var(--text-secondary)] truncate">
              {photo.userEmail ?? photo.userName}
            </span>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <Calendar className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
          <span className="text-xs text-[var(--text-muted)]">{formatDate(photo.createdAt)}</span>
        </div>

        {photo.caption && (
          <p className="text-xs text-[var(--text-secondary)] line-clamp-2 mt-1">{photo.caption}</p>
        )}
      </div>

      {/* Actions */}
      {showActions && (
        <div className="flex gap-2 pt-1">
          <button
            onClick={onApprove}
            disabled={isBusy}
            className="ds-btn ds-btn-primary flex-1 flex items-center justify-center gap-1.5 text-sm py-1.5 disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" />
            Одобрить
          </button>
          <button
            onClick={onReject}
            disabled={isBusy}
            className="ds-btn ds-btn-danger flex-1 flex items-center justify-center gap-1.5 text-sm py-1.5 disabled:opacity-50"
          >
            <X className="w-3.5 h-3.5" />
            Отклонить
          </button>
        </div>
      )}
    </div>
  );
}

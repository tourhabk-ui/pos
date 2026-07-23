'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, ImagePlus, Trash2, Image as ImageIcon } from 'lucide-react';

/**
 * Фото объекта размещения: байты — существующий POST /api/upload
 * (S3 в проде, public/uploads в dev), привязка —
 * POST /api/stay/accommodations/[id]/photos. Первое фото становится
 * обложкой на витрине (листинг и детальная берут images[0]).
 */

interface Photo {
  id: string;
  url: string;
  alt: string | null;
}

export default function PhotosClient({ accommodationId }: { accommodationId: string }) {
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    fetch(`/api/stay/accommodations/${accommodationId}/photos`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { success?: boolean; data?: { photos: Photo[] } } | null) => {
        if (d?.success && Array.isArray(d.data?.photos)) setPhotos(d.data.photos);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [accommodationId]);

  useEffect(() => { load(); }, [load]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      for (const file of Array.from(files)) formData.append('files', file);

      const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
      const uploadData = await uploadRes.json() as { success?: boolean; error?: string; data?: { files: string[] } };
      if (!uploadRes.ok || !uploadData.success || !uploadData.data?.files?.length) {
        setError(uploadData.error || 'Не удалось загрузить файлы');
        return;
      }

      for (const url of uploadData.data.files) {
        const res = await fetch(`/api/stay/accommodations/${accommodationId}/photos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const d = await res.json() as { success?: boolean; error?: string };
        if (!res.ok || !d.success) {
          setError(d.error || 'Файл загружен, но не привязался к объекту');
        }
      }
      load();
    } catch {
      setError('Не удалось загрузить файлы');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function removePhoto(photo: Photo) {
    if (!window.confirm('Удалить фотографию с витрины объекта?')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/stay/accommodations/${accommodationId}/photos/${photo.id}`, {
        method: 'DELETE',
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !d.success) {
        setError(d.error || 'Не удалось удалить фотографию');
        return;
      }
      load();
    } catch {
      setError('Не удалось удалить фотографию');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Link href="/hub/stay/accommodations" aria-label="К списку объектов"
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <ImageIcon className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Фото объекта</h1>
        </div>
        <button
          className="ds-btn ds-btn-primary text-xs"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
        >
          <ImagePlus className="w-3.5 h-3.5" /> {busy ? 'Загружаем…' : 'Добавить фото'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={e => handleFiles(e.target.files)}
        />
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        До 5 МБ на файл. Первое фото — обложка карточки на витрине.
      </p>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      {failed && <p className="text-sm text-[var(--danger)]">Не удалось загрузить фотографии. Обновите страницу.</p>}

      {photos === null && !failed && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="ds-skeleton h-36 rounded-lg" />)}
        </div>
      )}

      {photos !== null && photos.length === 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            Фотографий пока нет — объекты с фото бронируют заметно чаще.
          </p>
        </div>
      )}

      {photos !== null && photos.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {photos.map((photo, i) => (
            <div key={photo.id} className="relative group rounded-lg overflow-hidden border border-[var(--border)] bg-[var(--bg-hover)]">
              <div className="relative h-36 w-full">
                <Image
                  src={photo.url}
                  alt={photo.alt ?? 'Фото объекта'}
                  fill
                  className="object-cover"
                  sizes="(max-width: 640px) 50vw, 25vw"
                />
              </div>
              {i === 0 && (
                <span className="absolute top-2 left-2 px-2 py-0.5 rounded-lg text-[10px] bg-black/70 text-white">
                  Обложка
                </span>
              )}
              <button
                onClick={() => removePhoto(photo)}
                disabled={busy}
                aria-label="Удалить фотографию"
                className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 text-white opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

'use client';

import { useState, useRef } from 'react';
import { Camera, Upload, X, CheckCircle, Loader2 } from 'lucide-react';

interface PhotoUploadProps {
  placeId: string;
  placeName: string;
}

type UploadState = 'idle' | 'uploading' | 'success' | 'error';

export function PhotoUpload({ placeId, placeName }: PhotoUploadProps) {
  const [state, setState] = useState<UploadState>('idle');
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (f: File) => {
    if (f.size > 10 * 1024 * 1024) { setError('Максимум 10 МБ'); return; }
    setFile(f);
    setError(null);
    const reader = new FileReader();
    reader.onload = e => setPreview(e.target?.result as string);
    reader.readAsDataURL(f);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const handleSubmit = async () => {
    if (!file) return;
    setState('uploading');
    setError(null);

    const fd = new FormData();
    fd.append('file', file);
    if (caption.trim()) fd.append('caption', caption.trim());

    try {
      const res = await fetch(`/api/places/${placeId}/photos`, { method: 'POST', body: fd });
      const data = await res.json() as { success: boolean; error?: string };
      if (!res.ok || !data.success) {
        setError(data.error ?? 'Ошибка загрузки');
        setState('error');
        return;
      }
      setState('success');
    } catch {
      setError('Нет соединения');
      setState('error');
    }
  };

  const reset = () => {
    setState('idle'); setPreview(null); setFile(null); setCaption(''); setError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  if (state === 'success') {
    return (
      <div className="ds-card p-5 flex flex-col items-center gap-3 text-center">
        <CheckCircle size={32} className="text-[var(--success)]" />
        <p className="font-semibold text-[var(--text-primary)]">Фото отправлено!</p>
        <p className="text-sm text-[var(--text-secondary)]">
          Оно появится после проверки модератором.
        </p>
        <button onClick={reset} className="text-sm text-[var(--accent)] hover:underline">
          Добавить ещё фото
        </button>
      </div>
    );
  }

  return (
    <div className="ds-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Camera size={18} className="text-[var(--ocean)]" />
        <h3 className="font-semibold text-[var(--text-primary)]">Добавить фото</h3>
      </div>
      <p className="text-sm text-[var(--text-secondary)] mb-4">
        Были в <span className="font-medium">{placeName}</span>? Поделитесь фото с другими туристами.
      </p>

      {!preview ? (
        <div
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          className="border-2 border-dashed border-[var(--border)] rounded-lg p-8 text-center cursor-pointer hover:border-[var(--accent)] transition-colors"
        >
          <Upload size={24} className="mx-auto text-[var(--text-muted)] mb-2" />
          <p className="text-sm text-[var(--text-secondary)]">
            Перетащите фото или{' '}
            <span className="text-[var(--accent)] underline">выберите файл</span>
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-1">JPEG, PNG, WebP — до 10 МБ</p>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
        </div>
      ) : (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="preview" className="w-full h-48 object-cover rounded-lg" />
          <button
            onClick={reset}
            className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 flex items-center justify-center text-white hover:bg-black/80"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {preview && (
        <div className="mt-3">
          <input
            value={caption}
            onChange={e => setCaption(e.target.value)}
            placeholder="Подпись (необязательно)"
            maxLength={300}
            className="ds-input w-full text-sm"
          />
        </div>
      )}

      {error && (
        <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>
      )}

      {preview && (
        <button
          onClick={handleSubmit}
          disabled={state === 'uploading'}
          className="mt-3 ds-btn ds-btn-primary w-full flex items-center justify-center gap-2"
        >
          {state === 'uploading' ? (
            <><Loader2 size={16} className="animate-spin" /> Загрузка...</>
          ) : (
            <><Upload size={16} /> Отправить на проверку</>
          )}
        </button>
      )}
    </div>
  );
}

'use client';

/**
 * Экран «страница не догрузилась» для границ разделов. Корневая граница
 * (app/global-error.tsx) рисует те же слова своими стилями: при её показе
 * стили сайта могли не прийти.
 *
 * Пока идёт автоперезагрузка, кнопки нет — второй щелчок её только
 * перебьёт. В остальных исходах кнопка обновляет страницу целиком.
 */
import { WifiOff } from 'lucide-react';
import {
  CHUNK_TEXT,
  browserPage,
  chunkNoticeBody,
  type ChunkReloadDecision,
} from '@/lib/client-errors/chunk-load';

export function ChunkLoadNotice({ decision }: { decision: ChunkReloadDecision | null }) {
  const reloading = decision === 'reload';
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6 bg-[var(--bg-primary)]">
      <div className="text-center max-w-md" role="alert">
        <div className="w-14 h-14 mx-auto mb-5 rounded-lg bg-[var(--bg-hover)] flex items-center justify-center">
          <WifiOff className="w-7 h-7 text-[var(--text-muted)]" aria-hidden="true" />
        </div>
        <h2 className="font-playfair text-xl font-bold text-[var(--text-primary)] mb-2">{CHUNK_TEXT.title}</h2>
        <p className="text-sm text-[var(--text-secondary)] mb-6">{chunkNoticeBody(decision)}</p>
        {!reloading && (
          <button type="button" onClick={() => browserPage.reload()} className="ds-btn ds-btn-primary">
            {CHUNK_TEXT.button}
          </button>
        )}
      </div>
    </div>
  );
}

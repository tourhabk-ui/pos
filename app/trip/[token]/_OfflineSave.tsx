'use client';

/**
 * «Сохранить для офлайна» на странице плана (#2225).
 *
 * Состояние называется словами, а не угадывается: план либо сохранён на этом
 * устройстве (и когда), либо нет — и тогда без связи страница может не
 * открыться, — либо сохранить здесь нельзя. Последнее показывается вместо
 * кнопки, которая ничего бы не сделала. Образец — «карта не сохранена» в
 * полевом контуре.
 */

import { useCallback, useEffect, useState } from 'react';
import { WifiOff, CheckCircle2, RefreshCw, Trash2, Save } from 'lucide-react';
import {
  readOfflineStatus, saveTripOffline, removeTripOffline, pageAssetPaths,
  type OfflineDeps, type OfflineStatus,
} from '@/lib/offline/trip-save';
import { funnelBeacon } from '@/lib/funnel/beacon';

function deps(): OfflineDeps {
  return {
    caches: typeof caches !== 'undefined' ? caches : undefined,
    fetch: (input, init) => fetch(input, init),
  };
}

/** Файлы, которые страница уже загрузила: скрипты, стили, шрифты, ленивые чанки карты. */
function loadedAssets(): string[] {
  const urls: string[] = [];
  document.querySelectorAll('script[src]').forEach((el) => urls.push((el as HTMLScriptElement).src));
  document.querySelectorAll('link[rel="stylesheet"][href]').forEach((el) => urls.push((el as HTMLLinkElement).href));
  try {
    for (const e of performance.getEntriesByType('resource')) urls.push(e.name);
  } catch {
    // Нет Resource Timing — останутся теги страницы, этого хватит на текст плана.
  }
  return pageAssetPaths(window.location.origin, urls);
}

function formatSavedAt(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

export function OfflineSave({ token, isDraft }: { token: string; isDraft: boolean }) {
  const [status, setStatus] = useState<OfflineStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    readOfflineStatus(token, deps()).then((s) => { if (alive) setStatus(s); });
    return () => { alive = false; };
  }, [token]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    const r = await saveTripOffline(token, loadedAssets(), deps());
    setBusy(false);
    if (!r.ok) { setError(r.reason); return; }
    setStatus({ kind: 'saved', savedAt: r.savedAt });
    funnelBeacon('offline_bundle_download', token);
    const notes: string[] = [];
    if (!r.gpx) notes.push('GPX не сохранился — у плана нет точек с координатами или сеть моргнула.');
    if (r.assetsFailed > 0) notes.push('Часть файлов страницы не сохранилась: без связи откроется текст плана, карта может не загрузиться.');
    // Без service worker'а копию некому отдать без сети — сказать прямо.
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
      notes.push('Офлайн заработает после того, как страница один раз перезагрузится с интернетом.');
    }
    setNote(notes.join(' ') || null);
  }, [token]);

  const remove = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    const ok = await removeTripOffline(token, deps());
    setBusy(false);
    if (ok) setStatus({ kind: 'not_saved' });
    else setError('не удалось убрать копию с устройства');
  }, [token]);

  if (status === null) {
    return <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Проверяю, сохранён ли план на этом устройстве…</p>;
  }

  if (status.kind === 'unavailable') {
    return (
      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
        Сохранить план на телефон в этом браузере нельзя: {status.reason}. GPX выше откроется в навигаторе и без сети.
      </p>
    );
  }

  const saved = status.kind === 'saved';
  return (
    <div className="rounded-lg p-3 space-y-2"
      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderLeft: `4px solid ${saved ? 'var(--success)' : 'var(--warning)'}` }}>
      <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
        {saved
          ? <CheckCircle2 className="w-4 h-4 flex-none" style={{ color: 'var(--success)' }} />
          : <WifiOff className="w-4 h-4 flex-none" style={{ color: 'var(--warning)' }} />}
        {saved ? 'План сохранён на этом устройстве' : 'План не сохранён для офлайна'}
      </div>
      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
        {saved
          ? <>Откроется без интернета по этой же ссылке{formatSavedAt(status.savedAt) ? ` — копия от ${formatSavedAt(status.savedAt)}` : ''}.
            {isDraft ? ' Копия на телефоне останется и тогда, когда ссылка перестанет открываться онлайн.' : ''} Изменили план — обновите копию.</>
          : 'Без связи эта страница может не открыться. Сохраните её, пока есть интернет: страница, GPX и файлы карты лягут на телефон.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button onClick={save} disabled={busy}
          className={saved
            ? 'flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-all duration-200 disabled:opacity-60'
            : 'ds-btn ds-btn-primary flex items-center gap-2 text-sm px-3 py-2 disabled:opacity-60'}
          style={saved ? { background: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border)' } : undefined}>
          {saved ? <RefreshCw className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {busy ? 'Сохраняю…' : saved ? 'Обновить копию' : 'Сохранить для офлайна'}
        </button>
        {saved && (
          <button onClick={remove} disabled={busy}
            className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-all duration-200 disabled:opacity-60"
            style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
            <Trash2 className="w-4 h-4" />Убрать с устройства
          </button>
        )}
      </div>
      {error && <p className="text-xs" style={{ color: 'var(--danger)' }}>Не сохранилось: {error}.</p>}
      {note && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{note}</p>}
    </div>
  );
}

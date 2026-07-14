'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Trash2, EyeOff, Eye, Search, AlertTriangle, ImageOff, RefreshCw } from 'lucide-react';

interface PlaceItem {
  id: string;
  name: string;
  locationType: string | null;
  isVisible: boolean;
  hasPhoto: boolean;
  photoUrl: string | null;
  garbageName: boolean;
  descLen: number;
}

type Filter = 'all' | 'garbage' | 'no_photo' | 'hidden';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all',      label: 'Все' },
  { key: 'garbage',  label: 'Мусорное имя' },
  { key: 'no_photo', label: 'Без фото' },
  { key: 'hidden',   label: 'Скрытые' },
];

function authHeaders(json = false): HeadersInit {
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  try {
    const t = (JSON.parse(localStorage.getItem('user') || 'null') as { token?: string } | null)?.token;
    if (t) h.Authorization = `Bearer ${t}`;
  } catch { /* cookie-сессия */ }
  return h;
}

export default function PlacesCleanupClient() {
  const [items, setItems]   = useState<PlaceItem[]>([]);
  const [total, setTotal]   = useState(0);
  const [pages, setPages]   = useState(1);
  const [page, setPage]     = useState(1);
  const [filter, setFilter] = useState<Filter>('garbage');
  const [q, setQ]           = useState('');
  const [qDraft, setQDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ filter, page: String(page), limit: '50' });
      if (q) params.set('q', q);
      const res = await fetch(`/api/admin/places/cleanup?${params}`, { headers: authHeaders() });
      if (res.status === 401 || res.status === 403) { setError('Нужен вход под админ-аккаунтом.'); setItems([]); return; }
      const data = await res.json();
      if (!res.ok) { setError(data?.error || 'Ошибка загрузки'); setItems([]); return; }
      setItems(data.items); setTotal(data.total); setPages(data.pages);
    } catch {
      setError('Сеть недоступна');
    } finally {
      setLoading(false);
    }
  }, [filter, page, q]);

  useEffect(() => { load(); }, [load]);
  // Сброс выбора и страницы при смене фильтра/поиска
  useEffect(() => { setSelected(new Set()); }, [filter, q, page]);

  const toggle = (id: string) => setSelected(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const allOnPageSelected = items.length > 0 && items.every(i => selected.has(i.id));
  const toggleAll = () => setSelected(prev => {
    if (items.every(i => prev.has(i.id))) { const n = new Set(prev); items.forEach(i => n.delete(i.id)); return n; }
    const n = new Set(prev); items.forEach(i => n.add(i.id)); return n;
  });

  const bulk = useCallback(async (action: 'hide' | 'unhide' | 'delete') => {
    const ids = [...selected];
    if (ids.length === 0 || busy) return;
    if (action === 'delete' && !window.confirm(`Удалить ${ids.length} мест безвозвратно? Действие необратимо.`)) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/places/bulk', {
        method: 'POST', headers: authHeaders(true), body: JSON.stringify({ ids, action }),
      });
      const data = await res.json();
      if (!res.ok) { window.alert(data?.error || `Не выполнено (HTTP ${res.status})`); return; }
      setSelected(new Set());
      await load();
    } catch {
      window.alert('Сеть недоступна');
    } finally {
      setBusy(false);
    }
  }, [selected, busy, load]);

  return (
    <div className="ds-page max-w-4xl mx-auto px-4 py-6">
      <h1 className="ds-h1 mb-1">Чистка мест</h1>
      <p className="text-[var(--text-secondary)] text-sm mb-4">
        Всего по фильтру: <b>{total}</b>. Мусор — сверху. «Скрыть» обратимо, «Удалить» — навсегда.
      </p>

      {/* Поиск */}
      <form
        onSubmit={(e) => { e.preventDefault(); setPage(1); setQ(qDraft.trim()); }}
        className="flex gap-2 mb-3"
      >
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            placeholder="Поиск по названию…"
            className="ds-input w-full pl-9"
          />
        </div>
        <button type="submit" className="ds-btn ds-btn-secondary">Найти</button>
      </form>

      {/* Фильтры */}
      <div className="flex flex-wrap gap-2 mb-4">
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => { setPage(1); setFilter(f.key); }}
            className="ds-badge px-3 py-1.5 text-sm transition-colors"
            style={{
              background: filter === f.key ? 'var(--accent)' : 'var(--bg-card)',
              color: filter === f.key ? '#fff' : 'var(--text-secondary)',
              borderColor: 'var(--border)',
            }}
          >
            {f.label}
          </button>
        ))}
        <button onClick={() => load()} className="ds-badge px-3 py-1.5 text-sm ml-auto" title="Обновить">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Bulk-панель */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 mb-3 p-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] shadow">
          <span className="text-sm font-semibold px-2">Выбрано: {selected.size}</span>
          <button disabled={busy} onClick={() => bulk('hide')} className="ds-btn ds-btn-secondary text-sm inline-flex items-center gap-1">
            <EyeOff className="w-4 h-4" /> Скрыть
          </button>
          <button disabled={busy} onClick={() => bulk('unhide')} className="ds-btn ds-btn-secondary text-sm inline-flex items-center gap-1">
            <Eye className="w-4 h-4" /> Показать
          </button>
          <button disabled={busy} onClick={() => bulk('delete')} className="ds-btn ds-btn-danger text-sm inline-flex items-center gap-1">
            <Trash2 className="w-4 h-4" /> Удалить
          </button>
          <button onClick={() => setSelected(new Set())} className="text-sm text-[var(--text-muted)] px-2 ml-auto">Сброс</button>
        </div>
      )}

      {error && <div className="ds-card p-4 text-[var(--danger)] mb-4">{error}</div>}
      {loading && <div className="ds-skeleton h-40 rounded-lg" />}

      {!loading && !error && (
        <>
          {items.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] mb-2 px-1 cursor-pointer">
              <input type="checkbox" checked={allOnPageSelected} onChange={toggleAll} />
              Выделить всё на странице
            </label>
          )}
          <ul className="space-y-2">
            {items.map(it => (
              <li
                key={it.id}
                className="flex items-center gap-3 p-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]"
                style={{ opacity: it.isVisible ? 1 : 0.55 }}
              >
                <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it.id)} className="flex-shrink-0" />
                {it.photoUrl
                  ? <img src={it.photoUrl} alt="" className="w-12 h-12 rounded object-cover flex-shrink-0" loading="lazy" />
                  : <div className="w-12 h-12 rounded bg-[var(--bg-hover)] flex items-center justify-center flex-shrink-0"><ImageOff className="w-5 h-5 text-[var(--text-muted)]" /></div>}
                <div className="min-w-0 flex-1">
                  <Link href={`/places/${it.id}`} target="_blank" className="font-medium text-[var(--text-primary)] hover:text-[var(--accent)] line-clamp-2 text-sm">
                    {it.name}
                  </Link>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1">
                    <span className="text-xs text-[var(--text-muted)]">{it.locationType ?? '—'}</span>
                    {it.garbageName && <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--warning)]/20 text-[var(--warning)]"><AlertTriangle className="w-3 h-3" />мусор</span>}
                    {!it.hasPhoto && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--bg-hover)] text-[var(--text-muted)]">без фото</span>}
                    {!it.isVisible && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--bg-hover)] text-[var(--text-muted)]">скрыто</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {items.length === 0 && <div className="ds-card p-6 text-center text-[var(--text-muted)]">Ничего не найдено.</div>}

          {pages > 1 && (
            <div className="flex items-center justify-center gap-3 mt-5">
              <button disabled={page <= 1} onClick={() => setPage(p => Math.max(p - 1, 1))} className="ds-btn ds-btn-secondary text-sm disabled:opacity-40">← Назад</button>
              <span className="text-sm text-[var(--text-secondary)]">{page} / {pages}</span>
              <button disabled={page >= pages} onClick={() => setPage(p => Math.min(p + 1, pages))} className="ds-btn ds-btn-secondary text-sm disabled:opacity-40">Вперёд →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

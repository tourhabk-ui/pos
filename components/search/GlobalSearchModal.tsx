'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Map, Route, Wrench, FileText, X, ArrowRight } from 'lucide-react';

interface SearchResult {
  id: string;
  type: 'route' | 'place' | 'tool' | 'page';
  title: string;
  subtitle?: string;
  href: string;
}

const TYPE_CONFIG = {
  route:  { label: 'Маршрут', icon: Route,    color: 'var(--accent)' },
  place:  { label: 'Место',   icon: Map,       color: 'var(--ocean)' },
  tool:   { label: 'Утилита', icon: Wrench,    color: 'var(--success)' },
  page:   { label: 'Раздел',  icon: FileText,  color: 'var(--text-muted)' },
};

const QUICK_LINKS = [
  { title: 'Карта маршрутов',          href: '/map',          type: 'page' as const },
  { title: 'Чек-лист снаряжения',      href: '/tools/equipment', type: 'tool' as const },
  { title: 'Анализатор безопасности',  href: '/tools/safety', type: 'tool' as const },
  { title: 'Спросить Кузьмича',        href: '/ai-assistant', type: 'tool' as const },
];

export function GlobalSearchModal() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openModal = useCallback(() => {
    setOpen(true);
    setQuery('');
    setResults([]);
    setActiveIndex(-1);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const closeModal = useCallback(() => {
    setOpen(false);
    setQuery('');
    setResults([]);
  }, []);

  // Ctrl+K / Cmd+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(prev => { if (!prev) { setTimeout(() => inputRef.current?.focus(), 50); } return !prev; });
      }
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeModal]);

  // Custom event from Header button
  useEffect(() => {
    const handler = () => openModal();
    window.addEventListener('open-search', handler);
    return () => window.removeEventListener('open-search', handler);
  }, [openModal]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) { setResults([]); setLoading(false); return; }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}&limit=10`);
        const json = await res.json() as { success: boolean; data?: SearchResult[] };
        if (json.success && json.data) setResults(json.data);
      } catch { /* silent */ } finally {
        setLoading(false);
      }
    }, 200);
  }, [query]);

  // Keyboard navigation
  const allItems = query.trim() ? results : QUICK_LINKS.map((q, i) => ({ ...q, id: String(i), subtitle: undefined }));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, allItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, -1));
    } else if (e.key === 'Enter' && activeIndex >= 0 && allItems[activeIndex]) {
      e.preventDefault();
      router.push(allItems[activeIndex].href);
      closeModal();
    }
  };

  const handleSelect = (href: string) => {
    router.push(href);
    closeModal();
  };

  if (!open) return null;

  const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac');

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[200] bg-black/50"
        onClick={closeModal}
        aria-hidden
      />

      {/* Modal */}
      <div className="fixed z-[201] top-[10vh] left-1/2 -translate-x-1/2 w-full max-w-xl px-4">
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden">

          {/* Input row */}
          <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--border)]">
            <Search size={18} className="text-[var(--text-muted)] flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => { setQuery(e.target.value); setActiveIndex(-1); }}
              onKeyDown={handleKeyDown}
              placeholder="Поиск по Камчатке..."
              className="flex-1 bg-transparent text-[var(--text-primary)] placeholder-[var(--text-muted)] text-sm outline-none"
              autoComplete="off"
            />
            {loading && (
              <span className="w-4 h-4 border-2 border-[var(--text-muted)] border-t-transparent rounded-full animate-spin flex-shrink-0" />
            )}
            <button onClick={closeModal} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors">
              <X size={16} />
            </button>
          </div>

          {/* Results / Quick links */}
          <div className="max-h-[60vh] overflow-y-auto">
            {!query.trim() && (
              <div className="px-4 pt-3 pb-1">
                <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[var(--text-muted)] mb-2">
                  Быстрый переход
                </p>
              </div>
            )}

            {allItems.length === 0 && query.trim() && !loading && (
              <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                Ничего не найдено по &laquo;{query}&raquo;
              </div>
            )}

            {allItems.map((item, idx) => {
              const cfg = TYPE_CONFIG[item.type];
              const Icon = cfg.icon;
              const isActive = idx === activeIndex;
              return (
                <button
                  key={item.id}
                  onClick={() => handleSelect(item.href)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${isActive ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]'}`}
                >
                  <div
                    className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
                    style={{ background: `color-mix(in srgb, ${cfg.color} 15%, var(--bg-primary))` }}
                  >
                    <Icon size={14} style={{ color: cfg.color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--text-primary)] truncate">{item.title}</p>
                    {item.subtitle && (
                      <p className="text-xs text-[var(--text-muted)] truncate">{item.subtitle}</p>
                    )}
                  </div>
                  {isActive && <ArrowRight size={14} className="text-[var(--text-muted)] flex-shrink-0" />}
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--border)] bg-[var(--bg-hover)]">
            <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 rounded border border-[var(--border)] font-mono bg-[var(--bg-card)]">↑↓</kbd>
                навигация
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 rounded border border-[var(--border)] font-mono bg-[var(--bg-card)]">↵</kbd>
                перейти
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 rounded border border-[var(--border)] font-mono bg-[var(--bg-card)]">Esc</kbd>
                закрыть
              </span>
            </div>
            <span className="text-[10px] text-[var(--text-muted)]">
              {isMac ? '⌘K' : 'Ctrl+K'}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

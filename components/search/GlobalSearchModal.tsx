'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Search, Map, Route, Wrench, FileText, X, ArrowRight, TreePine, Ticket, MessageCircle } from 'lucide-react';

interface SearchResult {
  id: string;
  type: 'tour' | 'route' | 'place' | 'park' | 'tool' | 'chat' | 'page';
  title: string;
  subtitle?: string;
  href: string;
}

const TYPE_CONFIG = {
  tour:   { label: 'Тур',     icon: Ticket,    color: 'var(--accent)' },
  route:  { label: 'Маршрут', icon: Route,    color: 'var(--accent)' },
  place:  { label: 'Место',   icon: Map,       color: 'var(--ocean)' },
  park:   { label: 'Парк',    icon: TreePine,  color: 'var(--success)' },
  tool:   { label: 'Утилита', icon: Wrench,    color: 'var(--success)' },
  chat:   { label: 'Кузьмич', icon: MessageCircle, color: 'var(--ocean)' },
  page:   { label: 'Раздел',  icon: FileText,  color: 'var(--text-muted)' },
};

/*
 * «Туры» — первым (аудит П7, #97/#106/#111): до 24.09 в быстром переходе не
 * было ни одного пути к тому, что платформа продаёт. Кузьмичу — иконка чата,
 * а не гаечный ключ: это разговор, а не утилита.
 */
const QUICK_LINKS = [
  { title: 'Туры',                     href: '/catalog',      type: 'tour' as const },
  { title: 'Карта маршрутов',          href: '/map',          type: 'page' as const },
  { title: 'Чек-лист снаряжения',      href: '/tools/equipment', type: 'tool' as const },
  { title: 'Анализатор безопасности',  href: '/tools/safety', type: 'tool' as const },
  { title: 'Спросить Кузьмича',        href: '/ai-assistant', type: 'chat' as const },
];

export function GlobalSearchModal() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  /*
   * Исход поиска — три состояния, не два (§4.0). До 24.09 отказ API
   * (`success:false`, 500, сеть) глотался немым catch и показывался текстом «Ничего не найдено» — турист читал «туров нет»
   * там, где поиск просто не ответил.
   */
  const [status, setStatus] = useState<'idle' | 'ok' | 'failed'>('idle');
  /** Какой источник не ответил, хотя остальные ответили (поле `unavailable`). */
  const [partial, setPartial] = useState<Array<'tours' | 'geo'>>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openModal = useCallback(() => {
    setOpen(true);
    setQuery('');
    setResults([]);
    setStatus('idle');
    setPartial([]);
    setActiveIndex(-1);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const closeModal = useCallback(() => {
    setOpen(false);
    setQuery('');
    setResults([]);
    setStatus('idle');
    setPartial([]);
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
    if (!query.trim()) { setResults([]); setStatus('idle'); setPartial([]); setLoading(false); return; }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}&limit=10`);
        const json = await res.json().catch(() => null) as
          | { success: boolean; data?: SearchResult[]; unavailable?: Array<'tours' | 'geo'>; error?: string }
          | null;
        if (!res.ok || !json || !json.success || !Array.isArray(json.data)) {
          throw new Error(`HTTP ${res.status}${json?.error ? `: ${json.error}` : ''}`);
        }
        setResults(json.data);
        setPartial(Array.isArray(json.unavailable) ? json.unavailable : []);
        setStatus('ok');
      } catch (err) {
        console.error('[search-modal] поиск не ответил:', err instanceof Error ? err.message : String(err));
        setResults([]);
        setPartial([]);
        setStatus('failed');
      } finally {
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
    } else if (e.key === 'Enter') {
      // Enter без выделения — первый результат: человек набрал «сплав» и
      // нажал «ввод», он не обязан сперва стрелкой выбирать единственный тур.
      // Пока ответ на новый запрос не пришёл, «первый» — это первый результат
      // ПРЕЖНЕГО запроса: в каталог по набранному, а не в чужой тур.
      if (loading && activeIndex < 0 && query.trim()) {
        e.preventDefault();
        router.push(`/catalog?search=${encodeURIComponent(query.trim())}`);
        closeModal();
        return;
      }
      const target = activeIndex >= 0 ? allItems[activeIndex] : allItems[0];
      if (!target) return;
      e.preventDefault();
      router.push(target.href);
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

      {/*
        Modal.

        role="dialog" + aria-modal + подпись — не украшение и не «для теста».
        До 12.09 модалка поиска была набором div'ов: человек со скринридером
        нажимал кнопку «Поиск (Ctrl+K)» в шапке, окно открывалось, и ему не
        сообщалось НИЧЕГО — ни что появился диалог, ни что в нём. Поиск в
        шапке у нас единственный (решение владельца §2: только иконка, всё
        остальное в модалке), то есть без этих атрибутов искать по платформе
        с экранным диктором было нечем.

        Нашлось, когда e2e-проверка «поиск открывается модальным окном» стала
        спрашивать по РОЛИ, а не по классам: getByRole('dialog') не нашёл
        ничего. Тест был прав, разметка — нет (DS §10).
      */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Поиск по платформе"
        className="fixed z-[201] top-[10vh] left-1/2 -translate-x-1/2 w-full max-w-xl px-4"
      >
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
              placeholder="Туры, места, маршруты…"
              aria-label="Что ищем"
              // 16px на телефоне: при text-sm iOS увеличивает страницу на фокусе.
              className="flex-1 min-w-0 bg-transparent text-[var(--text-primary)] placeholder-[var(--text-muted)] text-base md:text-sm outline-none"
              autoComplete="off"
            />
            {loading && (
              <span className="w-4 h-4 border-2 border-[var(--text-muted)] border-t-transparent rounded-full animate-spin flex-shrink-0" />
            )}
            <button
              type="button"
              onClick={closeModal}
              aria-label="Закрыть поиск"
              className="-mr-2 w-11 h-11 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors flex-shrink-0"
            >
              <X size={18} />
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

            {query.trim() && !loading && status === 'failed' && (
              <div role="alert" className="px-4 py-8 text-center">
                <p className="text-sm font-semibold text-[var(--text-primary)]">Поиск сейчас не работает</p>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">Это сбой у нас, а не пустой каталог.</p>
                <Link
                  href="/catalog"
                  onClick={closeModal}
                  className="mt-3 inline-flex items-center gap-1 min-h-[44px] text-sm font-semibold text-[var(--accent)]"
                >
                  Открыть каталог туров <ArrowRight size={14} aria-hidden />
                </Link>
              </div>
            )}

            {query.trim() && !loading && status === 'ok' && allItems.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                Ничего не найдено по &laquo;{query}&raquo;
              </div>
            )}

            {query.trim() && status === 'ok' && partial.length > 0 && (
              <p className="px-4 pt-3 text-xs text-[var(--text-secondary)]">
                {partial.includes('tours')
                  ? 'Туры сейчас не ищутся — это сбой, а не пустой каталог. '
                  : 'Места и маршруты сейчас не ищутся — показаны только туры.'}
                {partial.includes('tours') && (
                  <Link href="/catalog" onClick={closeModal} className="font-semibold text-[var(--accent)]">Каталог туров</Link>
                )}
              </p>
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
          {/* Легенда клавиш — только там, где есть клавиатура (с md). */}
          <div className="hidden md:flex items-center justify-between px-4 py-2 border-t border-[var(--border)] bg-[var(--bg-hover)]">
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

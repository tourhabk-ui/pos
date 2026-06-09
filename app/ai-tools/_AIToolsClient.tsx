'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Search, Shield, Map, Camera, FileText, Mic2, BarChart2, Compass,
  Layers, Star, ExternalLink, Zap, Code2, X,
} from 'lucide-react';

interface Tool {
  id: string; slug: string; name: string; description: string; url: string;
  category: string; tags: string[]; is_free: boolean; api_available: boolean;
  rating: string | null; use_count: number; click_count: number; created_at: string;
}

interface CategoryStat { category: string; count: number; }

const CATEGORIES: { value: string; label: string; icon: React.ElementType }[] = [
  { value: 'all',    label: 'Все',             icon: Layers   },
  { value: 'safety', label: 'Безопасность',    icon: Shield   },
  { value: 'geo',    label: 'Геоинструменты',  icon: Map      },
  { value: 'image',  label: 'Изображения',     icon: Camera   },
  { value: 'text',   label: 'Текст и перевод', icon: FileText },
  { value: 'audio',  label: 'Аудио',           icon: Mic2     },
  { value: 'data',   label: 'Аналитика',       icon: BarChart2},
  { value: 'travel', label: 'Путешествия',     icon: Compass  },
];

const SORTS = [
  { value: 'trending', label: 'Популярные' },
  { value: 'rating',   label: 'По рейтингу' },
  { value: 'new',      label: 'Новые' },
];

function Stars({ rating }: { rating: string | null }) {
  const r = rating ? parseFloat(rating) : 0;
  if (!r) return null;
  return (
    <span className="flex items-center gap-0.5 text-[var(--warning)]">
      <Star size={11} fill="currentColor" />
      <span className="text-xs text-[var(--text-secondary)] ml-0.5">{r.toFixed(1)}</span>
    </span>
  );
}

function ToolCard({ tool }: { tool: Tool }) {
  const cat = CATEGORIES.find(c => c.value === tool.category);
  const Icon = cat?.icon ?? Layers;

  function trackClick() {
    fetch(`/api/tools/${tool.slug}`, { method: 'POST' }).catch(() => null);
  }

  return (
    <div className="ds-card flex flex-col gap-3 hover:border-[var(--accent)] transition-colors group">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: 'color-mix(in srgb, var(--ocean) 12%, var(--bg-card))' }}>
            <Icon size={16} className="text-[var(--ocean)]" />
          </div>
          <div>
            <p className="text-xs text-[var(--text-muted)]">{cat?.label ?? tool.category}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {tool.is_free && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
              style={{ background: 'color-mix(in srgb, var(--success) 12%, var(--bg-card))', color: 'var(--success)' }}>
              Бесплатно
            </span>
          )}
          {tool.api_available && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
              style={{ background: 'color-mix(in srgb, var(--ocean) 12%, var(--bg-card))', color: 'var(--ocean)' }}>
              API
            </span>
          )}
        </div>
      </div>

      <div className="flex-1">
        <Link href={`/ai-tools/${tool.slug}`}
          className="font-semibold text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors line-clamp-1 mb-1 block">
          {tool.name}
        </Link>
        <p className="text-sm text-[var(--text-secondary)] line-clamp-2 leading-snug">
          {tool.description}
        </p>
      </div>

      <div className="flex items-center justify-between pt-1 border-t border-[var(--border)]">
        <div className="flex items-center gap-3">
          <Stars rating={tool.rating} />
          {tool.use_count > 0 && (
            <span className="text-[11px] text-[var(--text-muted)] flex items-center gap-1">
              <Zap size={10} />
              {tool.use_count}
            </span>
          )}
        </div>
        <a href={tool.url} target="_blank" rel="noopener noreferrer" onClick={trackClick}
          className="flex items-center gap-1 text-xs font-semibold text-[var(--ocean)] hover:text-[var(--accent)] transition-colors">
          Открыть <ExternalLink size={11} />
        </a>
      </div>
    </div>
  );
}

export function AIToolsClient() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [categories, setCategories] = useState<CategoryStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState('trending');

  const load = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams();
    if (search) p.set('q', search);
    if (category !== 'all') p.set('category', category);
    p.set('sort', sort);

    try {
      const res = await fetch(`/api/tools?${p}`);
      if (res.ok) {
        const data = await res.json() as { tools: Tool[]; categories: CategoryStat[] };
        setTools(data.tools);
        if (data.categories.length) setCategories(data.categories);
      }
    } finally {
      setLoading(false);
    }
  }, [search, category, sort]);

  useEffect(() => { load(); }, [load]);

  const totalForCat = (cat: string) => {
    if (cat === 'all') return categories.reduce((s, c) => s + c.count, 0);
    return categories.find(c => c.category === cat)?.count ?? 0;
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-10">

      {/* Hero */}
      <div className="mb-10">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs font-semibold uppercase tracking-widest text-[var(--accent)]">Кузьмич рекомендует</span>
        </div>
        <h1 className="font-playfair text-4xl md:text-5xl font-bold text-[var(--text-primary)] mb-3 leading-tight">
          AI-арсенал<br className="hidden md:block" /> Камчатки
        </h1>
        <p className="text-[var(--text-secondary)] text-lg max-w-xl">
          Проверенные инструменты для безопасного путешествия — от лавинных прогнозов до определения растений на тропе.
        </p>
      </div>

      {/* Search */}
      <div className="relative mb-6 max-w-xl">
        <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Поиск: Windy, PlantNet, GPX..."
          className="ds-input pl-10 pr-10 w-full"
        />
        {search && (
          <button onClick={() => setSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <X size={14} />
          </button>
        )}
      </div>

      {/* Category tabs */}
      <div className="flex gap-2 flex-wrap mb-4">
        {CATEGORIES.map(cat => {
          const Icon = cat.icon;
          const count = totalForCat(cat.value);
          const active = category === cat.value;
          return (
            <button key={cat.value} onClick={() => setCategory(cat.value)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                active
                  ? 'bg-[var(--accent)] text-[var(--text-primary)]'
                  : 'bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] border border-[var(--border)]'
              }`}>
              <Icon size={14} />
              {cat.label}
              {count > 0 && <span className={`text-[10px] ${active ? 'opacity-80' : 'text-[var(--text-muted)]'}`}>{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Sort + count */}
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-[var(--text-muted)]">
          {loading ? '...' : `${tools.length} инструментов`}
        </p>
        <div className="flex gap-1">
          {SORTS.map(s => (
            <button key={s.value} onClick={() => setSort(s.value)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                sort === s.value
                  ? 'bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="ds-card animate-pulse h-40">
              <div className="ds-skeleton h-4 w-3/4 mb-2" />
              <div className="ds-skeleton h-3 w-full mb-1" />
              <div className="ds-skeleton h-3 w-2/3" />
            </div>
          ))}
        </div>
      ) : tools.length === 0 ? (
        <div className="text-center py-20">
          <Code2 size={40} className="mx-auto text-[var(--text-muted)] mb-4" />
          <p className="text-[var(--text-secondary)]">Инструменты не найдены</p>
          {search && (
            <button onClick={() => setSearch('')}
              className="mt-3 text-[var(--accent)] text-sm hover:underline">
              Сбросить поиск
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {tools.map(tool => <ToolCard key={tool.id} tool={tool} />)}
        </div>
      )}
    </div>
  );
}

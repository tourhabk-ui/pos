'use client';

import Link from 'next/link';
import {
  ArrowLeft, ExternalLink, Shield, Map, Camera, FileText, Mic2,
  BarChart2, Compass, Layers, Star, Zap, Code2, MessageCircle,
} from 'lucide-react';

interface Tool {
  slug: string; name: string; description: string; url: string;
  category: string; tags: string[]; is_free: boolean; api_available: boolean;
  rating: string | null; use_count: number; click_count: number; created_at: string;
}

interface Similar {
  slug: string; name: string; category: string;
  is_free: boolean; api_available: boolean; rating: string | null; use_count: number;
}

const CAT_META: Record<string, { label: string; icon: React.ElementType }> = {
  safety: { label: 'Безопасность',    icon: Shield    },
  geo:    { label: 'Геоинструменты',  icon: Map       },
  image:  { label: 'Изображения',     icon: Camera    },
  text:   { label: 'Текст и перевод', icon: FileText  },
  audio:  { label: 'Аудио',           icon: Mic2      },
  data:   { label: 'Аналитика',       icon: BarChart2 },
  travel: { label: 'Путешествия',     icon: Compass   },
};

function trackClick(slug: string) {
  fetch(`/api/tools/${slug}`, { method: 'POST' }).catch(() => null);
}

export function ToolDetailClient({ tool, similar }: { tool: Tool; similar: Similar[] }) {
  const meta = CAT_META[tool.category] ?? { label: tool.category, icon: Layers };
  const Icon = meta.icon;
  const rating = tool.rating ? parseFloat(tool.rating) : null;

  const kuzmichHref = `/kuzmich?q=${encodeURIComponent(`Расскажи про инструмент ${tool.name} — для чего его использовать на Камчатке?`)}`;

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">

      {/* Back */}
      <Link href="/ai-tools"
        className="inline-flex items-center gap-2 text-[var(--text-muted)] hover:text-[var(--text-secondary)] text-sm mb-8 transition-colors">
        <ArrowLeft size={14} /> Все инструменты
      </Link>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-sm font-medium"
            style={{ background: 'color-mix(in srgb, var(--ocean) 12%, var(--bg-card))', color: 'var(--ocean)' }}>
            <Icon size={13} />
            {meta.label}
          </div>
          {tool.is_free && (
            <span className="px-2.5 py-1 rounded-lg text-sm font-medium"
              style={{ background: 'color-mix(in srgb, var(--success) 12%, var(--bg-card))', color: 'var(--success)' }}>
              Бесплатно
            </span>
          )}
          {tool.api_available && (
            <span className="px-2.5 py-1 rounded-lg text-sm font-medium"
              style={{ background: 'color-mix(in srgb, var(--ocean) 12%, var(--bg-card))', color: 'var(--ocean)' }}>
              <Code2 size={12} className="inline mr-1" />API
            </span>
          )}
        </div>

        <h1 className="font-playfair text-4xl font-bold text-[var(--text-primary)] mb-4 leading-tight">
          {tool.name}
        </h1>

        {/* Stats row */}
        <div className="flex items-center gap-4 mb-6">
          {rating !== null && (
            <div className="flex items-center gap-1.5 text-[var(--warning)]">
              {[1,2,3,4,5].map(i => (
                <Star key={i} size={14}
                  fill={i <= Math.round(rating) ? 'currentColor' : 'none'}
                  className={i <= Math.round(rating) ? '' : 'text-[var(--border)]'} />
              ))}
              <span className="text-sm text-[var(--text-secondary)] ml-1">{rating.toFixed(1)}</span>
            </div>
          )}
          {tool.use_count > 0 && (
            <div className="flex items-center gap-1.5 text-[var(--text-muted)] text-sm">
              <Zap size={13} className="text-[var(--accent)]" />
              Кузьмич рекомендовал {tool.use_count} {tool.use_count === 1 ? 'раз' : tool.use_count < 5 ? 'раза' : 'раз'}
            </div>
          )}
        </div>

        {/* Description */}
        <p className="text-[var(--text-secondary)] text-base leading-relaxed mb-6">
          {tool.description}
        </p>

        {/* Tags */}
        {tool.tags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-8">
            {tool.tags.map(tag => (
              <span key={tag} className="text-xs px-2.5 py-1 rounded-full border border-[var(--border)] text-[var(--text-muted)]">
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row gap-3">
          <a href={tool.url} target="_blank" rel="noopener noreferrer"
            onClick={() => trackClick(tool.slug)}
            className="ds-btn ds-btn-primary flex items-center justify-center gap-2">
            Открыть инструмент <ExternalLink size={15} />
          </a>
          <Link href={kuzmichHref}
            className="ds-btn ds-btn-secondary flex items-center justify-center gap-2">
            <MessageCircle size={15} /> Спросить Кузьмича
          </Link>
        </div>
      </div>

      {/* Similar tools */}
      {similar.length > 0 && (
        <div className="border-t border-[var(--border)] pt-8">
          <h2 className="font-semibold text-[var(--text-primary)] mb-4">Похожие инструменты</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {similar.map(s => {
              const sm = CAT_META[s.category] ?? { label: s.category, icon: Layers };
              const SI = sm.icon;
              return (
                <Link key={s.slug} href={`/ai-tools/${s.slug}`}
                  className="ds-card hover:border-[var(--accent)] transition-colors">
                  <div className="flex items-center gap-1.5 mb-2">
                    <SI size={13} className="text-[var(--ocean)]" />
                    <span className="text-[10px] text-[var(--text-muted)]">{sm.label}</span>
                  </div>
                  <p className="text-sm font-semibold text-[var(--text-primary)] line-clamp-2 leading-snug">{s.name}</p>
                  {s.is_free && (
                    <span className="text-[10px] text-[var(--success)] mt-1 block">Бесплатно</span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

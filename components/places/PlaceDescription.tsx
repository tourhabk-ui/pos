'use client';

import { useState } from 'react';
import type { DescriptionSource } from '@/lib/text/description-source';

interface Props {
  name: string;
  essence: string | null;
  description: string | null;
  /** Подпись источника текста (#1830); null — подписывать нечего. */
  descriptionSource?: DescriptionSource | null;
  placeId: string;
}

export default function PlaceDescription({ essence, description, descriptionSource, placeId }: Props) {
  const [expanded, setExpanded] = useState(false);

  const paragraphs = description?.split('\n').filter(p => p.trim()) ?? [];
  const isLong = paragraphs.length > 3 || (description?.length ?? 0) > 600;

  if (!essence && paragraphs.length === 0) return null;

  return (
    <section className="max-w-3xl mx-auto px-4 pt-6 space-y-3">
      {/* Essence / lede */}
      {essence && (
        <p
          className="text-base sm:text-lg text-[var(--text-secondary)] leading-relaxed font-medium"
          style={{ maxWidth: '66ch' }}
        >
          {essence}
        </p>
      )}

      {/* Description body */}
      {paragraphs.length > 0 && (
        <div className="space-y-3">
          <div
            className={`overflow-hidden transition-all duration-300 ${isLong && !expanded ? 'max-h-44' : 'max-h-[9999px]'}`}
            style={isLong && !expanded ? {
              WebkitMaskImage: 'linear-gradient(to bottom, black 55%, transparent 100%)',
              maskImage: 'linear-gradient(to bottom, black 55%, transparent 100%)',
            } : undefined}
          >
            {paragraphs.map((p, i) => (
              <p
                key={i}
                className="text-[var(--text-secondary)] leading-relaxed"
                style={{ fontSize: '16px', lineHeight: '1.75', maxWidth: '68ch' }}
              >
                {p}
              </p>
            ))}
          </div>
          {isLong && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="text-sm text-[var(--ocean)] hover:text-[var(--accent)] font-medium transition-colors"
            >
              {expanded ? '↑ Свернуть' : '↓ Читать полностью'}
            </button>
          )}

          {/* Источник ТЕКСТА — под самим текстом, а не в подвале карточки
              (#1830, шаг 4): подпись относится к этим абзацам, и человек
              должен видеть её там, где читает. Приглушённо: это сноска, а не
              часть рассказа о месте. Без ссылки — адрес ГВП проверить не
              удалось, все три пробы вернули 403 (см. description-source.ts). */}
          {descriptionSource && (
            <p className="text-xs text-[var(--text-muted)] pt-1" style={{ maxWidth: '68ch' }}>
              {descriptionSource.label}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

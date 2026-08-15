'use client';

import React, { useMemo } from 'react';
import Link from 'next/link';
import { FISH_SPECIES, type FishSpecies } from '@/lib/fish-species';
import { linkifyText } from '@/lib/text-links';

interface TextChunk {
  text: string;
  species?: FishSpecies;
}

/**
 * Нарезка живёт в lib/text-links.ts и общая со справочником статей: два
 * матчера разошлись бы на первом же падеже, и рыба в описании подсвечивалась
 * бы иначе, чем статья в том же абзаце. Здесь остаётся только имя поля
 * `species` — оно часть API этого компонента.
 *
 * excludeId — вид текущей страницы: описание чавычи упоминает чавычу, и
 * ссылка на самого себя была бы шумом (страницы /fish/[id], владелец 07.08).
 */
export function parseTextChunks(text: string, excludeId?: string): TextChunk[] {
  return linkifyText(text, FISH_SPECIES, excludeId).map(c =>
    c.entry ? { text: c.text, species: c.entry } : { text: c.text },
  );
}

function ParagraphWithLinks({ text, excludeId }: { text: string; excludeId?: string }) {
  const chunks = useMemo(() => parseTextChunks(text, excludeId), [text, excludeId]);
  const hasFish = chunks.some(c => c.species);

  if (!hasFish) return <p>{text}</p>;

  return (
    <p>
      {chunks.map((chunk, i) =>
        chunk.species ? (
          <Link
            key={i}
            href={`/fish/${chunk.species.id}`}
            className="font-medium underline decoration-dotted underline-offset-2 transition-colors hover:no-underline"
            style={{ color: chunk.species.color, textDecorationColor: `${chunk.species.color}70` }}
            title={`${chunk.species.name} — ${chunk.species.nameLatin}`}
          >
            {chunk.text}
          </Link>
        ) : (
          <span key={i}>{chunk.text}</span>
        )
      )}
    </p>
  );
}

interface Props {
  paragraphs: string[];
  className?: string;
  style?: React.CSSProperties;
  /** Вид, на который НЕ ссылаться (текущая страница /fish/[id]). */
  excludeId?: string;
}

export default function DescriptionWithFishLinks({ paragraphs, className, style, excludeId }: Props) {
  return (
    <div className={className} style={style}>
      {paragraphs.map((p, i) => (
        <ParagraphWithLinks key={i} text={p} excludeId={excludeId} />
      ))}
    </div>
  );
}


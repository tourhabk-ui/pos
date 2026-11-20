import React from 'react';
import type { FishSpecies } from '@/lib/fish-species';
import DescriptionWithFishLinks from '@/components/shared/DescriptionWithFishLinks';

/**
 * Очерк «О виде» на странице /fish/[id] (21.11) из `FishSpecies.about`:
 * абзацы по открытым источникам и сами источники ссылками под текстом.
 * Нет очерка или у вида уже есть подробный разбор — ничего не рисуется.
 */
export function FishAbout({
  species,
}: {
  species: Pick<FishSpecies, 'id' | 'color' | 'about' | 'guide'>;
}) {
  const about = species.about;
  if (!about?.paragraphs.length || species.guide?.length) return null;
  return (
    <section aria-labelledby={`about-${species.id}`}>
      <h2
        id={`about-${species.id}`}
        className="text-2xl font-bold text-[var(--text-primary)] mb-4"
        style={{ fontFamily: 'var(--font-playfair)' }}
      >
        О виде
      </h2>
      <DescriptionWithFishLinks
        paragraphs={about.paragraphs}
        excludeId={species.id}
        className="space-y-4 text-[var(--text-secondary)] leading-relaxed"
      />
      {about.sources.length > 0 && (
        <p className="mt-4 text-xs text-[var(--text-muted)]">
          Источники:{' '}
          {about.sources.map((src, i) => (
            <React.Fragment key={src.url}>
              {i > 0 && ', '}
              <a href={src.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--accent)]">
                {src.title}
              </a>
            </React.Fragment>
          ))}
        </p>
      )}
    </section>
  );
}

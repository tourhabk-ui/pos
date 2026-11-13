import React from 'react';
import type { FishSpecies } from '@/lib/fish-species';
import DescriptionWithFishLinks from '@/components/shared/DescriptionWithFishLinks';

/**
 * Подробный разбор вида на странице /fish/[id] (12.11): разделы «О виде»,
 * «Как ловить», «Советы» из `FishSpecies.guide`. Нет разбора — ничего не
 * рисуется. Упомянутые в тексте виды — ссылками, как в описании; сам вид на
 * себя не ссылается.
 */
export function FishGuide({ species }: { species: Pick<FishSpecies, 'id' | 'color' | 'guide'> }) {
  if (!species.guide?.length) return null;
  return (
    <div className="space-y-10">
      {species.guide.map((section) => (
        <section key={section.heading} aria-labelledby={`guide-${species.id}-${section.heading}`}>
          <h2
            id={`guide-${species.id}-${section.heading}`}
            className="text-2xl font-bold text-[var(--text-primary)] mb-4"
            style={{ fontFamily: 'var(--font-playfair)' }}
          >
            {section.heading}
          </h2>
          {section.list ? (
            <ol className="space-y-3 list-decimal pl-5 marker:font-semibold" style={{ color: species.color }}>
              {section.items.map((item) => (
                <li key={item.text} className="pl-1">
                  <DescriptionWithFishLinks
                    paragraphs={[item.text]}
                    excludeId={species.id}
                    className="text-[var(--text-secondary)] leading-relaxed"
                  />
                </li>
              ))}
            </ol>
          ) : (
            <div className="space-y-5">
              {section.items.map((item) => (
                <div key={item.title ?? item.text}>
                  {item.title && (
                    <h3 className="text-base font-semibold text-[var(--text-primary)] mb-1">{item.title}</h3>
                  )}
                  <DescriptionWithFishLinks
                    paragraphs={[item.text]}
                    excludeId={species.id}
                    className="text-[var(--text-secondary)] leading-relaxed"
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

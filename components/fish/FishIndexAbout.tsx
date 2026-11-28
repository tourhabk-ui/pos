import type { ReactNode } from 'react';
import Link from 'next/link';
import FaqSection from '@/components/faq/FaqSection';
import { formatRecordDate, recordDateIso } from '@/lib/seo/record-modified';
import { FISH_SPECIES } from '@/lib/fish-species';
import { fishBaseUrl } from '@/lib/fish/fish-sources';
import {
  FISH_AUTHOR,
  FISH_FAQ,
  FISH_FAQ_HEADING,
  FISH_KICKER,
  FISH_LEAD,
  FISH_KING_SALMON_ANSWER,
  FISH_PAGE_DATE,
  FISH_PAGE_H1,
  FISH_RELATED_HEADING,
  FISH_RELATED_INTRO,
  FISH_RELATED_LINKS,
  FISH_SECTIONS,
  FISH_SOURCES,
  FISH_SOURCES_HEADING,
  FISH_TEXT_LINKS,
} from '@/lib/seo/fish-page';

function linkedText(text: string): ReactNode {
  type Marker = (typeof FISH_TEXT_LINKS)[number];
  const hits: { start: number; end: number; link: Marker }[] = [];
  for (const link of FISH_TEXT_LINKS) {
    let from = 0;
    while (from < text.length) {
      const start = text.indexOf(link.text, from);
      if (start < 0) break;
      const end = start + link.text.length;
      const overlaps = hits.some((h) => start < h.end && end > h.start);
      if (!overlaps) hits.push({ start, end, link });
      from = end;
    }
  }
  hits.sort((a, b) => a.start - b.start);
  if (hits.length === 0) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  hits.forEach((h, i) => {
    if (h.start > cursor) parts.push(text.slice(cursor, h.start));
    const label = text.slice(h.start, h.end);
    if (h.link.external) {
      parts.push(
        <a
          key={`${h.link.href}-${i}`}
          href={h.link.href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-[var(--accent)]"
        >
          {label}
        </a>,
      );
    } else {
      parts.push(
        <Link key={`${h.link.href}-${i}`} href={h.link.href} className="underline hover:text-[var(--accent)]">
          {label}
        </Link>,
      );
    }
    cursor = h.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export function FishIndexIntro() {
  const reviewed = formatRecordDate(FISH_PAGE_DATE);
  return (
    <header className="mb-10">
      <p className="text-xs font-semibold text-[var(--accent)] uppercase tracking-widest mb-2">
        {FISH_KICKER}
      </p>
      <h1
        className="ds-h1 mb-3"
        style={{ fontFamily: 'var(--font-playfair)' }}
      >
        {FISH_PAGE_H1}
      </h1>
      <p className="text-[var(--text-primary)] max-w-2xl leading-relaxed" data-lead-answer>
        {linkedText(FISH_LEAD)}
      </p>
      <p className="text-[var(--text-primary)] max-w-2xl leading-relaxed mt-3" data-king-salmon-answer>
        {linkedText(FISH_KING_SALMON_ANSWER)}
      </p>
      {reviewed && (
        <p className="text-xs text-[var(--text-muted)] mt-3" data-record-modified="">
          {FISH_AUTHOR} · факты проверены{' '}
          <time dateTime={recordDateIso(FISH_PAGE_DATE) ?? undefined}>{reviewed}</time>
        </p>
      )}
    </header>
  );
}

function SectionBlock({ id, heading, paragraphs }: (typeof FISH_SECTIONS)[number]) {
  return (
    <section id={id} className="space-y-3">
      <h2 className="ds-h2" style={{ fontFamily: 'var(--font-playfair)' }}>
        {heading}
      </h2>
      {paragraphs.map((p) => (
        <p key={p.slice(0, 48)} className="text-[var(--text-secondary)] leading-relaxed max-w-2xl">
          {linkedText(p)}
        </p>
      ))}
    </section>
  );
}

export function FishIndexFirstSection() {
  const first = FISH_SECTIONS[0];
  if (!first) return null;
  return <SectionBlock {...first} />;
}

/**
 * Остальные разделы, FAQ и «Читайте также». Сетка видов и справка о сроках
 * остаются прямыми детьми витрины, чтобы сохранить ширину и поля страницы.
 */
export default function FishIndexAbout() {
  const rest = FISH_SECTIONS.slice(1);
  return (
    <div className="space-y-10 mt-10" data-fish-about>
      {rest.map((section) => (
        <SectionBlock key={section.id} {...section} />
      ))}

      <FaqSection
        items={FISH_FAQ}
        heading={
          <h2 className="ds-h2 mb-3" style={{ fontFamily: 'var(--font-playfair)' }}>
            {FISH_FAQ_HEADING}
          </h2>
        }
      />

      <section className="space-y-3" aria-labelledby="fish-related">
        <h2 id="fish-related" className="ds-h2" style={{ fontFamily: 'var(--font-playfair)' }}>
          {FISH_RELATED_HEADING}
        </h2>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
          {FISH_RELATED_INTRO}
        </p>
        <ul className="flex flex-col gap-2 text-sm">
          {FISH_RELATED_LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="underline hover:text-[var(--accent)]">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function FishIndexSources() {
  return (
    <section className="mt-12 text-sm text-[var(--text-secondary)]" aria-labelledby="fish-sources" data-fish-sources="">
      <h2 id="fish-sources" className="ds-h3 mb-2">
        {FISH_SOURCES_HEADING}
      </h2>
      <ol className="flex flex-col gap-2">
        {FISH_SOURCES.map((s, i) => (
          <li key={s.href}>
            {i + 1}.{' '}
            <a href={s.href} target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--accent)]">
              {s.label}
            </a>
          </li>
        ))}
      </ol>
      <p className="mt-4 mb-2">Латинские названия видов — по карточкам FishBase:</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {FISH_SPECIES.map((f) => {
          const url = fishBaseUrl(f.nameLatin);
          return url ? (
            <li key={f.id}>
              <a href={url} className="underline hover:text-[var(--accent)]" rel="noopener noreferrer" target="_blank">{f.name} — <i>{f.nameLatin}</i></a>
            </li>
          ) : null;
        })}
      </ul>
    </section>
  );
}

import type { ReactNode } from 'react';
import Link from 'next/link';
import FaqSection from '@/components/faq/FaqSection';
import { formatRecordDate, recordDateIso } from '@/lib/seo/record-modified';
import {
  SAFETY_AUTHOR,
  SAFETY_FAQ,
  SAFETY_FAQ_HEADING,
  SAFETY_LEAD,
  SAFETY_LIVE_HEADING,
  SAFETY_LIVE_LEAD,
  SAFETY_PAGE_DATE,
  SAFETY_PAGE_H1,
  SAFETY_RELATED_HEADING,
  SAFETY_RELATED_INTRO,
  SAFETY_RELATED_LINKS,
  SAFETY_SECTIONS,
  SAFETY_SOURCES,
  SAFETY_SOURCES_HEADING,
  SAFETY_TEXT_LINKS,
} from '@/lib/seo/safety-page';

function linkedText(text: string): ReactNode {
  type Marker = (typeof SAFETY_TEXT_LINKS)[number];
  const hits: { start: number; end: number; link: Marker }[] = [];
  for (const link of SAFETY_TEXT_LINKS) {
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
          className="underline"
          style={{ color: 'var(--ocean)' }}
        >
          {label}
        </a>,
      );
    } else {
      parts.push(
        <Link key={`${h.link.href}-${i}`} href={h.link.href} className="underline" style={{ color: 'var(--ocean)' }}>
          {label}
        </Link>,
      );
    }
    cursor = h.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export function SafetyIntro() {
  const reviewed = formatRecordDate(SAFETY_PAGE_DATE);
  return (
    <header className="space-y-3 mb-8">
      <h1 className="font-playfair text-3xl md:text-4xl font-bold text-[var(--text-primary)]">{SAFETY_PAGE_H1}</h1>
      <p data-lead-answer className="text-[var(--text-secondary)] text-sm md:text-base leading-relaxed">
        {linkedText(SAFETY_LEAD)}
      </p>
      {reviewed && (
        <p className="text-xs text-[var(--text-muted)]" data-record-modified="">
          {SAFETY_AUTHOR} · факты проверены{' '}
          <time dateTime={recordDateIso(SAFETY_PAGE_DATE) ?? undefined}>{reviewed}</time>
        </p>
      )}
    </header>
  );
}

export default function SafetyAbout() {
  return (
    <div className="space-y-8" data-safety-about>
      {SAFETY_SECTIONS.map((section) => (
        <section key={section.id} id={section.id} className="space-y-3">
          <h2 className="ds-h2" style={{ fontFamily: 'var(--font-playfair)' }}>
            {section.heading}
          </h2>
          {section.paragraphs.map((p) => (
            <p key={p.slice(0, 48)} className="text-sm md:text-base leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              {linkedText(p)}
            </p>
          ))}
        </section>
      ))}

      <FaqSection
        items={SAFETY_FAQ}
        heading={
          <h2 className="ds-h2 mb-3" style={{ fontFamily: 'var(--font-playfair)' }}>
            {SAFETY_FAQ_HEADING}
          </h2>
        }
      />

      <section className="space-y-3" aria-labelledby="safety-related">
        <h2 id="safety-related" className="ds-h2" style={{ fontFamily: 'var(--font-playfair)' }}>
          {SAFETY_RELATED_HEADING}
        </h2>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {SAFETY_RELATED_INTRO}
        </p>
        <ul className="flex flex-col gap-2 text-sm">
          {SAFETY_RELATED_LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="underline" style={{ color: 'var(--ocean)' }}>
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3" aria-labelledby="safety-sources">
        <h2 id="safety-sources" className="ds-h2" style={{ fontFamily: 'var(--font-playfair)' }}>
          {SAFETY_SOURCES_HEADING}
        </h2>
        <ol className="flex flex-col gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {SAFETY_SOURCES.map((s, i) => (
            <li key={s.href}>
              {i + 1}.{' '}
              <a href={s.href} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--ocean)' }}>
                {s.label}
              </a>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

export function SafetyLiveIntro() {
  return (
    <section className="space-y-3 mb-4" aria-labelledby="radar">
      <h2 id="radar" className="ds-h2" style={{ fontFamily: 'var(--font-playfair)' }}>
        {SAFETY_LIVE_HEADING}
      </h2>
      <p className="text-sm md:text-base leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {linkedText(SAFETY_LIVE_LEAD)}
      </p>
    </section>
  );
}

import type { ReactNode } from 'react';
import Link from 'next/link';
import FaqSection from '@/components/faq/FaqSection';
import {
  KUZMICH_ABOUT_LINK_TEXT,
  KUZMICH_ABOUT_PATH,
  KUZMICH_FAQ,
  KUZMICH_FAQ_HEADING,
  KUZMICH_LEAD,
  KUZMICH_PAGE_H1,
  KUZMICH_RELATED_HEADING,
  KUZMICH_RELATED_INTRO,
  KUZMICH_RELATED_LINKS,
  KUZMICH_SECTIONS,
  KUZMICH_TEXT_LINKS,
} from '@/lib/seo/kuzmich-page';

function linkedText(text: string): ReactNode {
  type Marker = (typeof KUZMICH_TEXT_LINKS)[number];
  const hits: { start: number; end: number; link: Marker }[] = [];
  for (const link of KUZMICH_TEXT_LINKS) {
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

export function KuzmichIntro({ title = KUZMICH_PAGE_H1, aboutLink = false }: { title?: string; aboutLink?: boolean }) {
  return (
    <header className="space-y-3 mb-8">
      <h1 className="font-playfair text-3xl md:text-4xl font-bold text-[var(--text-primary)]">{title}</h1>
      <p data-lead-answer className="text-[var(--text-secondary)] text-sm md:text-base leading-relaxed">
        {linkedText(KUZMICH_LEAD)}
      </p>
      {/* На чате ссылка «О Кузьмиче» — здесь, над чатом: под чатом ничего
          нет, в чатах подвалов нет (слово владельца 28.11). */}
      {aboutLink && (
        <p className="text-sm" data-kuzmich-about-link>
          <Link href={KUZMICH_ABOUT_PATH} className="underline" style={{ color: 'var(--ocean)' }}>
            {KUZMICH_ABOUT_LINK_TEXT}
          </Link>
        </p>
      )}
    </header>
  );
}

export default function KuzmichAbout() {
  return (
    <div className="mt-10 space-y-8" data-kuzmich-about>
      {KUZMICH_SECTIONS.map((section) => (
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
        items={KUZMICH_FAQ}
        heading={
          <h2 className="ds-h2 mb-3" style={{ fontFamily: 'var(--font-playfair)' }}>
            {KUZMICH_FAQ_HEADING}
          </h2>
        }
      />

      <section className="space-y-3" aria-labelledby="kuzmich-related">
        <h2 id="kuzmich-related" className="ds-h2" style={{ fontFamily: 'var(--font-playfair)' }}>
          {KUZMICH_RELATED_HEADING}
        </h2>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {KUZMICH_RELATED_INTRO}
        </p>
        <ul className="flex flex-col gap-2 text-sm">
          {KUZMICH_RELATED_LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="underline" style={{ color: 'var(--ocean)' }}>
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

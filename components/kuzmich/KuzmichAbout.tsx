import type { ReactNode } from 'react';
import Link from 'next/link';
import FaqSection from '@/components/faq/FaqSection';
import { KUZMICH_MAX_URL, KUZMICH_TELEGRAM_URL } from '@/components/shared/KuzmichActions';
import { MaxIcon, TelegramIcon } from '@/components/shared/MessengerIcons';
import {
  KUZMICH_ABOUT_PATH,
  KUZMICH_FAQ,
  KUZMICH_FAQ_HEADING,
  KUZMICH_LEAD,
  KUZMICH_LEAD_SHORT,
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

/**
 * Над чатом — только заголовок, лид в одну строку и знаки ботов (слово
 * владельца 28.11: «Я еле нашёл строку ввода»). Поле ввода должно быть видно
 * без прокрутки и на телефоне 390 px. Полное описание — на странице
 * «О Кузьмиче» (/o-kuzmiche), «Подробнее» ведёт туда.
 */
export function KuzmichIntro() {
  return (
    <header className="space-y-2 mb-3">
      <h1 className="font-playfair text-xl leading-tight sm:text-2xl md:text-3xl font-bold text-[var(--text-primary)]">{KUZMICH_PAGE_H1}</h1>
      <div className="flex flex-col gap-1 sm:flex-row-reverse sm:items-center sm:justify-between sm:gap-4">
        <div className="flex items-center gap-1 -ml-2.5 sm:ml-0 sm:-mr-2.5 shrink-0">
          <a
            href={KUZMICH_TELEGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Telegram"
            title="Telegram"
            data-kuzmich-action="telegram"
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px]"
          >
            <TelegramIcon size={22} />
          </a>
          <a
            href={KUZMICH_MAX_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="MAX"
            title="MAX"
            data-kuzmich-action="max"
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px]"
          >
            <MaxIcon size={22} />
          </a>
        </div>
        <p data-lead-answer className="text-[var(--text-secondary)] text-sm md:text-base leading-relaxed">
          {KUZMICH_LEAD_SHORT}{' '}
          <Link href={KUZMICH_ABOUT_PATH} className="underline" style={{ color: 'var(--ocean)' }} data-kuzmich-about-link>Подробнее</Link>
        </p>
      </div>
    </header>
  );
}

export default function KuzmichAbout() {
  return (
    <div className="mt-12 space-y-8" data-kuzmich-about>
      <section id="o-kuzmiche">
        <p className="text-sm md:text-base leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {linkedText(KUZMICH_LEAD)}
        </p>
      </section>
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

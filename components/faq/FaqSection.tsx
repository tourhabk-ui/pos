/**
 * Блок «Вопросы и ответы» на карточке (слово владельца 17.11 «2 да но
 * аккуратно»). Видимые вопросы и разметка FAQPage — из одного массива: в
 * разметке нет ничего, чего человек не видит на странице. Вопросов нет —
 * блока и разметки нет.
 *
 * Ответы собирает модуль своей сущности (`lib/tours/tour-faq`,
 * `lib/places/place-faq`), а не этот компонент: он только рисует.
 */
import React from 'react';
import { FAQJsonLd } from '@/components/seo/JsonLd';
import type { FaqItem } from '@/lib/seo/faq';

export default function FaqSection({ items, heading }: { items: readonly FaqItem[]; heading: React.ReactNode }) {
  if (items.length === 0) return null;
  return (
    <section data-testid="faq-section">
      {heading}
      <dl className="ds-card p-5 divide-y divide-[var(--border)]">
        {items.map((it) => (
          <div key={it.question} className="py-3 first:pt-0 last:pb-0">
            <dt className="font-semibold text-[var(--text-primary)]">{it.question}</dt>
            <dd className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{it.answer}</dd>
          </div>
        ))}
      </dl>
      <FAQJsonLd questions={items.map(({ question, answer }) => ({ question, answer }))} />
    </section>
  );
}

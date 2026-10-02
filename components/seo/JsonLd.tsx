import React from 'react';

/**
 * Универсальная обёртка JSON-LD с экранированием «<» (<): содержимое
 * script-тега нельзя доверять строке из БД — незакрытый тег в описании тура
 * разорвал бы разметку страницы (XSS-вектор). Новые страницы используют её,
 * а не голый JSON.stringify.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}

// OrganizationJsonLd и TourJsonLd сняты 01.10: их не звал никто, а второй по
// умолчанию объявлял туру InStock — тот самый ответ без данных, который
// убран из разметки карточки (lib/tours/open-dates).

interface BreadcrumbJsonLdProps {
  items: Array<{
    name: string;
    url: string;
  }>;
}

export function BreadcrumbJsonLd({ items }: BreadcrumbJsonLdProps) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, itemIdx) => ({
      '@type': 'ListItem',
      position: itemIdx + 1,
      name: item.name,
      item: item.url,
    })),
  };

  // То же экранирование «<», что у JsonLd: имена мест приходят из БД.
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
    />
  );
}

interface FAQJsonLdProps {
  questions: Array<{
    question: string;
    answer: string;
  }>;
}

export function FAQJsonLd({ questions }: FAQJsonLdProps) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: questions.map((q) => ({
      '@type': 'Question',
      name: q.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: q.answer,
      },
    })),
  };

  // То же экранирование «<», что у JsonLd: имена мест приходят из БД.
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
    />
  );
}

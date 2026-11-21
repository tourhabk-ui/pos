/**
 * Разметка переписанной статьи: Article + FAQPage (миграция 1471).
 *
 * Только для статей с признаком «переписана» (`rewritten_at`): копии чужого
 * текста Article не получают. Даты — только из записи: datePublished —
 * когда текст переписан (rewritten_at), dateModified — последняя правка
 * записи (updated_at); поля нет — свойства нет, «сегодня» не ставится.
 * FAQPage — из раздела «Частые вопросы» самого текста; вопросов нет — узла нет.
 */
import { recordDateIso } from '@/lib/seo/record-modified';
import { DEFAULT_OG_IMAGE } from '@/lib/seo/og-image';

export interface ArticleJsonLdInput {
  url: string;
  site: string;
  headline: string;
  description: string | null;
  datePublished: string | null;
  dateModified: string | null;
  faq: Array<{ q: string; a: string }>;
  /** Свой кадр страницы (путь сайта или абсолютный адрес); нет — картинка по умолчанию. */
  image?: string | null;
}

export function articleJsonLd(input: ArticleJsonLdInput): Record<string, unknown> {
  const published = recordDateIso(input.datePublished);
  const modified = recordDateIso(input.dateModified);
  // Тот же узел, что у организации в layout (@id, seomator 20.11).
  const org = { '@type': 'Organization', '@id': `${input.site}/#organization`, name: 'Ведар Камчатка', url: input.site };
  const article: Record<string, unknown> = {
    '@type': 'Article',
    '@id': `${input.url}#article`,
    headline: input.headline.length > 110 ? `${input.headline.slice(0, 109).trimEnd()}…` : input.headline,
    ...(input.description ? { description: input.description } : {}),
    inLanguage: 'ru',
    mainEntityOfPage: { '@type': 'WebPage', '@id': input.url },
    url: input.url,
    image: input.image ? (input.image.startsWith('/') ? `${input.site}${input.image}` : input.image) : `${input.site}${DEFAULT_OG_IMAGE}`,
    author: org,
    publisher: org,
    ...(published ? { datePublished: published } : {}),
    ...(modified ? { dateModified: modified } : {}),
  };
  const graph: Record<string, unknown>[] = [article];
  if (input.faq.length > 0) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${input.url}#faq`,
      mainEntity: input.faq.map(({ q, a }) => ({
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a },
      })),
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

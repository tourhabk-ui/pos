/**
 * Русский и английский варианты правовых документов (17.11).
 *
 * Английские страницы — перевод русского оригинала, а не отдельные
 * документы: юридически действует русский текст на /legal/*. Здесь одна
 * таблица путей, из которой берутся и hreflang-пары в metadata, и ссылки
 * переключателя языка, и записи sitemap — чтобы им нечем было разойтись.
 */
export type LegalDoc = 'privacy' | 'terms';
export type LegalLang = 'ru' | 'en';

export const LEGAL_DOC_PATHS: Record<LegalDoc, Record<LegalLang, string>> = {
  privacy: { ru: '/legal/privacy', en: '/en/legal/privacy' },
  terms: { ru: '/legal/terms', en: '/en/legal/terms' },
};

/** `alternates` для metadata: свой canonical и пара ru/en (+ x-default — русский оригинал). */
export function legalAlternates(doc: LegalDoc, lang: LegalLang) {
  const p = LEGAL_DOC_PATHS[doc];
  return {
    canonical: p[lang],
    languages: { ru: p.ru, en: p.en, 'x-default': p.ru },
  };
}

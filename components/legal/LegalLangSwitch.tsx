import Link from 'next/link';
import { LEGAL_DOC_PATHS, type LegalDoc, type LegalLang } from '@/lib/legal/legal-i18n';

/**
 * Видимый переключатель RU / EN у правового документа. Текущий язык — не
 * ссылка, а отмеченный текст (aria-current), второй — ссылка с hrefLang.
 */
export default function LegalLangSwitch({ doc, current }: { doc: LegalDoc; current: LegalLang }) {
  const items: { lang: LegalLang; label: string; title: string }[] = [
    { lang: 'ru', label: 'RU', title: 'Русская версия (оригинал)' },
    { lang: 'en', label: 'EN', title: 'English version (translation)' },
  ];
  return (
    <nav
      aria-label={current === 'en' ? 'Document language' : 'Язык документа'}
      className="flex items-center gap-2 text-sm mb-6"
      data-testid="legal-lang-switch"
    >
      {items.map((it, i) => (
        <span key={it.lang} className="flex items-center gap-2">
          {i > 0 && <span className="text-[var(--text-muted)]" aria-hidden="true">|</span>}
          {it.lang === current ? (
            <span aria-current="page" lang={it.lang} className="font-semibold text-[var(--text-primary)]">
              {it.label}
            </span>
          ) : (
            <Link
              href={LEGAL_DOC_PATHS[doc][it.lang]}
              hrefLang={it.lang}
              lang={it.lang}
              title={it.title}
              className="text-[var(--ocean)] hover:underline"
            >
              {it.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * Китайская посадочная Сыщика: прямой ответ, H2-вопросы, FAQ, источники,
 * Кузьмич. Разметка Article + FAQPage + BreadcrumbList. SSR, без цен.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { JsonLd } from '@/components/seo/JsonLd';
import { pageContainer } from '@/lib/layout/page-width';
import {
  formatZhGuideDate,
  KUZMICH_TG,
  ZH_GUIDE_AUTHOR,
  zhGuideArticleJsonLd,
  zhGuideBreadcrumbJsonLd,
  type ZhGuide,
} from '@/lib/zh/guides';

function ExternalOrInternal({ href, children }: { href: string; children: ReactNode }) {
  const internal = href.startsWith('/');
  if (internal) {
    return <Link className="underline" style={{ color: 'var(--ocean)' }} href={href}>{children}</Link>;
  }
  return (
    <a className="underline break-all" style={{ color: 'var(--ocean)' }} href={href} rel="noopener noreferrer" target="_blank">
      {children}
    </a>
  );
}

export function ZhKuzmich() {
  return (
    <aside className="ds-card p-4 text-sm space-y-2" aria-labelledby="zh-guide-kuzmich" data-zh-kuzmich="">
      <h2 id="zh-guide-kuzmich" className="ds-h2">向库兹米奇（Кузьмич）提问</h2>
      <p style={{ color: 'var(--text-primary)' }}>
        库兹米奇是 Vedar 的人工智能助手。可以询问季节、道路和随身物品：他按平台已核实的资料回答，不知道的会直接说不知道。
      </p>
      <a className="underline" style={{ color: 'var(--ocean)' }} href={KUZMICH_TG} rel="noopener noreferrer" target="_blank">
        在 Telegram 给 @kuzmichai_bot 留言
      </a>
    </aside>
  );
}

export function ZhGuideView({ guide }: { guide: ZhGuide }) {
  return (
    <article className={`${pageContainer('reading')} py-8 space-y-8`} data-zh-guide={guide.slug} lang="zh-CN">
      <JsonLd data={zhGuideBreadcrumbJsonLd(guide)} />
      <JsonLd data={zhGuideArticleJsonLd(guide)} />
      <header className="space-y-3">
        <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>
          {guide.h1}
        </h1>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }} data-record-modified="">
          {ZH_GUIDE_AUTHOR} · 事实核对于 <time dateTime={guide.date}>{formatZhGuideDate(guide.date)}</time>
        </p>
        <p className="ds-card p-4 text-sm" style={{ color: 'var(--text-primary)' }} data-zh-guide-lead="">
          <strong>简要。</strong> {guide.lead}
        </p>
      </header>

      {guide.live && (
        <section className="ds-card p-4 space-y-2" aria-labelledby="zh-guide-live" data-zh-guide-live="">
          <h2 id="zh-guide-live" className="ds-h2">{guide.live.heading}</h2>
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{guide.live.text}</p>
          <p>
            <Link className="underline font-semibold" style={{ color: 'var(--ocean)' }} href={guide.live.href}>
              {guide.live.cta}
            </Link>
          </p>
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{guide.live.note}</p>
        </section>
      )}

      {guide.sections.map((section) => (
        <section key={section.id} className="space-y-3" aria-labelledby={section.id} data-zh-guide-section={section.id}>
          <h2 id={section.id} className="ds-h2">{section.heading}</h2>
          {section.paragraphs.map((para, i) => (
            <p key={`${section.id}-p-${i}`} className="text-sm" style={{ color: 'var(--text-primary)' }}>{para}</p>
          ))}
          {section.bullets && section.bullets.length > 0 && (
            <ul className="list-disc pl-5 text-sm space-y-1" style={{ color: 'var(--text-primary)' }}>
              {section.bullets.map((item) => <li key={item}>{item}</li>)}
            </ul>
          )}
          {section.links && section.links.length > 0 && (
            <ul className="text-sm space-y-1">
              {section.links.map((l) => (
                <li key={l.href ?? l.label}>
                  {l.href ? <ExternalOrInternal href={l.href}>{l.label}</ExternalOrInternal> : l.label}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <section className="space-y-3" aria-labelledby="zh-guide-faq" data-zh-guide-faq="">
        <h2 id="zh-guide-faq" className="ds-h2">{guide.faqHeading}</h2>
        {guide.faq.map((item) => (
          <details key={item.question} className="ds-card p-4 text-sm">
            <summary className="font-semibold cursor-pointer" style={{ color: 'var(--text-primary)' }}>{item.question}</summary>
            <p className="mt-2" style={{ color: 'var(--text-primary)' }}>{item.answer}</p>
          </details>
        ))}
      </section>

      <ZhKuzmich />

      <nav className="space-y-2 text-sm" aria-labelledby="zh-guide-related">
        <h2 id="zh-guide-related" className="ds-h2">{guide.relatedHeading}</h2>
        <ul className="space-y-1">
          {guide.related.map((l) => (
            <li key={l.href ?? l.label}>
              {l.href ? <ExternalOrInternal href={l.href}>{l.label}</ExternalOrInternal> : l.label}
            </li>
          ))}
        </ul>
      </nav>

      <section className="space-y-2" aria-labelledby="zh-guide-sources" data-zh-guide-sources="">
        <h2 id="zh-guide-sources" className="ds-h2">{guide.sourcesHeading}</h2>
        <ul className="ds-card p-4 text-sm space-y-2" style={{ color: 'var(--text-primary)' }}>
          {guide.sources.map((s) => (
            <li key={s.href ?? s.label}>
              {s.href ? (
                <a className="underline break-all" style={{ color: 'var(--ocean)' }} href={s.href} rel="noopener noreferrer">
                  {s.label}
                </a>
              ) : s.label}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}

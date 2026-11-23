import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { JOIN_COMMON, ROLE_ENTRY_LINKS, joinRegisterHref, type JoinPageContent } from '@/lib/partners/join-pages';

/**
 * Страница-вход для роли партнёра: гид, хозяин жилья, перевозчик.
 * Серверный компонент без базы: тексты — из lib/partners/join-pages.
 */
export function RoleJoinPage({ page }: { page: JoinPageContent }) {
  const others = ROLE_ENTRY_LINKS.filter((l) => l.href !== page.path);
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh]">
      <Header />
      <main className="pt-16">
        <section className="max-w-5xl mx-auto px-4 pt-16 pb-12">
          <p className="ds-label text-[var(--accent)] mb-4">{page.eyebrow}</p>
          <h1 className="ds-h1 text-4xl md:text-5xl mb-5 max-w-3xl">{page.title}</h1>
          <p className="text-lg text-[var(--text-secondary)] max-w-2xl mb-8">{page.lead}</p>
          <div className="flex flex-col sm:flex-row gap-4 items-start">
            <Link href={joinRegisterHref(page.role)} className="ds-btn-primary flex items-center gap-2">
              Зарегистрироваться
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link href="/legal/offer" className="ds-btn ds-btn-secondary">Оферта для партнёров</Link>
          </div>
          <p className="text-sm text-[var(--text-muted)] mt-6 max-w-2xl">{JOIN_COMMON.status}</p>
        </section>

        <section className="max-w-5xl mx-auto px-4 pb-12 grid md:grid-cols-5 gap-8">
          <div className="md:col-span-3 ds-card p-6 md:p-8">
            <h2 className="ds-h2 mb-5">Что делает Ведар</h2>
            <ul className="space-y-4">
              {page.does.map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <Check className="w-5 h-5 text-[var(--success)] flex-shrink-0 mt-0.5" />
                  <span className="text-[var(--text-secondary)]">{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="md:col-span-2 ds-card p-6 md:p-8">
            <h2 className="ds-h2 mb-5">Что важно знать</h2>
            <ul className="space-y-4 text-sm text-[var(--text-secondary)]">
              {page.notes.map((item) => <li key={item}>{item}</li>)}
              <li>{JOIN_COMMON.offerNote}</li>
            </ul>
          </div>
        </section>

        <section className="max-w-5xl mx-auto px-4 pb-12">
          <h2 className="ds-h2 mb-6">Как подключиться</h2>
          <ol className="grid md:grid-cols-2 gap-4">
            {JOIN_COMMON.steps.map((step, i) => (
              <li key={step} className="ds-card p-5 flex items-start gap-4">
                <span className="text-2xl font-bold text-[var(--accent)] leading-none w-8 flex-shrink-0">{i + 1}</span>
                <span className="text-sm text-[var(--text-secondary)]">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        <RoleEntryLinks links={others} />
      </main>
    </div>
  );
}

/** Ссылки на входы других ролей — и на страницах ролей, и у туроператора. */
export function RoleEntryLinks({
  links = ROLE_ENTRY_LINKS,
  title = 'Другим партнёрам',
}: { links?: ReadonlyArray<{ href: string; label: string }>; title?: string }) {
  return (
    <section className="max-w-5xl mx-auto px-4 pb-20">
      <h2 className="ds-label mb-3">{title}</h2>
      <ul className="flex flex-wrap gap-3">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="ds-btn ds-btn-secondary">{l.label}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

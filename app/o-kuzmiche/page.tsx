/**
 * «О Кузьмиче»: что он умеет, как с ним говорить, данные для ИИ-агентов и чего
 * он не делает. Слово владельца 28.11: «убрать с чата описание что умеет
 * кузьмич» → «перенести на отдельную». Текст — lib/seo/kuzmich-page.ts
 * (Сыщик, 22.11), тот же, что стоял под чатом.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import KuzmichAbout, { KuzmichIntro } from '@/components/kuzmich/KuzmichAbout';
import { defaultOgImages } from '@/lib/seo/og-image';
import {
  KUZMICH_ABOUT_DESCRIPTION,
  KUZMICH_ABOUT_H1,
  KUZMICH_ABOUT_PATH,
  KUZMICH_ABOUT_TITLE,
  KUZMICH_CHAT_LINK_TEXT,
} from '@/lib/seo/kuzmich-page';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: KUZMICH_ABOUT_TITLE,
  description: KUZMICH_ABOUT_DESCRIPTION,
  robots: 'index, follow',
  alternates: { canonical: KUZMICH_ABOUT_PATH },
  openGraph: {
    images: defaultOgImages(),
    title: KUZMICH_ABOUT_TITLE,
    description: KUZMICH_ABOUT_DESCRIPTION,
    url: `${SITE}${KUZMICH_ABOUT_PATH}`,
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
};

export default function KuzmichAboutPage() {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <main className="flex-1 max-w-3xl w-full mx-auto px-4 pb-12 pt-20">
        <KuzmichIntro title={KUZMICH_ABOUT_H1} />
        <Link href="/kuzmich" className="ds-btn ds-btn-primary">
          {KUZMICH_CHAT_LINK_TEXT}
        </Link>
        <KuzmichAbout />
      </main>
    </div>
  );
}

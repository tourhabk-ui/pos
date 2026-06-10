import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Calendar, Tag } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { pool } from '@/lib/db-pool';
import { STATIC_ARTICLES } from '@/app/blog/page';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ slug: string }>;
}

interface DigestEntry {
  slug: string;
  title: string;
  compiled_truth: string;
  created_at: string;
}

async function getDigest(slug: string): Promise<DigestEntry | null> {
  try {
    const { rows } = await pool.query<DigestEntry>(
      `SELECT slug, title, compiled_truth, created_at::text
       FROM agent_knowledge
       WHERE slug = $1
       LIMIT 1`,
      [slug],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function renderMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\n/g, '</p><p class="mb-4">')
    .replace(/\n—/g, '<br/>—');
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const article = STATIC_ARTICLES.find(a => a.slug === slug);
  if (article) {
    return {
      title: `${article.title} — Блог TourHab`,
      description: article.excerpt,
      alternates: { canonical: `${SITE}/blog/${slug}` },
    };
  }
  return { title: 'Блог TourHab' };
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;

  const staticArticle = STATIC_ARTICLES.find(a => a.slug === slug);

  if (staticArticle) {
    return (
      <>
        <Header />
        <main className="bg-[var(--bg-primary)] min-h-screen">
          <article className="max-w-2xl mx-auto px-6 py-16">
            <Link
              href="/blog"
              className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors mb-10"
            >
              <ArrowLeft className="w-4 h-4" />
              Все материалы
            </Link>

            <div className="flex items-center gap-3 mb-6">
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--accent)] bg-[var(--bg-hover)] px-2 py-0.5 rounded">
                <Tag className="w-3 h-3" />
                {staticArticle.tag}
              </span>
              <time className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)]">
                <Calendar className="w-3 h-3" />
                {formatDate(staticArticle.date)}
              </time>
            </div>

            <h1
              className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] leading-tight mb-8"
              style={{ fontFamily: 'var(--font-playfair)' }}
            >
              {staticArticle.title}
            </h1>

            <div
              className="prose-content text-[var(--text-secondary)] leading-relaxed space-y-4"
              dangerouslySetInnerHTML={{
                __html: `<p class="mb-4">${renderMarkdown(staticArticle.content)}</p>`,
              }}
            />

            <div className="mt-12 pt-8 border-t border-[var(--border)] flex gap-4">
              <Link href="/routes" className="ds-btn ds-btn-primary">
                Маршруты Камчатки
              </Link>
              <Link href="/hub/safety" className="ds-btn ds-btn-secondary">
                Безопасность
              </Link>
            </div>
          </article>
        </main>
        <Footer />
      </>
    );
  }

  // Dynamic digest from agent_knowledge
  const digest = await getDigest(slug);
  if (!digest) notFound();

  return (
    <>
      <Header />
      <main className="bg-[var(--bg-primary)] min-h-screen">
        <article className="max-w-2xl mx-auto px-6 py-16">
          <Link
            href="/blog"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors mb-10"
          >
            <ArrowLeft className="w-4 h-4" />
            Все материалы
          </Link>

          <div className="flex items-center gap-3 mb-6">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] bg-[var(--bg-hover)] px-2 py-0.5 rounded">
              Разведдайджест
            </span>
            <time className="text-xs text-[var(--text-muted)]">
              {formatDate(digest.created_at)}
            </time>
          </div>

          <h1
            className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] leading-tight mb-8"
            style={{ fontFamily: 'var(--font-playfair)' }}
          >
            {digest.title}
          </h1>

          <div className="text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap">
            {digest.compiled_truth}
          </div>

          <div className="mt-12 pt-8 border-t border-[var(--border)]">
            <Link href="/blog" className="ds-btn ds-btn-secondary">
              Все материалы
            </Link>
          </div>
        </article>
      </main>
      <Footer />
    </>
  );
}

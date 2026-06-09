import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { pool } from '@/lib/db-pool';
import { ToolDetailClient } from './_ToolDetailClient';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';

interface Props { params: Promise<{ slug: string }> }

interface ToolRow {
  slug: string; name: string; description: string; url: string;
  category: string; tags: string[]; is_free: boolean; api_available: boolean;
  rating: string | null; use_count: number; click_count: number; created_at: string;
}

interface SimilarRow {
  slug: string; name: string; category: string;
  is_free: boolean; api_available: boolean; rating: string | null; use_count: number;
}

async function getTool(slug: string) {
  const [toolRes, similarRes] = await Promise.all([
    pool.query<ToolRow>(
      `SELECT slug, name, description, url, category, tags, is_free, api_available,
              rating, use_count, click_count, created_at
       FROM external_tools WHERE slug = $1 AND verified = TRUE`,
      [slug]
    ),
    pool.query<SimilarRow>(
      `SELECT slug, name, category, is_free, api_available, rating, use_count
       FROM external_tools et
       WHERE et.category = (SELECT category FROM external_tools WHERE slug = $1)
         AND et.slug != $1 AND et.verified = TRUE
       ORDER BY use_count DESC LIMIT 4`,
      [slug]
    ),
  ]);

  if (toolRes.rows.length === 0) return null;
  return { tool: toolRes.rows[0], similar: similarRes.rows };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const data = await getTool(slug);
  if (!data) return { title: 'Инструмент не найден' };
  return {
    title: `${data.tool.name} — AI-арсенал Камчатки`,
    description: data.tool.description.slice(0, 160),
    alternates: { canonical: `/ai-tools/${slug}` },
  };
}

export default async function ToolPage({ params }: Props) {
  const { slug } = await params;
  const data = await getTool(slug);
  if (!data) notFound();

  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <main className="flex-1 pt-[56px]">
        <ToolDetailClient tool={data.tool} similar={data.similar} />
      </main>
      <Footer />
    </div>
  );
}

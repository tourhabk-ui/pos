import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, Calendar, MapPin, Users, ArrowLeft, CheckCircle, ExternalLink, ShieldAlert, BookOpen } from 'lucide-react';
import { pool } from '@/lib/db-pool';
import { Header } from '@/components/layout/Header';

interface IncidentRow {
  id: number;
  slug: string;
  incident_date: string;
  title: string;
  location_name: string;
  location_type: string;
  casualties: number;
  injured: number;
  description: string;
  cause: string;
  lessons: string[];
  mchs_involved: boolean;
  source_url: string | null;
}

interface Props {
  params: Promise<{ slug: string }>;
}

const TYPE_LABELS: Record<string, string> = {
  volcano: 'Вулкан',
  river:   'Река',
  trail:   'Маршрут',
  sea:     'Море',
  glacier: 'Ледник',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const { rows } = await pool.query<Pick<IncidentRow, 'title' | 'location_name' | 'casualties'>>(
    `SELECT title, location_name, casualties FROM tourist_incidents WHERE slug = $1 LIMIT 1`,
    [slug]
  );
  if (!rows[0]) return { title: 'Инцидент не найден | Ведар' };
  const r = rows[0];
  return {
    title: `${r.title} | Трагедии Камчатки | Ведар`,
    description: `${r.casualties} ${r.casualties === 1 ? 'погиб' : 'погибло'} на ${r.location_name}. Разбор причин и уроков безопасности.`,
  };
}

export const dynamic = 'force-dynamic';

export default async function IncidentPage({ params }: Props) {
  const { slug } = await params;

  const { rows } = await pool.query<IncidentRow>(
    `SELECT id, slug, incident_date, title, location_name, location_type,
            casualties, injured, description, cause, lessons, mchs_involved, source_url
     FROM tourist_incidents
     WHERE slug = $1
     LIMIT 1`,
    [slug]
  );

  const incident = rows[0];
  if (!incident) notFound();

  return (
    <>
      <Header />
      <main className="ds-page pt-20 pb-16">

        {/* Back */}
        <Link
          href="/safety/incidents"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] mb-8 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Все случаи
        </Link>

        <div className="max-w-2xl">

          {/* Header */}
          <div className="flex items-center gap-2 mb-4">
            <ShieldAlert className="w-4 h-4 text-[var(--danger)]" />
            <span className="text-xs tracking-widest uppercase text-[var(--text-muted)]">
              {TYPE_LABELS[incident.location_type] ?? incident.location_type}
            </span>
          </div>

          <h1 className="font-playfair text-2xl md:text-3xl font-bold text-[var(--text-primary)] leading-tight mb-5">
            {incident.title}
          </h1>

          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-[var(--text-muted)] mb-7 pb-7 border-b border-[var(--border)]">
            <span className="flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" />
              {formatDate(incident.incident_date)}
            </span>
            <span className="flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5" />
              {incident.location_name}
            </span>
            <span className="flex items-center gap-1.5 text-[var(--danger)] font-medium">
              <Users className="w-3.5 h-3.5" />
              {incident.casualties} {incident.casualties === 1 ? 'погиб' : 'погибло'}
            </span>
            {incident.injured > 0 && (
              <span className="text-[var(--warning)] font-medium">
                {incident.injured} {incident.injured === 1 ? 'пострадал' : 'пострадало'}
              </span>
            )}
          </div>

          {/* Description */}
          <section className="mb-8">
            <div className="flex items-center gap-2 mb-3">
              <BookOpen className="w-4 h-4 text-[var(--text-muted)]" />
              <h2 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">Что произошло</h2>
            </div>
            <p className="text-[var(--text-primary)] leading-relaxed text-[0.9375rem]">
              {incident.description}
            </p>
          </section>

          {/* Cause */}
          <section className="mb-8 p-5 rounded-lg border border-[var(--danger)]/20 bg-[var(--danger)]/5">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-[var(--danger)]" />
              <h2 className="text-xs font-semibold uppercase tracking-widest text-[var(--danger)]">Причины трагедии</h2>
            </div>
            <p className="text-[var(--text-primary)] leading-relaxed text-[0.9375rem]">
              {incident.cause}
            </p>
          </section>

          {/* Lessons */}
          <section className="mb-8">
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle className="w-4 h-4 text-[var(--success)]" />
              <h2 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">Уроки безопасности</h2>
            </div>
            <ul className="space-y-3">
              {incident.lessons.map((lesson, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[var(--success)]/15 text-[var(--success)] text-[10px] font-bold flex items-center justify-center mt-0.5">
                    {i + 1}
                  </span>
                  <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{lesson}</p>
                </li>
              ))}
            </ul>
          </section>

          {/* MChS + source */}
          <div className="flex flex-wrap gap-3 pt-6 border-t border-[var(--border)]">
            {incident.mchs_involved && (
              <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] border border-[var(--border)] rounded-full px-3 py-1.5">
                <ShieldAlert className="w-3 h-3" />
                МЧС участвовало в операции
              </span>
            )}
            {incident.source_url && (
              <a
                href={incident.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-[var(--ocean)] hover:underline border border-[var(--border)] rounded-full px-3 py-1.5"
              >
                <ExternalLink className="w-3 h-3" />
                Источник
              </a>
            )}
          </div>

          {/* CTA */}
          <div className="mt-8 p-5 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
            <p className="text-sm font-semibold text-[var(--text-primary)] mb-1">Готовитесь к маршруту на Камчатке?</p>
            <p className="text-sm text-[var(--text-muted)] mb-3">
              Кузьмич знает актуальное состояние вулканов, закрытые зоны и реальные риски на маршрутах.
            </p>
            <Link
              href="/ai-assistant"
              className="inline-flex items-center gap-2 text-sm font-medium text-[var(--ocean)] hover:underline"
            >
              Спросить Кузьмича о безопасности
              <ArrowLeft className="w-3.5 h-3.5 rotate-180" />
            </Link>
          </div>

        </div>
      </main>
    </>
  );
}

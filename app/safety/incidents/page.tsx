import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, Calendar, MapPin, Users, ChevronRight, ShieldAlert } from 'lucide-react';
import { pool } from '@/lib/db-pool';
import { Header } from '@/components/layout/Header';

export const metadata: Metadata = {
  title: 'Трагедии на маршрутах Камчатки | Ведар',
  description: 'Задокументированные случаи гибели туристов на Камчатке. Изучайте реальные риски, причины и уроки — чтобы не повторять чужих ошибок.',
};

export const dynamic = 'force-dynamic';

interface IncidentRow {
  id: number;
  slug: string;
  incident_date: string;
  title: string;
  location_name: string;
  location_type: string;
  casualties: number;
  injured: number;
  cause: string;
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

export default async function IncidentsPage() {
  const { rows } = await pool.query<IncidentRow>(
    `SELECT id, slug, incident_date, title, location_name, location_type,
            casualties, injured, cause
     FROM tourist_incidents
     ORDER BY incident_date DESC`
  );

  const totalDeaths = rows.reduce((s, r) => s + r.casualties, 0);

  return (
    <>
      <Header />
      <main className="ds-page pt-20 pb-16">

        {/* Hero */}
        <div className="mb-10 max-w-2xl">
          <div className="flex items-center gap-2 mb-4">
            <ShieldAlert className="w-4 h-4 text-[var(--danger)]" />
            <span className="text-xs tracking-widest uppercase text-[var(--text-muted)]">Безопасность</span>
          </div>
          <h1 className="font-playfair text-3xl md:text-4xl font-bold text-[var(--text-primary)] leading-tight mb-4">
            Трагедии на маршрутах<br />
            <span className="text-[var(--danger)]">Камчатки</span>
          </h1>
          <p className="text-[var(--text-secondary)] text-base leading-relaxed">
            Мы публикуем эти случаи не ради сенсации — а чтобы туристы знали
            реальную цену ошибок на Камчатке. Каждый случай разобран: что произошло,
            почему, и что нужно сделать иначе.
          </p>
          <div className="mt-5 inline-flex items-center gap-3 px-4 py-2.5 rounded-lg border border-[var(--danger)]/20 bg-[var(--danger)]/5">
            <span className="font-playfair text-2xl font-bold text-[var(--danger)]">{totalDeaths}</span>
            <span className="text-sm text-[var(--text-secondary)]">
              задокументированных смертей туристов в базе
            </span>
          </div>
        </div>

        {/* Incident list */}
        <div className="space-y-3 max-w-3xl">
          {rows.map((incident) => (
            <Link
              key={incident.slug}
              href={`/safety/incidents/${incident.slug}`}
              className="group flex items-start gap-4 p-5 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--danger)]/30 hover:bg-[var(--bg-hover)] transition-all"
            >
              <div className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center bg-[var(--danger)]/10 mt-0.5">
                <AlertTriangle className="w-5 h-5 text-[var(--danger)]" />
              </div>

              <div className="flex-1 min-w-0">
                <h2 className="text-base font-semibold text-[var(--text-primary)] mb-1 group-hover:text-[var(--danger)] transition-colors">
                  {incident.title}
                </h2>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--text-muted)] mb-2">
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {formatDate(incident.incident_date)}
                  </span>
                  <span className="flex items-center gap-1">
                    <MapPin className="w-3 h-3" />
                    {incident.location_name}
                  </span>
                  <span className="ds-badge" style={{ background: 'var(--danger)', color: '#fff', opacity: 0.85 }}>
                    {TYPE_LABELS[incident.location_type] ?? incident.location_type}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="flex items-center gap-1 text-[var(--danger)] font-medium">
                    <Users className="w-3 h-3" />
                    {incident.casualties} {incident.casualties === 1 ? 'погиб' : 'погибло'}
                  </span>
                  {incident.injured > 0 && (
                    <span className="text-[var(--warning)]">
                      {incident.injured} {incident.injured === 1 ? 'пострадал' : 'пострадало'}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm text-[var(--text-muted)] line-clamp-2 leading-relaxed">
                  {incident.cause}
                </p>
              </div>

              <ChevronRight className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--danger)] mt-1 flex-shrink-0 transition-colors" />
            </Link>
          ))}
        </div>

        {/* Footer note */}
        <div className="mt-10 max-w-3xl p-4 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            База инцидентов составлена на основе открытых данных МЧС России, региональных СМИ и официальных отчётов.
            Если вы знаете о задокументированном случае, которого нет в базе —{' '}
            <Link href="/ai-assistant" className="text-[var(--ocean)] hover:underline">напишите Кузьмичу</Link>.
          </p>
        </div>

      </main>
    </>
  );
}

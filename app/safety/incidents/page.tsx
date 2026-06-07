import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, Phone, Shield, ChevronRight, MapPin, Thermometer, Wind, Activity } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const revalidate = 300;

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: 'Инциденты и предупреждения — безопасность на Камчатке',
  description:
    'Актуальные предупреждения и закрытые маршруты Камчатки: активные алерты, места с ограниченным доступом, экстренные контакты МЧС и горноспасателей.',
  keywords: [
    'инциденты камчатка',
    'закрытые маршруты камчатка',
    'предупреждения мчс камчатка',
    'безопасность туристов камчатка',
    'экстренная помощь камчатка',
  ],
  alternates: { canonical: `${SITE}/safety/incidents` },
  openGraph: {
    title: 'Инциденты и предупреждения — Камчатка',
    description: 'Актуальные алерты, закрытые маршруты и экстренные контакты Камчатки.',
    url: `${SITE}/safety/incidents`,
    siteName: 'TourHab',
    locale: 'ru_RU',
    type: 'website',
  },
};

interface ActiveAlert {
  place_name: string;
  alert_message: string;
  alert_severity: number;
  active_alerts: string[];
  ark_id: string;
}

interface ClosedPlace {
  place_name: string;
  closed_reason: string | null;
  ark_id: string;
}

async function getActiveAlerts(): Promise<ActiveAlert[]> {
  try {
    const { rows } = await pool.query<ActiveAlert>(`
      SELECT
        p.name AS place_name,
        r.alert_message,
        r.alert_severity,
        r.active_alerts,
        p.ark_id::text
      FROM location_real_time_status r
      JOIN places p ON r.agent_route_id::text = p.ark_id::text
      WHERE r.alert_severity > 0
        AND (r.alert_expires_at IS NULL OR r.alert_expires_at > NOW())
      ORDER BY r.alert_severity DESC
      LIMIT 20
    `);
    return rows;
  } catch {
    return [];
  }
}

async function getClosedPlaces(): Promise<ClosedPlace[]> {
  try {
    const { rows } = await pool.query<ClosedPlace>(`
      SELECT
        p.name AS place_name,
        s.closed_reason,
        p.ark_id::text
      FROM location_safety_profile s
      JOIN places p ON s.agent_route_id::text = p.ark_id::text
      JOIN location_real_time_status r ON r.agent_route_id = s.agent_route_id
      WHERE r.is_open = false
      ORDER BY p.name
      LIMIT 30
    `);
    return rows;
  } catch {
    return [];
  }
}

const SEVERITY_CONFIG: Record<number, { label: string; color: string; bg: string }> = {
  1: { label: 'Низкий', color: 'text-[var(--warning)]', bg: 'bg-yellow-50 dark:bg-yellow-900/20' },
  2: { label: 'Средний', color: 'text-orange-500', bg: 'bg-orange-50 dark:bg-orange-900/20' },
  3: { label: 'Высокий', color: 'text-[var(--danger)]', bg: 'bg-red-50 dark:bg-red-900/20' },
};

const EMERGENCY_CONTACTS = [
  { number: '112', label: 'Единая экстренная служба', note: 'Работает с мобильного без SIM' },
  { number: '8 (4152) 41-17-17', label: 'МЧС Камчатского края', note: 'Круглосуточно' },
  { number: '8 (4152) 29-95-77', label: 'Горноспасательный отряд', note: 'КГБУ «КПСС»' },
  { number: '8 (4152) 42-02-02', label: 'Скорая помощь (ПКГ)', note: 'Петропавловск-Камчатский' },
];

const HAZARD_ICONS: Record<string, typeof AlertTriangle> = {
  volcano: Activity,
  thermal: Thermometer,
  weather: Wind,
  default: AlertTriangle,
};

export default async function IncidentsPage() {
  const [alerts, closed] = await Promise.all([getActiveAlerts(), getClosedPlaces()]);

  const hasAlerts = alerts.length > 0;
  const hasClosed = closed.length > 0;

  return (
    <>
      <Header />
      <main className="bg-[var(--bg-primary)] min-h-screen">

        {/* Hero */}
        <section className="pt-24 pb-10 px-6">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center gap-2 mb-6">
              <AlertTriangle className="w-4 h-4 text-[var(--danger)]" />
              <span className="text-[var(--danger)] font-bold tracking-[0.4em] uppercase text-[10px]">
                Безопасность
              </span>
            </div>
            <h1 className="font-playfair text-4xl md:text-5xl font-bold leading-tight text-[var(--text-primary)] mb-4">
              Инциденты<br />
              <span className="italic">и предупреждения</span>
            </h1>
            <p className="text-[var(--text-secondary)] text-lg font-light max-w-2xl">
              Актуальные алерты, закрытые маршруты и экстренные контакты Камчатки.
              Данные обновляются каждые 5 минут из системы мониторинга платформы.
            </p>
          </div>
        </section>

        {/* Emergency contacts — always first */}
        <section className="px-6 pb-10">
          <div className="max-w-4xl mx-auto">
            <div className="bg-[var(--danger)] rounded-lg p-5 text-white">
              <div className="flex items-center gap-2 mb-4">
                <Phone className="w-5 h-5" />
                <p className="font-semibold text-sm uppercase tracking-wider">
                  Экстренные контакты
                </p>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                {EMERGENCY_CONTACTS.map((c) => (
                  <a
                    key={c.number}
                    href={`tel:${c.number.replace(/[^\d+]/g, '')}`}
                    className="bg-white/10 hover:bg-white/20 transition-colors rounded-lg p-3 flex flex-col gap-0.5"
                  >
                    <span className="text-xl font-bold font-playfair">{c.number}</span>
                    <span className="text-sm font-medium">{c.label}</span>
                    <span className="text-xs text-white/70">{c.note}</span>
                  </a>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Active alerts */}
        <section className="px-6 pb-10">
          <div className="max-w-4xl mx-auto">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-4">
              Активные предупреждения
            </p>

            {hasAlerts ? (
              <div className="space-y-3">
                {alerts.map((a) => {
                  const sev = SEVERITY_CONFIG[a.alert_severity] ?? SEVERITY_CONFIG[1];
                  return (
                    <div
                      key={`${a.ark_id}-${a.alert_severity}`}
                      className={`ds-card p-4 border-l-4 border-[var(--danger)] ${sev.bg}`}
                    >
                      <div className="flex items-start justify-between gap-4 mb-1">
                        <div className="flex items-center gap-2">
                          <MapPin className="w-4 h-4 text-[var(--accent)] shrink-0" />
                          <span className="font-semibold text-[var(--text-primary)] text-sm">
                            {a.place_name}
                          </span>
                        </div>
                        <span className={`text-xs font-semibold ${sev.color}`}>
                          {sev.label}
                        </span>
                      </div>
                      {a.alert_message && (
                        <p className="text-sm text-[var(--text-secondary)] ml-6 leading-relaxed">
                          {a.alert_message}
                        </p>
                      )}
                      {a.active_alerts?.length > 0 && (
                        <div className="mt-2 ml-6 flex flex-wrap gap-1.5">
                          {a.active_alerts.map((tag) => (
                            <span
                              key={tag}
                              className="text-[10px] bg-[var(--bg-hover)] text-[var(--text-secondary)] px-2 py-0.5 rounded"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="ds-card p-6 text-center">
                <Shield className="w-8 h-8 text-[var(--success)] mx-auto mb-3" />
                <p className="font-semibold text-[var(--text-primary)]">
                  Активных предупреждений нет
                </p>
                <p className="text-sm text-[var(--text-secondary)] mt-1">
                  Данные обновляются каждые 5 минут
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Closed places */}
        <section className="px-6 pb-10 border-t border-[var(--border)] pt-10">
          <div className="max-w-4xl mx-auto">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-4">
              Временно закрытые места
            </p>

            {hasClosed ? (
              <div className="space-y-2">
                {closed.map((c) => (
                  <div
                    key={c.ark_id}
                    className="ds-card p-4 flex items-start gap-3"
                  >
                    <AlertTriangle className="w-4 h-4 text-[var(--warning)] shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-[var(--text-primary)] text-sm">
                        {c.place_name}
                      </p>
                      {c.closed_reason && (
                        <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                          {c.closed_reason}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ds-card p-6 text-center">
                <Shield className="w-8 h-8 text-[var(--success)] mx-auto mb-3" />
                <p className="font-semibold text-[var(--text-primary)]">
                  Закрытых мест нет
                </p>
                <p className="text-sm text-[var(--text-secondary)] mt-1">
                  Все маршруты открыты по данным платформы
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Rules reminder */}
        <section className="px-6 pb-10 border-t border-[var(--border)] pt-10">
          <div className="max-w-4xl mx-auto">
            <h2 className="font-playfair text-2xl font-bold text-[var(--text-primary)] mb-6">
              Перед выходом на маршрут
            </h2>
            <div className="grid md:grid-cols-3 gap-4">
              {[
                {
                  title: 'Зарегистрируйтесь в МЧС',
                  body: 'Маршруты с флагом «МЧС обязательно» требуют регистрации группы заранее. Форма — forms.mchs.gov.ru',
                },
                {
                  title: 'Скачайте карту офлайн',
                  body: 'В приложении TourHab карта кэшируется. Нажмите «Скачать для офлайн» на странице маршрута до выхода из зоны связи.',
                },
                {
                  title: 'Возьмите спутниковый коммуникатор',
                  body: 'На маршрутах с sat_communicator_required — спутниковый коммуникатор обязателен. Garmin inReach, Spot или аналог.',
                },
              ].map((item) => (
                <div key={item.title} className="ds-card p-4">
                  <h3 className="font-semibold text-[var(--text-primary)] text-sm mb-2">
                    {item.title}
                  </h3>
                  <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                    {item.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-10 px-6 border-t border-[var(--border)]">
          <div className="max-w-4xl mx-auto flex flex-col sm:flex-row gap-4">
            <Link
              href="/sos"
              className="ds-btn ds-btn-danger inline-flex items-center gap-2"
            >
              SOS — помощь на маршруте
              <ChevronRight className="w-4 h-4" />
            </Link>
            <Link
              href="/tools/safety"
              className="ds-btn ds-btn-secondary inline-flex items-center gap-2"
            >
              Анализатор безопасности
              <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
        </section>

      </main>
      <Footer />
    </>
  );
}

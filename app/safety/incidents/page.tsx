import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, Phone, ChevronRight } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { SectionSwipeBar, SAFETY_SECTION_ITEMS } from '@/components/layout/SectionSwipeBar';
import { Footer } from '@/components/layout/Footer';
import { pool } from '@/lib/db-pool';
import { EMERGENCY_NUMBERS } from '@/lib/safety/emergency-numbers';
import { MCHS_DEADLINE_SHORT } from '@/lib/safety/mchs-registration';
import { defaultOgImages } from '@/lib/seo/og-image';
import { UTC_WALL_NOW_SQL, isoUtcSql } from '@/lib/db/timestamp-iso';
import IncidentsBoard, { type IncidentAlert, type IncidentClosedPlace } from '@/components/safety/IncidentsBoard';

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
    images: defaultOgImages(),
    title: 'Инциденты и предупреждения — Камчатка',
    description: 'Актуальные алерты, закрытые маршруты и экстренные контакты Камчатки.',
    url: `${SITE}/safety/incidents`,
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
};

/**
 * Три чтения, у каждого три исхода: строки, пусто, «не смог». Отказ базы
 * возвращает null и пишет имя чтения в лог — до 15.10 он глушился в пустой
 * список, и сбой печатался «Активных предупреждений нет» зелёным щитом.
 */
async function getActiveAlerts(): Promise<IncidentAlert[] | null> {
  try {
    const { rows } = await pool.query<IncidentAlert>(`
      SELECT
        p.name AS place_name,
        r.alert_message,
        r.alert_severity,
        r.active_alerts,
        p.ark_id::text
      FROM location_real_time_status r
      JOIN places p ON r.agent_route_id::text = p.ark_id::text
      WHERE r.alert_severity > 0
        AND (r.alert_expires_at IS NULL OR r.alert_expires_at > ${UTC_WALL_NOW_SQL})
      ORDER BY r.alert_severity DESC
      LIMIT 20
    `);
    return rows;
  } catch (err) {
    const code = (err as { code?: string }).code;
    console.error('[safety/incidents] предупреждения не прочитаны:', code ?? (err instanceof Error ? err.message : err));
    return null;
  }
}

async function getClosedPlaces(): Promise<IncidentClosedPlace[] | null> {
  try {
    // От статуса, а не от профиля безопасности: закрытое место без строки
    // профиля раньше выпадало из списка (INNER JOIN), и закрытие пропадало.
    const { rows } = await pool.query<IncidentClosedPlace>(`
      SELECT
        p.name AS place_name,
        s.closed_reason,
        p.ark_id::text
      FROM location_real_time_status r
      JOIN places p ON p.ark_id = r.agent_route_id
      LEFT JOIN location_safety_profile s ON s.agent_route_id = r.agent_route_id
      WHERE r.is_open = false
      ORDER BY p.name
      LIMIT 30
    `);
    return rows;
  } catch (err) {
    const code = (err as { code?: string }).code;
    console.error('[safety/incidents] закрытые места не прочитаны:', code ?? (err instanceof Error ? err.message : err));
    return null;
  }
}

/** Последний пересчёт сводок: без него «предупреждений нет» не говорит, про какое время. */
async function getRecomputedAt(): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ at: string | null }>(
      `SELECT ${isoUtcSql('MAX(updated_at)')} AS at FROM location_real_time_status`,
    );
    return rows[0]?.at ?? null;
  } catch (err) {
    const code = (err as { code?: string }).code;
    console.error('[safety/incidents] время пересчёта не прочитано:', code ?? (err instanceof Error ? err.message : err));
    return null;
  }
}

// Единый источник номеров (см. lib/safety/emergency-numbers.ts).
const EMERGENCY_CONTACTS = EMERGENCY_NUMBERS.map((c) => ({
  number: c.phone,
  label: c.name,
  note: c.hint ?? c.type,
}));

export default async function IncidentsPage() {
  const [alerts, closed, recomputedAt] = await Promise.all([getActiveAlerts(), getClosedPlaces(), getRecomputedAt()]);

  return (
    <>
      <Header />
      <main className="bg-[var(--bg-primary)] min-h-screen pt-16">
        <SectionSwipeBar items={SAFETY_SECTION_ITEMS} label="Разделы безопасности" />

        {/* Hero */}
        <section className="pt-6 pb-10 px-6">
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
                    className="bg-black/10 hover:bg-black/20 transition-colors rounded-lg p-3 flex flex-col gap-0.5"
                  >
                    <span className="text-xl font-bold font-playfair">{c.number}</span>
                    <span className="text-sm font-medium">{c.label}</span>
                    <span className="text-xs opacity-70">{c.note}</span>
                  </a>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Предупреждения и закрытия — что платформа знает, с исходом «не смог» */}
        <IncidentsBoard alerts={alerts} closed={closed} recomputedAt={recomputedAt} />

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
                  body: `Маршруты с флагом «МЧС обязательно» требуют регистрации группы. ${MCHS_DEADLINE_SHORT}. Форма — forms.mchs.gov.ru`,
                },
                {
                  title: 'Скачайте карту офлайн',
                  body: 'Сохраните карту маршрута в телефон кнопкой «Скачать для похода» на странице маршрута — до выхода из зоны связи.',
                },
                {
                  title: 'Возьмите спутниковый коммуникатор',
                  body: 'Вне зоны сотовой связи помощь вызывают через спутник: Garmin inReach, Spot или аналог.',
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

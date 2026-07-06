'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MapPin, Shield, Clock, Mountain, AlertTriangle, Download, FileText, Phone } from 'lucide-react';

interface Route {
  id: string;
  title: string;
  description: string | null;
  distance_km: string | null;
  elevation_gain_m: number | null;
  duration_hours: string | null;
  difficulty: string | null;
  season: string | null;
  mchs_registration_required: boolean | null;
  hazards: string[];
}

interface ParkData {
  slug: string;
  displayName: string;
  description: string;
  zone: string;
  mchs_phone: string;
  permit_url: string | null;
  routes: Route[];
}

const DIFFICULTY_LABELS: Record<string, string> = {
  easy:   'Лёгкий',
  medium: 'Средний',
  hard:   'Сложный',
  expert: 'Экспертный',
};

const DIFFICULTY_COLORS: Record<string, string> = {
  easy:   'var(--success)',
  medium: 'var(--warning)',
  hard:   'var(--accent)',
  expert: 'var(--danger)',
};

export default function ParkClient({ slug }: { slug: string }) {
  const [park, setPark] = useState<ParkData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`/api/parks/${slug}`)
      .then(r => { if (!r.ok) { setNotFound(true); return null; } return r.json(); })
      .then((d: ParkData | null) => { if (d) setPark(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div className="ds-page" style={{ maxWidth: 720, margin: '0 auto' }}>
        <div className="ds-skeleton" style={{ height: 120, borderRadius: 12, marginBottom: 16 }} />
        <div className="ds-skeleton" style={{ height: 60, borderRadius: 10, marginBottom: 12 }} />
        <div className="ds-skeleton" style={{ height: 60, borderRadius: 10, marginBottom: 12 }} />
      </div>
    );
  }

  if (notFound || !park) {
    return (
      <div className="ds-page" style={{ maxWidth: 720, margin: '0 auto', textAlign: 'center', paddingTop: 80 }}>
        <p style={{ color: 'var(--text-secondary)' }}>Парк не найден</p>
        <Link href="/" className="ds-btn ds-btn-secondary" style={{ marginTop: 16 }}>На главную</Link>
      </div>
    );
  }

  return (
    <div className="ds-page" style={{ maxWidth: 720, margin: '0 auto' }}>

      {/* Hero */}
      <div style={{ marginBottom: 28 }}>
        <p className="ds-label" style={{ marginBottom: 6 }}>Природный парк · Камчатка</p>
        <h1 className="ds-h1" style={{ marginBottom: 12 }}>{park.displayName}</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 15, lineHeight: 1.6 }}>{park.description}</p>
      </div>

      {/* Три действия — главный блок */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 28 }}>

        {/* Скачать карту */}
        <Link href={`/offline/manage`} className="ds-card" style={{ padding: '18px 16px', textDecoration: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Download size={18} color="var(--ocean)" />
            <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 14 }}>Офлайн-карта</span>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: 0, lineHeight: 1.4 }}>Скачайте до выхода в поле — работает без интернета</p>
        </Link>

        {/* Регистрация МЧС */}
        <Link href={`/register?park=${slug}`} className="ds-card" style={{ padding: '18px 16px', textDecoration: 'none', display: 'flex', flexDirection: 'column', gap: 8, borderColor: 'color-mix(in srgb, var(--danger) 25%, var(--border))' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Shield size={18} color="var(--danger)" />
            <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 14 }}>Регистрация МЧС</span>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: 0, lineHeight: 1.4 }}>Обязательна для большинства маршрутов</p>
        </Link>

        {/* Экстренный звонок */}
        <a href={`tel:112`} className="ds-card" style={{ padding: '18px 16px', textDecoration: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Phone size={18} color="var(--danger)" />
            <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 14 }}>112 — Спасение</span>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: 0 }}>МЧС: {park.mchs_phone}</p>
        </a>
      </div>

      {/* Разрешение на посещение */}
      {park.permit_url && (
        <div className="ds-card" style={{ padding: '14px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FileText size={16} color="var(--warning)" />
            <div>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>Требуется разрешение на посещение</p>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>Оформите до начала маршрута</p>
            </div>
          </div>
          <a href={park.permit_url} target="_blank" rel="noopener noreferrer" className="ds-btn ds-btn-secondary" style={{ fontSize: 12, padding: '6px 12px', whiteSpace: 'nowrap' }}>
            Получить
          </a>
        </div>
      )}

      {/* Маршруты */}
      <div style={{ marginBottom: 8 }}>
        <h2 className="ds-h2" style={{ marginBottom: 16 }}>Маршруты парка</h2>

        {park.routes.length === 0 ? (
          <div className="ds-card" style={{ padding: 24, textAlign: 'center' }}>
            <MapPin size={24} color="var(--text-muted)" style={{ marginBottom: 8 }} />
            <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Маршруты уточняются</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {park.routes.map(route => {
              const diffColor = DIFFICULTY_COLORS[route.difficulty ?? ''] ?? 'var(--text-secondary)';
              const diffLabel = DIFFICULTY_LABELS[route.difficulty ?? ''] ?? route.difficulty ?? '';
              return (
                <Link
                  key={route.id}
                  href={`/routes/${route.id}`}
                  className="ds-card"
                  style={{ padding: '14px 16px', textDecoration: 'none', display: 'block' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 14 }}>{route.title}</span>
                    {route.mchs_registration_required && (
                      <span style={{ fontSize: 10, padding: '2px 6px', background: 'color-mix(in srgb, var(--danger) 12%, transparent)', color: 'var(--danger)', borderRadius: 6, whiteSpace: 'nowrap', flexShrink: 0 }}>
                        МЧС обязательно
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                    {route.distance_km && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', fontSize: 12 }}>
                        <MapPin size={11} />{parseFloat(route.distance_km).toFixed(0)} км
                      </span>
                    )}
                    {route.elevation_gain_m && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', fontSize: 12 }}>
                        <Mountain size={11} />+{route.elevation_gain_m} м
                      </span>
                    )}
                    {route.duration_hours && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', fontSize: 12 }}>
                        <Clock size={11} />{parseFloat(route.duration_hours).toFixed(0)} ч
                      </span>
                    )}
                    {diffLabel && (
                      <span style={{ fontSize: 12, color: diffColor, fontWeight: 600 }}>{diffLabel}</span>
                    )}
                  </div>

                  {route.hazards && route.hazards.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
                      {route.hazards.slice(0, 3).map(h => (
                        <span key={h} style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-hover)', color: 'var(--text-muted)', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 3 }}>
                          <AlertTriangle size={9} />{h}
                        </span>
                      ))}
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

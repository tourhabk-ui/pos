import { ImageResponse } from 'next/og';
import { pool } from '@/lib/db-pool';

export const runtime = 'nodejs';
export const alt = 'Место на Камчатке';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const TYPE_COLOR: Record<string, string> = {
  volcano: '#D44A0C',
  geyser: '#2568B0',
  hot_spring: '#E8734A',
  lake: '#2568B0',
  mountain: '#6B6560',
  historical: '#8B4513',
  museum: '#5B2D8E',
};

const TYPE_LABEL: Record<string, string> = {
  volcano: 'ВУЛКАН', geyser: 'ГЕЙЗЕР', hot_spring: 'ТЕРМАЛЬНЫЙ ИСТОЧНИК',
  lake: 'ОЗЕРО', mountain: 'ГОРА', bay: 'БУХТА', river: 'РЕКА',
  waterfall: 'ВОДОПАД', historical: 'ИСТОРИЯ', museum: 'МУЗЕЙ',
  viewpoint: 'СМОТРОВАЯ', cape: 'МЫС', island: 'ОСТРОВ',
};

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let name = 'Место на Камчатке';
  let locationType = '';
  let description = 'Камчатский край';
  let altitude = '';

  try {
    const { rows } = await pool.query<{
      name: string; location_type: string | null; essence: string | null;
      altitude_m: number | null;
    }>(
      `SELECT p.name, p.location_type, p.essence,
              lsp.altitude_m
       FROM places p
       LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
       WHERE (p.ark_id::text = $1 OR p.id = $1) AND p.is_visible = true
       LIMIT 1`,
      [id]
    );
    if (rows[0]) {
      name = rows[0].name;
      locationType = rows[0].location_type ?? '';
      description = rows[0].essence?.slice(0, 120) ?? 'Камчатский край';
      altitude = rows[0].altitude_m != null ? `${rows[0].altitude_m} м` : '';
    }
  } catch { /* render with defaults */ }

  const accentColor = TYPE_COLOR[locationType] ?? '#D44A0C';
  const typeLabel = TYPE_LABEL[locationType] ?? 'МЕСТО';

  return new ImageResponse(
    (
      <div
        style={{
          width: '1200px', height: '630px',
          background: '#0D1117',
          display: 'flex', flexDirection: 'column',
          justifyContent: 'flex-end',
          padding: '64px',
          fontFamily: 'system-ui, sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Background gradient */}
        <div style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(ellipse at 80% 20%, ${accentColor}22 0%, transparent 60%)`,
        }} />

        {/* Top badge */}
        <div style={{
          position: 'absolute', top: '48px', left: '64px',
          display: 'flex', alignItems: 'center', gap: '12px',
        }}>
          <div style={{
            background: accentColor, color: '#fff',
            padding: '6px 16px', borderRadius: '6px',
            fontSize: '13px', fontWeight: 700, letterSpacing: '0.08em',
          }}>
            {typeLabel}
          </div>
          {altitude && (
            <div style={{
              color: 'rgba(255,255,255,0.5)', fontSize: '14px', fontWeight: 500,
            }}>
              {altitude}
            </div>
          )}
        </div>

        {/* Ведар brand top-right */}
        <div style={{
          position: 'absolute', top: '48px', right: '64px',
          color: 'rgba(255,255,255,0.3)', fontSize: '14px', fontWeight: 600,
          letterSpacing: '0.05em',
        }}>
          Ведар
        </div>

        {/* Main content */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{
            fontSize: name.length > 25 ? '52px' : '68px',
            fontWeight: 800, color: '#F0F6FC',
            lineHeight: 1.1,
            maxWidth: '900px',
          }}>
            {name}
          </div>

          <div style={{
            fontSize: '20px', color: 'rgba(255,255,255,0.55)',
            maxWidth: '800px', lineHeight: 1.4,
          }}>
            {description}
          </div>

          {/* Bottom tag */}
          <div style={{
            marginTop: '8px',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <div style={{
              width: '32px', height: '3px',
              background: accentColor, borderRadius: '2px',
            }} />
            <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '14px' }}>
              Камчатский край
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}

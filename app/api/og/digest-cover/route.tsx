/**
 * GET /api/og/digest-cover?d=<дата>&t=<заголовок>&t=…&s=<подпись>
 *
 * Карточка-обложка AI-дайджеста (PNG 1200×630). Зачем своя карточка вместо
 * генератора и почему параметры подписаны — lib/notifications/digest-cover.ts.
 *
 * Шрифт — DejaVu Sans из public/fonts: в нём есть кириллица (им же пишет PDF,
 * lib/pdf/fonts.ts). Без своего шрифта Satori нарисовал бы русские заголовки
 * квадратами.
 *
 * Цвета здесь — hex, а не CSS-токены: Satori рисует вне страницы, переменных
 * `--accent` у него нет. Значения — тёмная тема токенов (globals.css), как и у
 * OG-картинки мест (app/places/[id]/opengraph-image.tsx).
 */

import { ImageResponse } from 'next/og';
import path from 'node:path';
import fs from 'node:fs';
import { verifyDigestCover } from '@/lib/notifications/digest-cover';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BG = '#0D1117';          // --bg-primary (dark)
const TEXT = '#F0F6FC';        // --text-primary (dark)
const MUTED = '#8B949E';       // --text-secondary (dark)
const ACCENT = '#E8734A';      // --accent (dark)
const RULE = 'rgba(255,255,255,0.08)'; // --border (dark)

let fonts: { regular: Buffer; bold: Buffer } | null | undefined;

function loadFonts(): { regular: Buffer; bold: Buffer } | null {
  if (fonts !== undefined) return fonts;
  try {
    const dir = path.join(process.cwd(), 'public', 'fonts');
    fonts = {
      regular: fs.readFileSync(path.join(dir, 'DejaVuSans.ttf')),
      bold: fs.readFileSync(path.join(dir, 'DejaVuSans-Bold.ttf')),
    };
  } catch (e) {
    console.error('[og/digest-cover] шрифт не прочитан:', e instanceof Error ? e.message : e);
    fonts = null;
  }
  return fonts;
}

/** Кегль заголовков по их числу: один — крупно, три — плотнее. */
export function titleSize(count: number): number {
  // Три по 36: заголовок в 90 знаков (COVER_TITLE_MAX) держится в две строки,
  // и три пункта влезают в 630 пикселей высоты.
  return count <= 1 ? 58 : count === 2 ? 48 : 36;
}

export async function GET(request: Request) {
  const params = verifyDigestCover(new URL(request.url).searchParams);
  if (!params) {
    return new Response('Подпись обложки не сошлась', { status: 403 });
  }
  const f = loadFonts();
  if (!f) {
    // Без кириллического шрифта карточка вышла бы квадратами — лучше честный
    // отказ: Telegram тогда покажет пост без обложки, а причина — в логе.
    return new Response('Шрифт обложки недоступен', { status: 503 });
  }

  const { date, titles } = params;
  const size = titleSize(titles.length);

  return new ImageResponse(
    (
      <div
        style={{
          width: '1200px', height: '630px', display: 'flex', flexDirection: 'column',
          background: BG, padding: '56px 72px', position: 'relative', fontFamily: 'DejaVu',
        }}
      >
        <div style={{
          position: 'absolute', top: 0, right: 0, width: '720px', height: '630px', display: 'flex',
          background: `radial-gradient(ellipse at 90% 10%, ${ACCENT}33 0%, transparent 60%)`,
        }} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', color: ACCENT, fontSize: '24px', fontWeight: 700, letterSpacing: '0.12em' }}>
            AI-ДАЙДЖЕСТ
          </div>
          <div style={{ display: 'flex', color: MUTED, fontSize: '26px' }}>{date}</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', flexGrow: 1 }}>
          {titles.map((t, i) => (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: '28px',
                padding: '22px 0',
                borderTop: i === 0 ? 'none' : `2px solid ${RULE}`,
              }}
            >
              <div style={{ display: 'flex', color: ACCENT, fontSize: `${Math.round(size * 0.7)}px`, fontWeight: 700, minWidth: '56px', paddingTop: '4px' }}>
                {String(i + 1).padStart(2, '0')}
              </div>
              <div style={{ display: 'flex', color: TEXT, fontSize: `${size}px`, fontWeight: 700, lineHeight: 1.2, maxWidth: '980px' }}>
                {t}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', width: '72px', height: '4px', background: ACCENT, borderRadius: '2px' }} />
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: 'DejaVu', data: f.regular, weight: 400, style: 'normal' },
        { name: 'DejaVu', data: f.bold, weight: 700, style: 'normal' },
      ],
      headers: {
        // Содержимое целиком задано подписанными параметрами — кешировать можно навсегда.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    },
  );
}

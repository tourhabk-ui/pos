// @vitest-environment node
/**
 * Обложка AI-дайджеста — своя карточка выпуска (24.09, снимок владельца).
 *
 * Генератор рисовал сцену по ОДНОМУ заголовку: из «обратной разработки
 * формата AutoCAD» вышло серое здание с водяным знаком. Теперь обложка —
 * карточка с датой и заголовками выпуска. Сторож держит:
 * 1. заголовки берутся из поста — без шапки и «Почему важно», не больше трёх;
 * 2. на нашем домене нельзя нарисовать чужой текст: параметры подписаны, и
 *    подделанная подпись или текст — 403;
 * 3. без секрета ссылки нет, и дайджест падает на прежнюю обложку, а не
 *    уходит без обложки молча;
 * 4. карточка действительно рисуется — PNG, а не пустой ответ.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  digestCoverTitles, digestCoverUrl, verifyDigestCover, COVER_TITLE_MAX, DIGEST_COVER_PATH,
} from '@/lib/notifications/digest-cover';
import { GET, titleSize } from '@/app/api/og/digest-cover/route';
import { PUBLIC_API_ROUTES } from '@/lib/auth/public-api-routes';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const POST_24_09 = [
  '<b>AI-дайджест · 24 сентября</b>',
  '',
  '<b>Gemini 3.8 TTS: мультиспикерные диалоги и клонирование голоса за 30 секунд</b>',
  'Google выпустил две TTS-модели.',
  '<b>Почему важно:</b> API позволяет задать разговор персонажей.',
  '<a href="https://a.dev">Читать →</a>',
  '',
  '<b>Обратная разработка формата AutoCAD: DWG в STEP</b>',
  'Cadyon читает 3D-солиды.',
  '<b>Почему важно:</b> редкий уровень верификации.',
].join('\n');

beforeEach(() => { vi.stubEnv('CRON_SECRET', 'test-secret'); vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://vedarai.ru'); });
afterEach(() => vi.unstubAllEnvs());

describe('заголовки выпуска', () => {
  it('из поста 24.09 — два материала, без шапки и «Почему важно»', () => {
    expect(digestCoverTitles(POST_24_09)).toEqual([
      'Gemini 3.8 TTS: мультиспикерные диалоги и клонирование голоса за 30 секунд',
      'Обратная разработка формата AutoCAD: DWG в STEP',
    ]);
  });

  it('не больше трёх, длинный обрезается с многоточием', () => {
    const long = 'А'.repeat(200);
    const html = [1, 2, 3, 4].map((n) => `<b>Заголовок ${n} ${long}</b>`).join('\n');
    const titles = digestCoverTitles(html);
    expect(titles).toHaveLength(3);
    for (const t of titles) {
      expect(t.length).toBeLessThanOrEqual(COVER_TITLE_MAX);
      expect(t.endsWith('…')).toBe(true);
    }
  });
});

describe('подпись', () => {
  it('подписанный адрес проверяется и отдаёт те же параметры', () => {
    const url = digestCoverUrl('24 сентября', ['Первый', 'Второй'])!;
    expect(url.startsWith(`https://vedarai.ru${DIGEST_COVER_PATH}?`)).toBe(true);
    expect(verifyDigestCover(new URL(url).searchParams)).toEqual({ date: '24 сентября', titles: ['Первый', 'Второй'] });
  });

  it('подменённый текст, дата или подпись — отказ', () => {
    const u = new URL(digestCoverUrl('24 сентября', ['Первый'])!);
    const tamperedTitle = new URLSearchParams(u.searchParams); tamperedTitle.set('t', 'Реклама казино');
    const tamperedDate = new URLSearchParams(u.searchParams); tamperedDate.set('d', '1 апреля');
    const tamperedSig = new URLSearchParams(u.searchParams); tamperedSig.set('s', '0'.repeat(32));
    for (const p of [tamperedTitle, tamperedDate, tamperedSig]) expect(verifyDigestCover(p)).toBeNull();
  });

  it('без секрета ссылки нет — и проверки нет', () => {
    const url = digestCoverUrl('24 сентября', ['Первый'])!;
    vi.stubEnv('CRON_SECRET', '');
    expect(digestCoverUrl('24 сентября', ['Первый'])).toBeNull();
    expect(verifyDigestCover(new URL(url).searchParams)).toBeNull();
  });

  it('заголовков нет — ссылки нет', () => {
    expect(digestCoverUrl('24 сентября', [])).toBeNull();
  });
});

describe('карточка рисуется', () => {
  it('подпись верна — PNG', async () => {
    const res = await GET(new Request(digestCoverUrl('24 сентября', ['Gemini 3.8 TTS: клонирование голоса'])!));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(5000);
    // Сигнатура PNG: 89 50 4E 47.
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 30_000);

  it('подпись не та — 403, картинки нет', async () => {
    const url = digestCoverUrl('24 сентября', ['Первый'])!.replace(/s=[0-9a-f]+/, 's=deadbeef');
    expect((await GET(new Request(url))).status).toBe(403);
  });

  it('кегль падает с числом заголовков — три пункта по 90 знаков влезают', () => {
    expect(titleSize(1)).toBeGreaterThan(titleSize(2));
    expect(titleSize(2)).toBeGreaterThan(titleSize(3));
  });
});

describe('подключено', () => {
  it('роут публичный только на GET — его забирает сам Telegram', () => {
    expect(PUBLIC_API_ROUTES['/api/og']).toEqual(['GET']);
  });

  it('дайджест берёт карточку, генератор — только запасом', () => {
    const src = read('lib/agents/scout-digest.ts');
    const card = src.indexOf('digestCoverUrl(today, digestCoverTitles(aiDigest))');
    const fallback = src.indexOf('resolveCoverImage(', card);
    expect(card).toBeGreaterThan(0);
    expect(fallback).toBeGreaterThan(card);
    expect(src).toMatch(/tgSendRich\(aiChannelId, aiPost, [^,]+, coverUrl,/);
  });
});

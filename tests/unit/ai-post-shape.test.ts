/**
 * Сторож: в AI-канал уходит выпуск, а не обрывок; кнопки — про материалы
 * поста; дата — по Камчатке (26.09, «полный кринж для канала 6.8К»).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aiPostMaterials, aiPostTooThin, aiPostButtons, buttonLabel, kamchatkaDate, AI_BUTTON_LABEL_MAX,
} from '@/lib/notifications/ai-post-shape';

/** Пост 26.09 в том виде, в каком он ушёл (без подвала). */
const POST_2609 = `<b>AI-дайджест · 25 сентября</b>

<b>Muse — первый потребительский агент, который опаснее, чем выглядит</b>
Каждый пользователь Muse получает собственную перси`;

const GOOD = `<b>AI-дайджест · 26 сентября</b>

<b>Muse даёт каждому пользователю свою Linux VM</b>
Meta упаковала агента с постоянной машиной в облаке.
<b>Почему важно:</b> агент с состоянием меняет модель угроз.
<a href="https://simonwillison.net/2026/Sep/25/gruber/">Читать →</a>

<b>Altar-1: открытая security-модель из GLM-5.3</b>
Aikido выпустила модель, полученную прунингом до 328 GB.
<b>Почему важно:</b> проверку зависимостей можно гонять локально.
<a href="https://example.com/a?x=1&amp;y=2">Читать →</a>

<blockquote expandable>Третий нюанс без ссылки.</blockquote>`;

describe('материалы поста', () => {
  it('случай 26.09: заголовок без вывода и ссылки — не материал, и пост не выходит', () => {
    expect(aiPostMaterials(POST_2609)).toEqual([]);
    expect(aiPostTooThin(POST_2609)).toMatch(/0 полных материалов/);
  });

  it('два полных материала — выпуск; шапка и цитата материалами не считаются', () => {
    const m = aiPostMaterials(GOOD);
    expect(m.map((x) => x.title)).toEqual([
      'Muse даёт каждому пользователю свою Linux VM',
      'Altar-1: открытая security-модель из GLM-5.3',
    ]);
    expect(m[1].url).toBe('https://example.com/a?x=1&y=2');
    expect(aiPostTooThin(GOOD)).toBeNull();
  });

  it('один полный материал — ещё не выпуск', () => {
    const one = GOOD.split('\n\n').slice(0, 2).join('\n\n');
    expect(aiPostTooThin(one)).not.toBeNull();
  });
});

describe('кнопки', () => {
  it('только на материалы поста и их русскими заголовками', () => {
    const b = aiPostButtons(GOOD).flat();
    expect(b.map((x) => x.url)).toEqual(['https://simonwillison.net/2026/Sep/25/gruber/', 'https://example.com/a?x=1&y=2']);
    for (const x of b) expect(x.text).toMatch(/[а-яё]/i);
  });

  it('подпись режется по слову, а не посреди него', () => {
    const l = buttonLabel('Muse даёт каждому пользователю свою постоянную Linux VM в облаке');
    expect(l.length).toBeLessThanOrEqual(AI_BUTTON_LABEL_MAX);
    expect(l.endsWith('…')).toBe(true);
    expect(l).toBe('Muse даёт каждому пользователю свою…');
  });
});

describe('дата выпуска', () => {
  it('вечерний прогон 25.09 в 20:18 UTC — это 26 сентября на Камчатке', () => {
    expect(kamchatkaDate(new Date('2026-09-25T20:18:00Z'), { day: 'numeric', month: 'long' })).toBe('26 сентября');
  });
});

describe('разведчик пользуется этим', () => {
  const src = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf8');

  it('порог выпуска стоит до отправки и называет причину', () => {
    const gate = src.indexOf('aiPostTooThin(aiDigest)');
    const send = src.indexOf('await tgSendRich(aiChannelId');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(send);
    expect(src).toMatch(/aiSkip = 'ai_post_too_thin'/);
  });

  it('кнопки — из поста, а не из ленты сигналов', () => {
    expect(src).toContain('aiPostButtons(aiDigest)');
    expect(src).not.toMatch(/aiItems\s*\.filter\(i => i\.url\)\s*\.slice\(0, 3\)/);
  });

  it('ни одной даты по часам сервера', () => {
    expect(src).not.toMatch(/new Date\(\)\.toLocaleDateString\('ru-RU'/);
  });
});

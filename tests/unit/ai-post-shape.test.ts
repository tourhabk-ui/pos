/**
 * Сторож: в AI-канал уходит выпуск, а не обрывок; вёрстка «Журнал»
 * (27.09); дата — по Камчатке (26.09, «полный кринж для канала 6.8К»).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aiPostMaterials, aiPostShape, aiPostTooThin, kamchatkaDate, toJournalLayout,
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

describe('вёрстка «Журнал» (выбор владельца 27.09)', () => {
  const J = toJournalLayout(GOOD);

  it('заголовок материала — ссылка на статью, строк «Читать →» нет', () => {
    expect(J).toContain('<b><a href="https://simonwillison.net/2026/Sep/25/gruber/">Muse даёт каждому пользователю свою Linux VM</a></b>');
    expect(J).toContain('<b><a href="https://example.com/a?x=1&amp;y=2">Altar-1: открытая security-модель из GLM-5.3</a></b>');
    expect(J).not.toMatch(/Читать/);
  });

  it('«Почему важно» — плашкой цитаты', () => {
    expect(J).toContain('<blockquote><b>Почему важно:</b> агент с состоянием меняет модель угроз.</blockquote>');
  });

  it('шапка и хвостовая цитата не тронуты', () => {
    expect(J.startsWith('<b>AI-дайджест · 26 сентября</b>\n\n')).toBe(true);
    expect(J).toContain('<blockquote expandable>Третий нюанс без ссылки.</blockquote>');
  });

  it('материалы, ссылки и порог выпуска после вёрстки те же', () => {
    expect(aiPostMaterials(J)).toEqual(aiPostMaterials(GOOD));
    expect(aiPostTooThin(J)).toBeNull();
  });

  it('уже свёрстанный пост не меняется (повторный проход — no-op)', () => {
    expect(toJournalLayout(J)).toBe(J);
  });
});

/**
 * Вечерний выпуск 28.09 не вышел с «0 полных материалов». Шаблон 27.09
 * ставит вывод в цитату, и модели свойственно опускать внутренний <b>:
 * цитата и так выделена. Счётчик узнавал вывод только по <b>Почему важно —
 * и пост с двумя полными материалами читался пустым.
 */
const UNBOLD_2809 = `<b>AI-дайджест · 29 сентября</b>

<b><a href="https://a.example/1">Первый материал</a></b>
Два предложения конкретики.
<blockquote>Почему важно: вывод для строителя агентов.</blockquote>

<strong><a href="https://a.example/2">Второй материал</a></strong>
Ещё два предложения.
<blockquote><i>Почему важно:</i> второй вывод.</blockquote>

Почему важно: строкой без тегов тоже вывод.`;

describe('вывод без жирного — всё равно вывод (28.09)', () => {
  it('пост в шаблоне 27.09 без <b> у «Почему важно» — два материала, выпуск', () => {
    expect(aiPostMaterials(UNBOLD_2809).map((m) => m.title)).toEqual(['Первый материал', 'Второй материал']);
    expect(aiPostTooThin(UNBOLD_2809)).toBeNull();
  });

  it('обрывок 26.09 по-прежнему не материал', () => {
    expect(aiPostTooThin(POST_2609)).toMatch(/0 полных материалов/);
  });

  it('вёрстка приводит вывод к одному виду: цитата с жирной меткой', () => {
    const J = toJournalLayout(UNBOLD_2809);
    expect(J).toContain('<blockquote><b>Почему важно:</b> вывод для строителя агентов.</blockquote>');
    expect(J).toContain('<blockquote><b>Почему важно:</b> второй вывод.</blockquote>');
    expect(J).toContain('<blockquote><b>Почему важно:</b> строкой без тегов тоже вывод.</blockquote>');
    expect(J).toContain('<b><a href="https://a.example/2">Второй материал</a></b>');
    expect(J).not.toMatch(/<strong>|<i>Почему/);
    expect(aiPostMaterials(J)).toEqual(aiPostMaterials(UNBOLD_2809));
    expect(toJournalLayout(J)).toBe(J);
  });

  it('форма черновика называет счёт разметки, а не текст', () => {
    const shape = aiPostShape(UNBOLD_2809);
    expect(shape).toMatch(/блоков 4, жирных 3, ссылок 2, «Почему важно» 3, Markdown 0/);
    expect(shape).not.toMatch(/Первый материал/);
    expect(aiPostShape('**Заголовок** и [ссылка](https://x.example)')).toMatch(/Markdown 2/);
  });

  it('отказ по порогу несёт форму черновика до и после чистки хвоста', () => {
    const src = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf8');
    const draft = src.indexOf('const aiDraftShape = aiDigest ? aiPostShape(aiDigest) : null;');
    expect(draft).toBeGreaterThan(0);
    expect(draft).toBeLessThan(src.indexOf('polishDigest(aiDigest)'));
    expect(src).toContain('черновик: ${aiDraftShape}; после чистки хвоста: ${aiPostShape(aiDigest)}');
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

  it('вёрстка — после фактчека и до отправки; кнопок под постом нет', () => {
    const layout = src.indexOf('aiDigest = toJournalLayout(aiDigest);');
    expect(layout).toBeGreaterThan(src.indexOf('aiPostTooThin(aiDigest)'));
    expect(layout).toBeLessThan(src.indexOf('await tgSendRich(aiChannelId'));
    expect(src).toContain('await tgSendRich(aiChannelId, aiPost, undefined, coverUrl,');
    expect(src).not.toMatch(/aiItems\s*\.filter\(i => i\.url\)\s*\.slice\(0, 3\)/);
  });

  it('ни одной даты по часам сервера', () => {
    expect(src).not.toMatch(/new Date\(\)\.toLocaleDateString\('ru-RU'/);
  });
});

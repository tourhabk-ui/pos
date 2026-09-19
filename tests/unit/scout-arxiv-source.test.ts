// @vitest-environment node
/**
 * arXiv в разведке: адрес ведёт на страницу работы, а не на PDF.
 *
 * ── Повод (19.09) ─────────────────────────────────────────────────────────
 *
 * Слово владельца: «добавь arxiv.org/abs в один из ресурсов поиска
 * разведчика — там очень интересные есть описания и инструкции». Просьба
 * названа адресом, и адрес в ней существенный: `/abs/` — это страница работы
 * с аннотацией, `/pdf/` — файл. В выпуске, который читают с телефона, разница
 * между ними — между «посмотрел, о чём это» и «скачал полтора мегабайта».
 *
 * ── Почему сторож нужен именно здесь ──────────────────────────────────────
 *
 * Все прочие источники этого состава вносились ПОСЛЕ переписи: адрес
 * запрашивался, ответ смотрели глазами. Здесь переписи не было — arxiv.org из
 * среды, где правился файл, недостижим вовсе. Значит единственное, что можно
 * проверить в репозитории, — не «жив ли адрес» (этого отсюда не узнать
 * принципиально, и первый прогон скажет это сам через `status`/`via`), а
 * СОГЛАСОВАННОСТЬ: запрос сужает выдачу, разбор берёт из ответа ту ссылку, о
 * которой просили, и заголовок доезжает одной строкой.
 *
 * Последнее — не косметика. Atom переносит длинный заголовок по строкам с
 * отступом; у восьми прежних AI-лент заголовок однострочный, поэтому
 * «лесенка» внутри заголовка появилась бы ровно с этим источником и ровно в
 * готовом выпуске.
 *
 * Форма ответа ниже — настоящая форма arXiv API (две ссылки на запись, первая
 * `rel="alternate"` на /abs/, вторая `title="pdf"`), а не придуманная под
 * проверку.
 */
import { describe, it, expect } from 'vitest';
import { RSS_SOURCES } from '@/lib/agents/scout-sources';
import { parseRssItems } from '@/lib/agents/scout-digest';
import { SCOUT_SOURCE_EXPECTATIONS } from '@/lib/services/scout/source-health';

const arxiv = RSS_SOURCES.find(s => s.key === 'arxiv');

describe('источник заведён как лента раздела AI', () => {
  it('стоит в составе ровно один раз', () => {
    expect(RSS_SOURCES.filter(s => s.key === 'arxiv')).toHaveLength(1);
  });

  it('это RSS/Atom-лента, а не превью Telegram', () => {
    expect(arxiv?.kind ?? 'rss').toBe('rss');
  });

  it('идёт в раздел AI — туда же, где прочие первоисточники', () => {
    expect(arxiv?.category).toBe('ai');
  });

  it('сторожится порогом тишины, как всякий источник', () => {
    // Дубль с scout-source-coverage намеренный и узкий: там держится
    // ПОКРЫТИЕ состава, здесь — что окно осталось узким. Широкое окно у
    // непроверенного адреса означало бы неделю молчания, принятую за норму.
    const e = SCOUT_SOURCE_EXPECTATIONS.find(x => x.key === 'arxiv');
    expect(e).toBeDefined();
    expect(e!.maxSilenceHours).toBeLessThanOrEqual(96);
  });
});

describe('запрос сужает выдачу, а не берёт весь поток', () => {
  const url = arxiv?.url ?? '';

  it('это поисковый запрос', () => {
    expect(url).toContain('search_query=');
  });

  it('сортировка по дате — иначе пятёрка разбора будет произвольной', () => {
    // Разбор берёт из ленты первые пять записей. Без сортировки по дате это
    // пять случайных работ из сотни за сутки — лотерея, а не разведка.
    expect(url).toContain('sortBy=submittedDate');
    expect(url).toContain('sortOrder=descending');
  });

  it('тема названа, а не взят раздел целиком', () => {
    expect(url).toContain('cat:cs.AI');
    expect(url).toContain('abs:agent');
  });
});

/**
 * Настоящая форма ответа arXiv API: Atom, перенесённый заголовок, две ссылки
 * на запись. Сокращено до двух работ и без служебных полей — проверяется
 * разбор, а не полнота примера.
 */
const ARXIV_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query: search_query=cat:cs.AI</title>
  <entry>
    <id>http://arxiv.org/abs/2609.20519v1</id>
    <published>2026-09-18T17:02:11Z</published>
    <updated>2026-09-18T17:02:11Z</updated>
    <title>Tool-Use Failures in Long-Horizon Agents: A Study of
  Recovery Strategies</title>
    <summary>  We study how agents recover after a failed tool call.
</summary>
    <link href="http://arxiv.org/abs/2609.20519v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2609.20519v1" rel="related" type="application/pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2609.20488v2</id>
    <published>2026-09-18T09:41:00Z</published>
    <title>Grounding Field Assistants in Offline Map Data</title>
    <link href="http://arxiv.org/abs/2609.20488v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2609.20488v2" rel="related" type="application/pdf"/>
  </entry>
</feed>`;

describe('разбор ответа arXiv', () => {
  const items = parseRssItems(ARXIV_ATOM, 'arXiv cs.AI');

  it('заголовок ленты не считается работой', () => {
    // <title> фида лежит вне <entry> — если он просочится, в выпуск уйдёт
    // строка «ArXiv Query: …» как будто это статья.
    expect(items).toHaveLength(2);
    expect(items.map(i => i.title).join(' ')).not.toContain('ArXiv Query');
  });

  it('ссылка ведёт на страницу работы, а не на PDF', () => {
    for (const i of items) {
      expect(i.url, 'в выпуск должна уходить /abs/, о ней и просил владелец').toContain('arxiv.org/abs/');
      expect(i.url).not.toContain('/pdf/');
    }
  });

  it('перенесённый заголовок доезжает одной строкой', () => {
    const t = items[0].title;
    expect(t).not.toMatch(/\s{2,}/);
    expect(t).not.toContain('\n');
    expect(t).toBe('Tool-Use Failures in Long-Horizon Agents: A Study of Recovery Strategies');
  });

  it('дата подачи разобрана — иначе работа выпадет по свежести', () => {
    // Фильтр возраста (classifyItemAge) без даты не может назвать сигнал
    // свежим, и весь источник молча пройдёт мимо выпуска.
    expect(items[0].publishedAt).toBe('2026-09-18T17:02:11.000Z');
  });
});

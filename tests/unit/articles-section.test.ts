/**
 * Раздел статей.
 *
 * ── Откуда он взялся ───────────────────────────────────────────────────────
 *
 * Перепись 11.08 нашла в справочнике МАРШРУТОВ двадцать шесть записей,
 * которые источник опубликовал заметками: «Флора Камчатки», «Растения
 * Камчатки», «Экологические проблемы Камчатки». Они лежали видимыми, то есть
 * предлагались туристу как то, по чему можно пойти.
 *
 * Владелец сначала сказал «если не знаешь — удаляй», потом — «нужно сделать
 * раздел статьи так же как с видами рыб, это было бы логичней». Второе
 * отменяет первое и оно лучше: текст про Камчатку не мусор, мусором его
 * делала неправильная полка.
 *
 * Отсюда предмет проверки: из маршрутов запись уходит, а текст — нет.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...args: unknown[]) => queryMock(...args),
    connect: () => Promise.resolve({
      query: (...args: unknown[]) => queryMock(...args),
      release: () => {},
    }),
  },
}));
vi.mock('@/lib/services/routes/geocode', () => ({
  geocodeAddress: vi.fn().mockResolvedValue(null),
  withinKamchatka: () => true,
}));

import { listArticles, getArticle, groupByTopic, type Article } from '@/lib/articles/queries';
import { runDataRepair } from '@/lib/services/data-repair';
import { slugify } from '@/lib/text/slugify';

beforeEach(() => queryMock.mockReset());

const article = (over: Partial<Article> = {}): Article => ({
  id: 'a1', slug: 'flora-kamchatki', title: 'Флора Камчатки',
  body: 'текст', topic: null, sourceUrl: null, sourceName: null, ...over,
});

describe('перенос: из маршрутов вон, текст цел', () => {
  function scene(notes: Array<Record<string, unknown>>) {
    queryMock.mockImplementation((raw: unknown) => {
      const sql = String(raw ?? '');
      if (sql.includes("= '/note'")) return Promise.resolve({ rows: notes });
      if (sql.includes('FROM operator_tours')) return Promise.resolve({ rows: [{ n: '0' }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
  }
  const sqls = () => queryMock.mock.calls.map(([sql]) => String(sql ?? ''));

  it('заметка уезжает в статьи И удаляется из маршрутов', async () => {
    scene([{
      id: 'n1', title: 'Флора Камчатки', description: 'Длинный текст про растения',
      source_url: 'https://kamchatkaland.ru/note/flora', source_name: 'kamchatkaland.ru',
      category: 'eco',
    }]);
    const res = await runDataRepair(false, 'source_note');
    expect(res.notes_to_articles).toBe(1);

    const order = sqls();
    const inserted = order.findIndex((q) => /INSERT INTO articles/.test(q));
    const deleted = order.findIndex((q) => /DELETE FROM kamchatka_routes/.test(q));
    expect(inserted).toBeGreaterThanOrEqual(0);
    // Порядок — суть: сперва сохранить, потом удалять. Обратный невозможен.
    expect(inserted).toBeLessThan(deleted);
  });

  it('адрес статьи строится общим slugify, своего второго нет', async () => {
    // Второе правило об одном и том же разойдётся с первым: за сутки это
    // случилось трижды (SQL против TS-стража, линия на трёх экранах, список
    // родовых слов против длины среза).
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'lib/services/data-repair.ts'), 'utf-8',
    ) as string;
    expect(src).toMatch(/from '@\/lib\/text\/slugify'/);
    expect(slugify('Флора Камчатки')).toBe('flora-kamchatki');
  });

  it('название без букв — адресом становится id, а не пустая строка', async () => {
    // Пустой slug дал бы /articles/ и увёл на список: страница есть, а статьи
    // на ней нет. Непрозрачный адрес честнее сломанного.
    scene([{
      id: 'n9', title: '«»', description: 'текст',
      source_url: null, source_name: null, category: null,
    }]);
    await runDataRepair(false, 'source_note');
    const insert = queryMock.mock.calls.find(([sql]) => /INSERT INTO articles/.test(String(sql ?? '')));
    expect((insert![1] as unknown[])[0]).toBe('n9');
  });

  it('dry-run ничего не переносит и не удаляет', async () => {
    scene([{
      id: 'n1', title: 'Флора Камчатки', description: 'текст',
      source_url: null, source_name: null, category: null,
    }]);
    const res = await runDataRepair(true);
    expect(res.notes_to_articles).toBe(1); // счёт ведётся
    expect(sqls().some((q) => /INSERT INTO articles/.test(q))).toBe(false);
    expect(sqls().some((q) => /^\s*DELETE/i.test(q))).toBe(false);
  });
});

describe('чтение раздела', () => {
  it('показываются только видимые', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await listArticles();
    expect(String(queryMock.mock.calls[0][0])).toMatch(/is_visible = TRUE/);
  });

  it('нет статьи — null, а не пустая статья', async () => {
    // Пустая статья отрисовалась бы страницей без текста; null отдаёт 404.
    queryMock.mockResolvedValue({ rows: [] });
    expect(await getArticle('net-takoy')).toBeNull();
  });

  it('ошибка БД не глушится в «статей нет»', () => {
    // Пустой список — другое утверждение, чем «прочитать не удалось». Ровно
    // этот класс подмены перепись ловила весь день.
    //
    // Проверка по исходнику, а не поведением, и это сознательный размен:
    // отклонённый промис из мока vitest считает необработанным раньше, чем
    // его успевает перехватить тест, и файл падает целиком. Гард слабее
    // поведенческого — он поймает только возврат пустого массива из catch,
    // самый вероятный способ ошибиться здесь.
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'lib/articles/queries.ts'), 'utf-8',
    ) as string;
    expect(src).not.toMatch(/catch[\s\S]{0,80}return \[\]/);
    expect(src).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\[\]/);
  });
});

describe('оглавление по темам', () => {
  it('статьи без темы собираются в честное «Разное», и оно последнее', () => {
    // Приписать статью к первой попавшейся рубрике — выдумать факт.
    const groups = groupByTopic([
      article({ slug: 'a', title: 'Без темы' }),
      article({ slug: 'b', title: 'Флора', topic: 'Природа' }),
    ]);
    expect(groups.map((g) => g.topic)).toEqual(['Природа', 'Разное']);
  });

  it('пустая тема — тоже «Разное», а не пустой заголовок', () => {
    expect(groupByTopic([article({ topic: '   ' })])[0].topic).toBe('Разное');
  });
});

/**
 * Раздел в sitemap.
 *
 * Урок 08.08: туры существовали, а в sitemap не попадали — и для поиска их не
 * было вовсе. Раздел, который никто не находит, сделан наполовину.
 */
describe('раздел виден поиску', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(process.cwd(), 'lib/seo/sitemap-entries.ts'), 'utf-8',
  ) as string;

  it('оглавление раздела в sitemap', () => {
    expect(src).toMatch(/\$\{BASE\}\/articles`/);
  });

  it('и сами статьи, а не только оглавление', () => {
    // Иначе обходчик увидит раздел и ни одного текста в нём.
    expect(src).toMatch(/FROM articles/);
    expect(src).toMatch(/articlePages/);
    expect(src).toMatch(/\.\.\.articlePages/);
  });

  it('недоступная БД не подставляет выдуманные адреса', () => {
    // Список адресов «на всякий случай» отправил бы обходчика на 404.
    expect(src).toMatch(/articlePages[\s\S]{0,600}catch/);
  });
});

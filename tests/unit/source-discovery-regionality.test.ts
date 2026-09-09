/**
 * tests/unit/source-discovery-regionality.test.ts
 *
 * Живая лента — ещё не краевая лента.
 *
 * ── Повод (08.09) ──────────────────────────────────────────────────────────
 *
 * Живых новостных источников о Камчатском крае у платформы не осталось ни
 * одного: kamgov и 41.mchs сняли RSS 01.08, а kamchatka.aif.ru отдаёт HTML
 * вместо ленты по всем трём обычным адресам (замер 40, `looks_like_feed:
 * false`, одна и та же страница на 9.5 КБ).
 *
 * Раздел «Камчатка» в дайджесте при этом не пустовал: синтез брал федеральную
 * новость про Дальний Восток и ставил её под краевой заголовок. Формально не
 * выдумка — фактически подмена региона соседним.
 *
 * ── Отсюда правило ─────────────────────────────────────────────────────────
 *
 * Перепись источников уже проверяла ДОСТИЖИМОСТЬ и СВЕЖЕСТЬ. Оба вопроса
 * важны и оба не о том: лента бывает живой, свежей и не о крае. Третий вопрос
 * — «про нас ли это» — надо задавать отдельно и мерить содержимым, а не
 * обещанием предложившей модели.
 *
 * ── Границы, которые держит сторож ─────────────────────────────────────────
 *
 * 1. Соседний регион краем не считается — ровно на этом и вышла подмена.
 * 2. Заголовков не разобрали → `unknown`, а НЕ «не про край»: отбросить
 *    годный источник по признаку нашего неумения его прочитать — та же
 *    подмена «не смог» на «плохо» (§4.0).
 * 3. Порог низкий: краевое издание пишет и о стране тоже. Требовать края в
 *    каждом заголовке значило бы отсеять настоящие региональные ленты.
 */
import { describe, it, expect } from 'vitest';
import { regionality, extractTitles } from '@/scripts/source-discovery-runner';

const t = (...xs: string[]) => xs;

describe('краевая лента отличается от живой', () => {
  it('заголовки про край — regional', () => {
    const r = regionality(t(
      'В Петропавловске-Камчатском открыли новый маршрут',
      'Авачинский перевал закрыт из-за схода лавины',
      'Погода в крае на выходные',
    ));
    expect(r.verdict).toBe('regional');
    expect(r.hits).toBeGreaterThanOrEqual(2);
  });

  it('федеральная лента про ДФО краевой НЕ считается', () => {
    // Тот самый случай: «расширение границ ТОР на Дальнем Востоке» под
    // заголовком раздела «Камчатка».
    const r = regionality(t(
      'Расширены границы территорий опережающего развития на Дальнем Востоке',
      'В ДФО построят новые причалы',
      'Приморье увеличило турпоток',
      'Правительство утвердило программу для округа',
    ));
    expect(r.verdict).toBe('not_regional');
    expect(r.hits).toBe(0);
  });

  it('край упомянут в пятой части заголовков — этого довольно', () => {
    // Краевое издание пишет и о стране: строгий порог отсеял бы его.
    const r = regionality(t(
      'Курс рубля вырос', 'Новый закон о туризме', 'Погода в столице',
      'Вилючинск получил новый причал', 'Цены на топливо',
    ));
    expect(r.verdict).toBe('regional');
  });

  it('заголовков нет — «не знаю», а не «не про край»', () => {
    const r = regionality([]);
    expect(r.verdict).toBe('unknown');
    expect(r.total).toBe(0);
  });
});

describe('заголовки достаются из ленты, а не выдумываются', () => {
  it('RSS: имя самой ленты не считается материалом', () => {
    // Первый <title> — название издания, и оно почти всегда содержит топоним.
    // Считать его материалом значило бы объявить региональной любую ленту с
    // «Камчатка» в названии, даже если пишет она о чём угодно.
    const xml = `<rss><channel><title>Камчатка Информ</title>
      <item><title>Курс валют на сегодня</title></item>
      <item><title>Новый закон о налогах</title></item>
    </channel></rss>`;
    const titles = extractTitles(xml, false);
    expect(titles).toEqual(['Курс валют на сегодня', 'Новый закон о налогах']);
    expect(regionality(titles).verdict).toBe('not_regional');
  });

  it('CDATA разворачивается', () => {
    const xml = `<rss><channel><title>Лента</title>
      <item><title><![CDATA[Извержение Шивелуча]]></title></item>
    </channel></rss>`;
    expect(extractTitles(xml, false)).toEqual(['Извержение Шивелуча']);
  });

  it('Telegram-превью: берётся текст постов', () => {
    const html = '<div class="tgme_widget_message_text js-message_text">Ключевской выбросил пепел</div>';
    expect(extractTitles(html, true)[0]).toContain('Ключевской');
  });
});

describe('словарь топонимов строгий по замыслу', () => {
  it('«Дальний Восток» и «ДФО» в него не входят', () => {
    const SRC = readSrc();
    expect(SRC).toMatch(/KAMCHATKA_WORDS/);
    const list = SRC.slice(SRC.indexOf('const KAMCHATKA_WORDS'), SRC.indexOf('/** Заголовки материалов'));
    expect(list).not.toMatch(/дальн/i);
    expect(list).not.toMatch(/дфо/i);
    expect(list).not.toMatch(/примор/i);
  });
});

function readSrc(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  return readFileSync(join(process.cwd(), 'scripts/source-discovery-runner.ts'), 'utf-8');
}

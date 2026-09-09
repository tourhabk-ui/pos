/**
 * tests/unit/source-discovery-filter.test.ts
 *
 * Отбор кандидатов не выбрасывает годных по формальности.
 *
 * ── Что показал прогон 3 (08.09) ───────────────────────────────────────────
 *
 * DeepSeek предложил 25 адресов, форму прошли 17, а восемь были отброшены
 * ОДНОЙ причиной: `http://` вместо `https://`. Среди отброшенных —
 * `kamchatinfo.com` (камчатское агентство) и `emsd.ru` (Камчатский филиал
 * Геофизической службы, первоисточник по сейсмике). То есть треть кандидатов
 * ушла не потому, что они плохи, а потому что модель написала схему по
 * привычке.
 *
 * Почти любой живой сайт отвечает по https на том же адресе. Значит правильный
 * ответ — поднять схему и СПРОСИТЬ, а не решить за сервер. Проверять от этого
 * меньше не стали: поднятый адрес идёт в ту же перепись и получает тот же
 * приговор от сервера.
 *
 * ── Второй дефект того же прогона ──────────────────────────────────────────
 *
 * Все пять предложенных телеграм-каналов дали «HTTP 200, постов в превью нет»
 * — включая `t.me/s/kamgov` и канал губернатора. Механизм рабочий: у разведки
 * уже есть живые `t.me/s/`-источники. Значит имена каналов сочинены моделью, а
 * t.me отдаёт 200 и обычную страницу на любое имя.
 *
 * Вердикт был формально верен и по смыслу вводил в заблуждение: «канал есть,
 * постов нет» вместо «такого канала нет». Разница решает, идти ли искать
 * настоящее имя канала или вычеркнуть кандидата.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filterCandidates } from '@/scripts/source-discovery-runner';

const SRC = readFileSync(join(process.cwd(), 'scripts/source-discovery-runner.ts'), 'utf-8');

const cand = (over: Record<string, unknown>) => ({
  candidates: [{ name: 'X', kind: 'rss', area: 'region', why: 'причина', ...over }],
});

describe('http поднимается до https, а не выбрасывается', () => {
  it('кандидат с http доходит до переписи', () => {
    const { kept, dropped } = filterCandidates(cand({ url: 'http://kamchatinfo.com/rss.xml' }));
    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(1);
    expect(kept[0].url).toBe('https://kamchatinfo.com/rss.xml');
  });

  it('путь и параметры при подъёме не теряются', () => {
    const { kept } = filterCandidates(cand({ url: 'http://emsd.ru/rss/?lang=ru' }));
    expect(kept[0].url).toBe('https://emsd.ru/rss/?lang=ru');
  });

  it('чужие схемы по-прежнему отбрасываются — и с названной причиной', () => {
    // Поднимать ftp: или file: некуда: это не «схему перепутали», а другой
    // вид адреса.
    const { kept, dropped } = filterCandidates(cand({ url: 'ftp://example.com/feed' }));
    expect(kept).toEqual([]);
    expect(dropped[0].why).toMatch(/схема ftp:/);
  });

  it('прежнего отказа «не https» больше нет', () => {
    expect(SRC).not.toMatch(/why: 'не https'/);
  });
});

describe('несуществующий телеграм-канал назван своим именем', () => {
  it('вердикт различает «канала нет» и «канал молчит»', () => {
    // t.me отдаёт 200 на любое имя, поэтому один лишь код ответа тут не
    // судья — решает признак самой страницы.
    expect(SRC).toMatch(/tgme_page_title\|tgme_channel_info/);
    expect(SRC).toMatch(/ТАКОГО КАНАЛА НЕТ/);
    expect(SRC).toMatch(/канал есть, но постов в превью нет/);
  });

  it('повод записан рядом с кодом', () => {
    expect(SRC).toMatch(/Прогон 3/);
    expect(SRC).toMatch(/модель сочинила имена/);
  });
});

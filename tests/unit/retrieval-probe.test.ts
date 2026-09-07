/**
 * Сторож пробы retrieval Кузьмича (07.09).
 *
 * ── Что случилось ──────────────────────────────────────────────────────────
 *
 * Оценка faithfulness прислала два алерта подряд: 0.0% и 50.0% при пороге 80%,
 * с текстом «возможна деградация или выдуманные факты безопасности». Первая
 * догадка (заглушки водопада вместо ответов) оказалась НЕВЕРНОЙ: в логе
 * прогона ответы полные и хорошие. Верным оказалось другое — `context_len: 0`
 * во всех десяти случаях, и живой факт безопасности при пустом контексте:
 * «статус вулкана сейчас зелёный».
 *
 * Проба существует, чтобы следующий шаг делался по замеру, а не по второй
 * догадке: она гоняет оба пути поиска на одних вопросах и показывает, что
 * вернул каждый.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { orTsQuery } from '@/app/api/cron/retrieval-probe/route';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/retrieval-probe/route.ts'), 'utf8');
const WF = readFileSync(join(process.cwd(), '.github/workflows/retrieval-probe.yml'), 'utf8');

describe('запрос через ИЛИ собирается безопасно', () => {
  it('слова соединяются оператором ИЛИ', () => {
    expect(orTsQuery('Авачинский вулкан сентябрь')).toBe('Авачинский | вулкан | сентябрь');
  });

  it('предлоги и мусор выбрасываются: они только шумят рангом', () => {
    expect(orTsQuery('Иду на Авачинский в сентябре')).toBe('Иду | Авачинский | сентябре');
  });

  it('операторы tsquery не проходят внутрь — иначе to_tsquery падает', () => {
    // Не `plainto_tsquery`: этот разбирает операторы, и посторонний символ
    // роняет запрос целиком.
    const q = orTsQuery('маршрут & (опасно | !риск) : 50м');
    expect(q).not.toMatch(/[&!():]/);
    expect(q).toContain('|');
  });

  it('вопрос без длинных слов даёт null, а не битый запрос', () => {
    expect(orTsQuery('а я и он')).toBeNull();
    expect(orTsQuery('...')).toBeNull();
  });
});

describe('приговор выносит пара чисел, а не одно', () => {
  it('«сейчас пусто» само по себе ничего не доказывает', () => {
    // Пустой контекст может значить и «поиск сломан», и «в базе нечего
    // найти». Различает их только второй путь на том же вопросе.
    expect(SRC).toContain('empty_now');
    expect(SRC).toContain('or_query_finds');
    expect(SRC).toContain('пусты оба пути');
  });

  it('отказ запроса — «не смогли спросить», а не «ничего не нашлось»', () => {
    expect(SRC).toContain("console.error('[retrieval-probe]");
    expect(SRC).toContain("verdict: 'unknown'");
  });
});

describe('проба ничего не меняет', () => {
  it('в базу не пишет', () => {
    expect(SRC).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('секрет сверяется до запросов', () => {
    const secretAt = SRC.indexOf('timingSafeCompare');
    const queryAt = SRC.indexOf('searchPlaceKnowledge(q.question)');
    expect(secretAt).toBeGreaterThan(0);
    expect(secretAt).toBeLessThan(queryAt);
  });

  it('прогон ждёт свою сборку и краснеет, если прод не ответил', () => {
    expect(WF).toContain('run: bash scripts/wait-for-deploy.sh');
    expect(WF).toContain('«не смогли спросить», а не «поиск в порядке»');
  });
});

/**
 * Перепись лент разведки: спрашиваем с прода и не открываем дверь внутрь.
 *
 * ПОВОД (06.09). Тревога назвала мёртвые ленты, и список источников хотелось
 * поправить сразу. Проба с раннера объявила мёртвыми все 13 адресов — но с
 * прода те же отвечают иначе (kamgov 404 против 403, visitkamchatka 200 с
 * HTML против 404): страны режут друг друга. Замер с чужой машины годится
 * для вопроса «не в нашей ли стране дело» и не годится для приговора ленте.
 *
 * Перепись с прода (run 22) показала: ai_tech — 9 живых из 11, competitors —
 * 0 из 2, travel_industry — 0 из 5.
 *
 * Кандидатов проверяем тем же путём и с той же машины. Роут ходит по адресу
 * из параметра — значит без ограничений он стал бы дверью во внутреннюю сеть.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/intel-feeds-census/route.ts'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('перепись только читает', () => {
  it('ни одной записи в базу', () => {
    expect(SRC).not.toMatch(/INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/i);
  });

  it('список источников не прочитан — сказано прямо, а не «лент нет»', () => {
    expect(SRC).toMatch(/ok: null, error: `список источников не прочитан/);
  });

  it('закрыта секретом крона', () => {
    expect(SRC).toMatch(/timingSafeCompare\(getCronSecret\(req\), process\.env\.CRON_SECRET/);
  });
});

describe('проверка кандидатов не открывает дверь внутрь', () => {
  it('только http и https', () => {
    expect(SRC).toMatch(/u\.protocol !== 'https:' && u\.protocol !== 'http:'/);
  });

  it('частные адреса и метаданные отклоняются', () => {
    expect(SRC).toMatch(/PRIVATE_HOST/);
    for (const host of ['localhost', '127\\.', '169\\.254\\.', '192\\.168\\.', 'metadata\\.']) {
      expect(SRC, `${host} не в списке частных`).toContain(host);
    }
  });

  it('учётные данные в адресе не пропускаются', () => {
    expect(SRC).toMatch(/u\.username \|\| u\.password/);
  });

  it('число кандидатов за раз ограничено', () => {
    expect(SRC).toMatch(/MAX_CANDIDATES = 15/);
    expect(SRC).toMatch(/\.slice\(0, MAX_CANDIDATES\)/);
  });

  it('проверка кандидатов тоже ничего не записывает', () => {
    const branch = SRC.slice(SRC.indexOf('candidatesParam'), SRC.indexOf('let rows'));
    expect(branch).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });
});

describe('приговор ленте называет, ЧТО она отдала', () => {
  it('четыре исхода, а не «пусто/не пусто»', () => {
    for (const verdict of ["'feed'", "'empty'", "'not_a_feed'", "'failed'"]) {
      expect(SRC, `нет исхода ${verdict}`).toContain(verdict);
    }
  });

  it('домены без единой живой ленты названы отдельно', () => {
    // Живым считается и лента с записями, и страница, разбор которой дал записи
    // (06.09: у Anthropic ленты нет вовсе, мерка ленты дала бы ему вечное «нет»).
    expect(SRC).toMatch(/alive: own\.filter\(\(f\) => f\.verdict === 'feed' \|\| f\.verdict === 'page'\)\.length/);
    expect(SRC).toMatch(/silent:/);
  });
});

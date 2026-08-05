/**
 * Снятие миграции с повтора — приём с причиной, а не способ спрятать красное.
 *
 * Раннер повторяет непринятые миграции каждый деплой. К 05.08 накопилось 45
 * неудачных попыток на четыре файла, и Watchdog держал их в алерте постоянно.
 * Сторож, который всегда красный, перестают читать — а следующая авария придёт
 * в тот же список.
 *
 * Причины, названные Watchdog поимённо, оказались разными:
 *   • 800 и 806 делают `INSERT INTO partners` без `category`, а колонка NOT NULL
 *     без умолчания — повтор не поможет никогда. Их работу давно сделали 810 и 822;
 *   • 819 падала по типу колонок; её работу делает 824 после 823;
 *   • 796 применилась бы САМА после смены типа и молча переписала бы состав
 *     тура — ровно того владелец и просил не делать.
 *
 * Поэтому запись в `_migrations` без выполнения допустима, но только когда
 * названа причина. Этот сторож требует именно этого: без объяснения приём
 * превращается в способ гасить красное, и тогда мы снова ослепнем.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SQL = readFileSync(
  join(ROOT, 'migrations/825_retire_unappliable_migrations.sql'),
  'utf-8',
);
const comments = SQL.split('\n').filter((l) => /^\s*--/.test(l)).join('\n');
const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

/** Файлы, снятые с повтора этой миграцией. */
const RETIRED = [
  '796_bystraya_tour_content_fields.sql',
  '800_bystraya_tour_force_publish.sql',
  '806_bystraya_tour_consolidate.sql',
  '819_bystraya_tackle_included.sql',
];

describe('снятые с повтора миграции', () => {
  it('каждая названа в коде миграции', () => {
    for (const name of RETIRED) expect(code).toContain(name);
  });

  it('каждая объяснена в комментарии — иначе это сокрытие', () => {
    // Номер файла должен встречаться в пояснении, а не только в INSERT.
    for (const name of RETIRED) {
      const num = name.slice(0, 3);
      expect(comments, `не объяснено, почему снята ${name}`).toMatch(
        new RegExp(`\\b${num}\\b`),
      );
    }
  });

  it('сами файлы остаются в репозитории', () => {
    // Снять с повтора — не значит стереть историю: содержимое 796 ещё нужно.
    for (const name of RETIRED) {
      expect(existsSync(join(ROOT, 'migrations', name)), `${name} исчез`).toBe(true);
    }
  });

  it('запись о падении убирается — алерт должен показывать живое', () => {
    expect(code).toMatch(/DELETE FROM _migration_failures/);
  });

  it('идемпотентна', () => {
    expect(code).toMatch(/ON CONFLICT \(name\) DO NOTHING/);
  });

  it('ничего не выполняет за снятые миграции', () => {
    // Приём — «отметить применённой», а не «сделать вид, что сработало»:
    // подмена содержимого здесь была бы худшим видом молчания.
    expect(code).not.toMatch(/UPDATE\s+operator_tours/i);
    expect(code).not.toMatch(/INSERT INTO partners/i);
  });
});

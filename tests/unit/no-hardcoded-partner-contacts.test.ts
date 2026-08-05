/**
 * Контакты реального партнёра не живут в коде.
 *
 * Ярослав («Камчатка Семейный Рафтинг», 05.08): «я так и не смог выйти на свой
 * телефон, чтобы самому себе позвонить — там левый указан». Номер
 * +7 924 799-01-91 я вписал в миграцию 060 как факт, фактом он никогда не был,
 * и дальше он кочевал по 806, 810 и по коду — в роут `create-tour-demo`,
 * «временный» сидер, который никто не вызывал, но который при первом же запуске
 * на чистой базе воссоздал бы партнёра с чужим телефоном.
 *
 * Это тот же механизм, которым на прод попали «Рога и Копыта»: демо-данные,
 * записанные в коде рядом с настоящим slug партнёра. Роут удалён, а сторож
 * держит границу: реквизиты живого партнёра — в базе, правятся миграцией или
 * кабинетом, и ни один сидер в `app/` не знает их наизусть.
 *
 * Телефоны экстренных служб (112, МЧС) под это правило НЕ подпадают: они
 * обязаны быть в коде, потому что должны работать без сети и без базы.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(rel);
  }
  return acc;
}

const SOURCES = [...walk('app'), ...walk('lib')];

/** Slug'и живых партнёров: их реквизиты приходят из базы, не из кода. */
const REAL_PARTNER_SLUGS = ['kamchatka-rafting', 'kamchatka-fishing'];

/** Заведомо ненастоящие номера: плейсхолдеры в полях форм и на макетах. */
const PLACEHOLDERS = new Set(['+79001234567', '+79000000000']);

/**
 * Осознанные исключения — с причиной и сроком жизни, а не молчаливые.
 *
 * `kamchatka-fishing/tours-data.ts` — та же болезнь у второго партнёра:
 * телефоны, имена контактных лиц и часы работы «Камчатской Рыбалки» лежат в
 * коде и читаются из `/api/ai/smart-search`. Это отдельная работа (перенос
 * витрины партнёра в базу), и делать её заодно с телефоном рафтинга значило бы
 * менять то, о чём не просили. Но исключение записано здесь, чтобы факт не
 * потерялся: пока строка жива, контакты рыбалки тоже могут разойтись с базой —
 * ровно так, как разошёлся телефон рафтинга.
 */
const ALLOWLIST = new Set(['lib/partners/kamchatka-fishing/tours-data.ts']);

describe('реквизиты партнёра — в базе, а не в коде', () => {
  it('ни один сидер не создаёт живого партнёра с зашитыми контактами', () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const src = readFileSync(join(ROOT, file), 'utf-8');
      if (!/INSERT INTO partners/i.test(src)) continue;
      for (const slug of REAL_PARTNER_SLUGS) {
        if (src.includes(`'${slug}'`) || src.includes(`"${slug}"`)) {
          offenders.push(`${file} — сидит партнёра ${slug}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('телефон оператора не вписан в код', () => {
    // Мобильные номера в формате +79XXXXXXXXX. Короткие служебные (112) и
    // городские экстренные под шаблон не попадают — они и должны быть в коде:
    // экстренный контакт обязан работать без сети и без базы.
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (ALLOWLIST.has(file)) continue;
      const src = readFileSync(join(ROOT, file), 'utf-8');
      const hits = (src.match(/\+79\d{9}/g) ?? []).filter((n) => !PLACEHOLDERS.has(n));
      if (hits.length > 0) offenders.push(`${file}: ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('исключения именованы и существуют — иначе список гниёт молча', () => {
    // Мёртвая запись в списке исключений опаснее её отсутствия: она создаёт
    // ощущение, что случай разобран.
    for (const file of ALLOWLIST) {
      expect(SOURCES, `в списке исключений файл, которого нет: ${file}`).toContain(file);
    }
  });
});

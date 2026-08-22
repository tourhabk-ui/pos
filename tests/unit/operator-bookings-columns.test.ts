/**
 * operator_bookings: запрос не ссылается на колонку, которой у таблицы нет.
 *
 * 22.08 снимок боевой базы (GET /api/cron/schema-audit, проба 90) показал у
 * таблицы 47 колонок против 52 объявленных миграциями. Пять расхождений —
 * следы файлов, которые откатились целиком, но записались в `_migrations`
 * как применённые (дефект трекинга, задача #58). Самое дорогое: `user_id`,
 * который перечисляют четыре из семи путей создания брони, — то есть бронь
 * с сайта не создавалась вовсе, а «unapplied: []» в аудите это подтверждало
 * как порядок.
 *
 * Сторож судит по СМЫСЛУ, а не по написанию: собирает объявленные колонки
 * из migrations/ и сверяет с ними каждую ссылку вида `алиас.колонка`, где
 * алиас назначен таблице в том же шаблоне запроса. Отдельный случай —
 * `tour_id`: колонки нет и она НЕ возвращается (дублировала
 * `operator_tour_id`), поэтому ссылка на неё запрещена явно, независимо от
 * того, что объявляет миграция 065.
 *
 * Чего сторож не видит: запросы, собранные из кусков (`${BOOKING_SELECT}
 * WHERE b.user_id = $2`) — в куске с колонкой нет имени таблицы, привязать
 * алиас не к чему. Это пропуск, а не одобрение.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Колонки, объявленные для operator_bookings в migrations/ (CREATE + ADD COLUMN). */
function declaredColumns(): Set<string> {
  const cols = new Set<string>();
  const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const src = readFileSync(join(ROOT, 'migrations', f), 'utf-8');

    const create = src.match(/CREATE TABLE (?:IF NOT EXISTS )?operator_bookings\s*\(([\s\S]*?)\n\);/i);
    if (create) {
      for (const line of create[1].split('\n')) {
        const m = line.trim().match(/^([a-z_]\w*)\s+\w/);
        if (m && !['constraint', 'primary', 'unique', 'foreign', 'check'].includes(m[1].toLowerCase())) {
          cols.add(m[1]);
        }
      }
    }

    for (const alter of src.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?operator_bookings\s+([\s\S]*?);/gi)) {
      for (const add of alter[1].matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_]\w*)/gi)) {
        cols.add(add[1]);
      }
    }
  }
  return cols;
}

/** Шаблонные литералы файла — по ним же и разбирается SQL. */
function templates(src: string): string[] {
  return src.split('`').filter((_, i) => i % 2 === 1);
}

const SOURCES = execSync(`git ls-files 'app/**/*.ts' 'lib/**/*.ts'`, { cwd: ROOT, encoding: 'utf-8' })
  .trim().split('\n').filter(Boolean);

describe('operator_bookings: колонки в запросах', () => {
  const declared = declaredColumns();

  it('миграции объявляют вернувшиеся колонки', () => {
    // Если эти пропадут из migrations/, сверка ниже начнёт краснеть на
    // рабочем коде — а причина будет не в коде.
    for (const c of ['user_id', 'reseller_reference', 'admin_notes', 'operator_tour_id']) {
      expect(declared.has(c), `колонка ${c} должна быть объявлена в migrations/`).toBe(true);
    }
  });

  it('ни один запрос не ссылается на operator_bookings.tour_id', () => {
    // Колонка не существует на проде и не возвращается: смысл несёт
    // operator_tour_id, а вторая колонка того же смысла — будущее расхождение.
    const offenders: string[] = [];
    for (const f of SOURCES) {
      for (const tpl of templates(readFileSync(join(ROOT, f), 'utf-8'))) {
        if (!/\boperator_bookings\b/i.test(tpl)) continue;
        for (const m of tpl.matchAll(/operator_bookings\s+(?:AS\s+)?([a-zA-Z_]\w*)/gi)) {
          const alias = m[1];
          if (/^(on|where|set|values|using|select|join|left|inner|group|order|limit|as|returning)$/i.test(alias)) continue;
          if (new RegExp(`\\b${alias}\\.tour_id\\b`).test(tpl)) offenders.push(`${f} → ${alias}.tour_id`);
        }
      }
    }
    expect(offenders, 'связь брони с туром — operator_tour_id').toEqual([]);
  });

  it('каждая колонка в запросе объявлена миграциями', () => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      for (const tpl of templates(readFileSync(join(ROOT, f), 'utf-8'))) {
        if (!/\boperator_bookings\b/i.test(tpl)) continue;
        for (const m of tpl.matchAll(/operator_bookings\s+(?:AS\s+)?([a-zA-Z_]\w*)/gi)) {
          const alias = m[1];
          if (/^(on|where|set|values|using|select|join|left|inner|group|order|limit|as|returning)$/i.test(alias)) continue;
          for (const ref of tpl.matchAll(new RegExp(`\\b${alias}\\.([a-z_]\\w*)`, 'gi'))) {
            if (!declared.has(ref[1])) offenders.push(`${f} → ${alias}.${ref[1]}`);
          }
        }
      }
    }
    expect([...new Set(offenders)], 'колонки нет ни в одном CREATE/ALTER для operator_bookings').toEqual([]);
  });
});

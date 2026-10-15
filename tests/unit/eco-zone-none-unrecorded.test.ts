// @vitest-environment node
/**
 * «Нет режима» и «разрешение не нужно» без сверки — в «не записано»
 * (15.10, миграция 1290; §4.0 «тип допускает отсутствие»).
 *
 * eco_zone = 'none' не ставил никто, кроме 170, — одним UPDATE всем видимым
 * местам без режима; eco_permit_required = FALSE стояло умолчанием колонки
 * (169). Держится:
 *  - 1290 переводит в NULL только незаписанное рукой: без своих правил и
 *    адреса разрешения;
 *  - умолчание «не нужно» снято: новое место — «не записано»;
 *  - ни одна миграция, кроме 170, не пишет режим «нет» — новое «нет» может
 *    поставить только человек в админке, после сверки (запрет по тексту
 *    миграций: только SET и INSERT, сравнения в WHERE не в счёт);
 *  - карточка о «не записано» молчит так же, как молчала о «нет»: разрешение
 *    «не нужно» она не выводит.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrationBody, migrationStatements } from '../helpers/migration-sql';
import { permitNotRequired } from '@/lib/places/own-permit';

const DIR = join(process.cwd(), 'migrations');
const BODY = migrationBody(readFileSync(join(DIR, '1290_eco_zone_none_unverified_to_unrecorded.sql'), 'utf-8'));
const STATEMENTS = migrationStatements(BODY);

describe('1290: «нет» и «не нужно» без сверки → «не записано»', () => {
  it('«нет» → NULL вместе с «не нужно», только без своих правил и адреса', () => {
    const s = STATEMENTS.find((x) => /WHERE eco_zone = 'none'/.test(x))!;
    expect(s).toMatch(/SET eco_zone = NULL,\s+eco_permit_required = NULL/);
    expect(s).toMatch(/AND eco_rules IS NULL\s+AND eco_permit_url IS NULL/);
  });

  it('«не нужно» без режима → NULL, только без своих правил и адреса', () => {
    const s = STATEMENTS.find((x) => /WHERE eco_zone IS NULL\s+AND eco_permit_required IS FALSE/.test(x))!;
    expect(s).toMatch(/SET eco_permit_required = NULL/);
    expect(s).toMatch(/AND eco_rules IS NULL\s+AND eco_permit_url IS NULL/);
  });

  it('умолчание колонки снято', () => {
    expect(BODY).toMatch(/ALTER TABLE places ALTER COLUMN eco_permit_required DROP DEFAULT;/);
  });
});

describe('режим «нет» пишет только человек', () => {
  it('ни одна миграция, кроме 170, не ставит eco_zone = \'none\' (SET и INSERT)', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(DIR).filter((n) => n.endsWith('.sql'))) {
      if (f.startsWith('170_')) continue;
      for (const stmt of migrationStatements(migrationBody(readFileSync(join(DIR, f), 'utf-8')))) {
        const set = /\bUPDATE\s+places\b[\s\S]*?\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(stmt)?.[1] ?? '';
        if (/\beco_zone\s*=\s*'none'/i.test(set)) offenders.push(`${f}: SET`);
        if (/\bINSERT\s+INTO\s+places\b[^;]*\beco_zone\b/i.test(stmt) && /'none'/.test(stmt)) offenders.push(`${f}: INSERT`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('карточка о «не записано» молчит', () => {
  it('«не требуется» — только при записанном режиме и явном «не нужно»', () => {
    expect(permitNotRequired(null)).toBe(false);
    expect(permitNotRequired({ zone: null, permitRequired: null })).toBe(false);
    expect(permitNotRequired({ zone: 'none', permitRequired: false })).toBe(false);
    expect(permitNotRequired({ zone: 'natural_park', permitRequired: false })).toBe(true);
  });
});

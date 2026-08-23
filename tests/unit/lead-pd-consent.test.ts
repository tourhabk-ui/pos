/**
 * Согласие на обработку ПД у лида: записано, а не подразумевается.
 *
 * Замер 23.08: из девяти форм, отправляющих имя и телефон на /api/leads,
 * галочка стояла на ДВУХ, на трёх была строка «нажимая кнопку, вы
 * соглашаетесь», на четырёх не было ничего. И ни одна из двух галочек до
 * сервера не доходила — согласие жило в браузере и умирало вместе с вкладкой.
 * В таблице leads не было ни одного поля о согласии: имя и телефон собирались,
 * а доказательства права их собирать не существовало нигде.
 *
 * Сторож держит три свойства:
 *  1. форма, отправляющая лид, показывает ОБЩУЮ галочку и шлёт pd_consent;
 *  2. сервер требует ровно `true` и записывает обстоятельства, а не булево;
 *  3. NULL в базе значит «не зафиксировано», а не «отказ» — третье состояние
 *     остаётся отличимым (§4.0 CLAUDE.md).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'tests', 'api']);

function walk(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (name.endsWith('.tsx')) acc.push(full);
  }
}

/** Клиентские файлы, которые POST-ят лид. `api` из обхода исключён — там сервер. */
function leadSenders(): string[] {
  const files: string[] = [];
  walk(join(ROOT, 'app'), files);
  walk(join(ROOT, 'components'), files);
  return files
    .filter((f) => /fetch\(\s*['"`]\/api\/leads['"`]/.test(readFileSync(f, 'utf-8')))
    .map((f) => relative(ROOT, f).split('\\').join('/'))
    .sort();
}

describe('форма лида спрашивает согласие', () => {
  const senders = leadSenders();

  it('форм, отправляющих лид, найдено больше одной — правило есть что проверять', () => {
    expect(senders.length).toBeGreaterThan(1);
  });

  for (const file of leadSenders()) {
    it(`${file}: общая галочка и pd_consent в теле запроса`, () => {
      const src = read(file);
      expect(src, `${file} рисует согласие сам — формулировка разойдётся с остальными`)
        .toMatch(/PdConsentCheckbox/);
      expect(src, `${file} не отправляет согласие на сервер`).toMatch(/pd_consent:\s*true/);
      // Кнопка не должна нажиматься без галочки: гарантия на клиенте, а не
      // только на сервере — иначе человек жмёт и получает отказ.
      expect(src, `${file} не блокирует отправку без согласия`).toMatch(/!pdConsent|!guestConsent/);
    });
  }

  it('своя разметка галочки нигде не осталась', () => {
    for (const file of leadSenders()) {
      const src = read(file);
      expect(src, `${file} держит собственную ссылку на политику рядом с формой`)
        .not.toMatch(/type="checkbox"[\s\S]{0,400}legal\/privacy/);
    }
  });
});

describe('сервер требует согласие и записывает обстоятельства', () => {
  const route = read('app/api/leads/route.ts');
  const create = read('lib/leads/create.ts');
  const legal = read('lib/legal/pd-consent.ts');

  it('Zod требует ровно true, а не «любое значение»', () => {
    expect(route).toMatch(/pd_consent:\s*z\.literal\(true/);
  });

  it('записывается время, адрес, источник и версия формулировки', () => {
    expect(route).toMatch(/buildConsentRecord\(/);
    for (const col of ['pd_consent_at', 'pd_consent_ip', 'pd_consent_source', 'pd_consent_version']) {
      expect(create, `${col} не пишется в leads`).toContain(col);
    }
  });

  it('версия формулировки и текст — в одном месте', () => {
    expect(legal).toMatch(/PD_CONSENT_VERSION/);
    expect(legal).toMatch(/PD_CONSENT_TEXT/);
    const checkbox = read('components/legal/PdConsentCheckbox.tsx');
    expect(checkbox, 'компонент завёл свою формулировку — она разойдётся с записанной')
      .toMatch(/PD_CONSENT_TEXT/);
  });

  it('«не зафиксировано» отличимо от «отказано»', () => {
    // buildConsentRecord возвращает null, а не запись с given=false: строка о
    // согласии либо есть целиком, либо её нет.
    expect(legal).toMatch(/if \(given !== true\) return null;/);
    expect(create).toMatch(/pd_consent\?\.at \?\? null/);
  });
});

describe('миграция', () => {
  const sql = read('migrations/911_leads_pd_consent.sql');

  it('идемпотентна', () => {
    expect((sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/);
  });

  it('лиды без зафиксированного согласия можно отобрать', () => {
    expect(sql).toMatch(/WHERE pd_consent_at IS NULL/);
  });
});

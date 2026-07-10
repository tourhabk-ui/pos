/**
 * Бренд-канон: публичный бренд — «Ведар» (lib/config SITE_NAME).
 * Тест ловит регресс: TourHab/KamchatourHub в публичных метаданных и дубль-суффикс title.
 *
 * Вне scope (осознанно НЕ проверяется):
 *  - app/api/**            — email/telegram/gpx/ical шаблоны (отдельная задача)
 *  - app/legal/**          — тела юрдокументов (правовое решение, не косметика)
 *  - строки с tourhab.ru   — живые URL, миграция домена — отдельная задача
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

function collect(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'api' || name === 'legal' || name === 'node_modules') continue;
      collect(p, acc);
    } else if (/\.(ts|tsx)$/.test(name)) {
      acc.push(p);
    }
  }
  return acc;
}

const files = [...collect(join(ROOT, 'app')), ...collect(join(ROOT, 'components'))];

describe('бренд-канон «Ведар» в публичных поверхностях', () => {
  it('siteName нигде не TourHab/KamchatourHub', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf-8');
      if (/siteName:\s*['"`](TourHab|KamchatourHub)['"`]/.test(src)) offenders.push(f);
    }
    expect(offenders, `siteName с legacy-брендом:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('title не содержит legacy-суффиксов (| TourHab, | KamchatourHub)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const [i, line] of readFileSync(f, 'utf-8').split('\n').entries()) {
        if (!/\btitle\s*[:=]/.test(line)) continue;
        if (/\|\s*(TourHab|KamchatourHub)/.test(line) || /—\s*(TourHab|KamchatourHub)\s*['"`]/.test(line)) {
          offenders.push(`${f}:${i + 1}`);
        }
      }
    }
    expect(offenders, `title с legacy-суффиксом:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('title не заканчивается на "| Ведар" (root layout template доклеит второй — дубль)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const [i, line] of readFileSync(f, 'utf-8').split('\n').entries()) {
        // template в root layout — легитимное место '%s | Ведар'
        if (line.includes("template:")) continue;
        if (/\btitle\s*[:=]/.test(line) && /\|\s*Ведар\s*['"`]/.test(line)) {
          offenders.push(`${f}:${i + 1}`);
        }
      }
    }
    expect(offenders, `title с ручным "| Ведар" (даст дубль):\n${offenders.join('\n')}`).toEqual([]);
  });
});

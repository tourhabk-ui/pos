/**
 * Telegram поддержки — бот Кузьмича @kuzmichai_bot (решение владельца 17.11):
 * в него можно написать. Канал старого имени @kamchatourhub в интерфейсе не
 * встречается нигде — ни контактом поддержки, ни ссылкой на канал (канал
 * новостей — t.me/kamchatka_real). Упоминания в комментариях-истории допустимы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SUPPORT } from '@/lib/help/content';

const ROOT = process.cwd();
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return walk(abs);
    return /\.(ts|tsx)$/.test(name) ? [abs] : [];
  });
}

describe('Telegram поддержки', () => {
  it('SUPPORT.telegram — бот Кузьмича', () => {
    expect(SUPPORT.telegram).toBe('kuzmichai_bot');
  });

  it('кабинет оператора берёт контакт из SUPPORT, а не пишет его руками', () => {
    const src = readFileSync(join(ROOT, 'app/hub/operator/help/_OperatorHelpClient.tsx'), 'utf8');
    expect(src).toMatch(/href=\{`https:\/\/t\.me\/\$\{SUPPORT\.telegram\}`\}/);
  });

  it('kamchatourhub в коде остался только в комментариях', () => {
    const offenders: string[] = [];
    for (const abs of ['app', 'lib', 'components'].flatMap((d) => walk(join(ROOT, d)))) {
      readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
        if (!/kamchatourhub/.test(line)) return;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        offenders.push(`${relative(ROOT, abs)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

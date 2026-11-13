/**
 * Сторож: в скиллах и командах агентов нет непроверенных экстренных телефонов.
 *
 * Сверка инструкций 13.11: справка скилла `trust-first` держала пример кода с
 * двумя региональными номерами «МЧС Камчатского края» и «Горноспасательная
 * служба», которых нет в проверенном списке платформы. Скилл включается при
 * работе над экранами безопасности, и агент вставил бы эти номера в код
 * буквально. Неверный экстренный номер хуже, чем его отсутствие.
 *
 * Правило платформы одно: региональный номер показывается, только если его
 * проверил владелец и он записан в `lib/safety/emergency-numbers.ts`. Этот
 * сторож распространяет правило на то, по чему агент пишет код, — скиллы и
 * команды. Это запрет («этого быть не должно»), поэтому судится текст.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { VERIFIED_REGIONAL, VERIFIED_REFERENCE } from '@/lib/safety/emergency-numbers';

const ROOT = process.cwd();

/** Все текстовые файлы под каталогом. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...filesUnder(rel));
    else if (/\.(md|mjs|js|ts|tsx|json|sh|txt)$/.test(name)) out.push(rel);
  }
  return out;
}

/** Номер с кодом Петропавловска-Камчатского (4152): в любом написании. */
const REGIONAL = /(?:\+7|8)[\s(-]*4152[\s)-]*\d(?:[\s-]*\d){5}/g;
const digits = (s: string) => s.replace(/\D/g, '').replace(/^8/, '7');

const VERIFIED = new Set([...VERIFIED_REGIONAL, ...VERIFIED_REFERENCE].map((n) => digits(n.phone)));

describe('экстренные телефоны в инструкциях агентов', () => {
  const files = [...filesUnder('.claude/skills'), ...filesUnder('.claude/commands')];

  it('каталоги скиллов и команд прочитаны', () => {
    // Пустой обход — отказ, а не «номеров нет».
    expect(files.length).toBeGreaterThan(50);
    expect(VERIFIED.size).toBeGreaterThanOrEqual(3);
  });

  it('региональный номер в скилле или команде — только из проверенного списка', () => {
    const found: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      for (const m of src.matchAll(REGIONAL)) {
        if (!VERIFIED.has(digits(m[0]))) found.push(`${f}: ${m[0].trim()}`);
      }
    }
    expect(found, 'номер не из lib/safety/emergency-numbers.ts — убери его и сошлись на этот файл').toEqual([]);
  });

  it('шаблон узнаёт оба написания, а проверенный номер пропускает', () => {
    const hit = (s: string) => [...s.matchAll(REGIONAL)].map((m) => digits(m[0]));
    expect(hit("phone: '+74152235362'")).toEqual(['74152235362']);
    expect(hit('тел. +7 (4152) 23-53-61,')).toEqual(['74152235361']);
    expect(hit('8 (4152) 30-10-89')).toEqual(['74152301089']);
    expect(VERIFIED.has('74152301089')).toBe(true);
    expect(VERIFIED.has('74152235362')).toBe(false);
  });
});

/**
 * Плоская конфигурация ESLint: набор правил не должен «усохнуть» при переезде.
 *
 * Повод: переход на flat config (ESLint 9 + eslint-config-next 16) — это
 * переписывание конфига с нуля. Такой переезд легко превращается в тихое
 * ослабление: пара правил не доехала, никто не заметил, линтер зелёный.
 *
 * Отдельно сторожим правила эры React Compiler (`react-hooks/*`), приехавшие
 * с пресетом 16. Они дают 167 срабатываний на существующем коде и СОЗНАТЕЛЬНО
 * понижены до `warn`, чтобы подъём версии не тащил за собой рефакторинг
 * экранов безопасности. Разница между `warn` и `off` здесь принципиальная:
 * `warn` держит находки на виду каждый прогон, `off` объявляет, что чисто.
 * Именно этот переход — warn → off — тест и ловит.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CONFIG = readFileSync(join(ROOT, 'eslint.config.mjs'), 'utf-8');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};

/** Правила и их серьёзность из объекта `rules` конфига (без строк-комментариев). */
function declaredRules(): Record<string, string> {
  const code = CONFIG.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  const out: Record<string, string> = {};
  for (const m of code.matchAll(/'([@\w/-]+)':\s*'(error|warn|off)'/g)) out[m[1]] = m[2];
  return out;
}

describe('переезд на flat config ничего не потерял', () => {
  const rules = declaredRules();

  it('старый .eslintrc.json удалён, а не оставлен рядом', () => {
    // Два конфига разом — верный способ править не тот, который читается.
    expect(existsSync(join(ROOT, '.eslintrc.json'))).toBe(false);
  });

  it('шесть переопределений из .eslintrc.json на месте с той же серьёзностью', () => {
    const before: Record<string, string> = {
      'prefer-const': 'error',
      'no-var': 'error',
      'no-console': 'off',
      'no-debugger': 'error',
      'react/display-name': 'warn',
      '@next/next/no-img-element': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
    };
    for (const [rule, severity] of Object.entries(before)) {
      expect(rules[rule], `правило ${rule} потерялось при переезде`).toBe(severity);
    }
  });

  it('пресет next/core-web-vitals подключён', () => {
    expect(CONFIG).toMatch(/eslint-config-next\/core-web-vitals/);
  });
});

describe('правила React Compiler остаются на виду', () => {
  const rules = declaredRules();
  const REACT_HOOKS = [
    'react-hooks/set-state-in-effect',
    'react-hooks/immutability',
    'react-hooks/refs',
    'react-hooks/purity',
    'react-hooks/use-memo',
  ];

  it('ни одно не выключено в off — иначе 167 находок исчезнут молча', () => {
    for (const rule of REACT_HOOKS) {
      expect(rules[rule], `${rule} выключено: находки перестали быть видны`).not.toBe('off');
      expect(['warn', 'error'], `${rule} должно быть warn или error`).toContain(rules[rule]);
    }
  });
});

describe('линтер вызывается напрямую', () => {
  it('скрипт lint не зовёт next lint', () => {
    // `next lint` объявлен устаревшим в Next 15.5 и удалён в Next 16 —
    // прямой вызов eslint переживёт подъём Next без второй правки скрипта.
    expect(PKG.scripts.lint, 'вернулся next lint').not.toMatch(/next\s+lint/);
    expect(PKG.scripts.lint).toMatch(/^eslint\b/);
  });

  it('eslint остаётся на 9: конфиг Next 16 несовместим с ESLint 10', () => {
    // Внутри eslint-config-next 16 лежит eslint-plugin-react, который зовёт
    // context.getFilename() — удалённый в ESLint 10 API. Проверено прогоном:
    // «TypeError: contextOrFilename.getFilename is not a function».
    // Поднимать eslint до 10 можно только вместе с Next 16.
    expect(PKG.dependencies.eslint).toMatch(/\^?9\./);
  });
});

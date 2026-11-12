// @vitest-environment node
/**
 * Чистка копии кода перед ревью безопасности (scripts/review-pii-scrub.mjs).
 *
 * Ревьюер — зарубежная модель, и читает он весь репозиторий (находка ревью
 * PR #3298, 12.11). Телефон и почта человека в коде заменяются плейсхолдером,
 * а то, от чего зависит проверка, — константы, даты, координаты, UUID, версии
 * пакетов, адреса платформы — остаётся как есть: ревьюер судит по ним код.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scrubCode, scrubPaths, PHONE_MARK, EMAIL_MARK } from '../../scripts/review-pii-scrub.mjs';

const clean = (s: string) => scrubCode(s).text;

describe('телефон — по форме номера', () => {
  it.each([
    ['+7 914 782-22-22', PHONE_MARK],
    ['+7-914-782-22-22', PHONE_MARK],
    ['8 (900) 123-45-67', PHONE_MARK],
    ['8-914-992-68-65', PHONE_MARK],
    ['+79147822222', PHONE_MARK],
    ['89001234567', PHONE_MARK],
    ['79147822222', PHONE_MARK],
    ['+44 20 7946 0958', PHONE_MARK],
    ['+86 138 0013 8000', PHONE_MARK],
    ['+7 (4152) 20-01-12', PHONE_MARK],
    ['8 (4152) 30-10-91', PHONE_MARK],
    ['(4152) 20-01-12', PHONE_MARK],
    ['+7 (41531) 2-12-34', PHONE_MARK],
  ])('%s — номер', (input, want) => {
    expect(clean(`тел. ${input}, звоните`)).toBe(`тел. ${want}, звоните`);
  });

  it.each([
    'const at = 1730000000000;',
    'const max = 2147483647;',
    'id = 9876543210123',
    'даты 10-15.08.2026',
    'координаты 53.2551 158.8432',
    'бюджет 150 000 - 200 000',
    "uuid '00000000-0000-4000-8000-0000000c4740'",
    "uuid '0000-4000-8000-000000000001'",
    'sha 3a8f9001234567c',
    'x = a+7 * 100',
    'versions 1.89001234567',
    'бюджет: 80 000–120 000 руб.',
    'Катер на 8-12 чел: 80 000-200 000/рейс',
    'd="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"',
  ])('%s — не номер, остаётся', (input) => {
    expect(clean(input)).toBe(input);
  });

  it.each([
    ['Звоните +7 914 782-22-22.', `Звоните ${PHONE_MARK}.`],
    ['тел. +7-984-160-04-90. Маршруты', `тел. ${PHONE_MARK}. Маршруты`],
    ['номер 89001234567.', `номер ${PHONE_MARK}.`],
    ['+44 20 7946 0958.', `${PHONE_MARK}.`],
  ])('номер в конце предложения — тоже номер (ревью #3304): %s', (input, want) => {
    expect(clean(input)).toBe(want);
  });

  it('перевод строки номер не склеивает: строки на месте', () => {
    const text = 'const a = 8\n914\n123\n45\n67;\n';
    expect(clean(text)).toBe(text);
  });
});

describe('почта — кроме адресов платформы и примеров', () => {
  it('почта человека — плейсхолдер', () => {
    expect(clean("email: 'anna.petrova@gmail.com'")).toBe(`email: '${EMAIL_MARK}'`);
    expect(clean('visit@park-vulcany.ru')).toBe(EMAIL_MARK);
  });

  it.each(['flo@vedarai.ru', 'flo+operator@vedarai.ru', 'anna@tourhab.ru'])(
    '%s — личный ящик на домене платформы тоже заменяется (ревью #3304)',
    (input) => {
      expect(clean(`to: '${input}'`)).toBe(`to: '${EMAIL_MARK}'`);
    },
  );

  it.each([
    'info@vedarai.ru',
    'noreply@mail.vedarai.ru',
    'support@tourhab.ru',
    'user@example.com',
    'bot@max.local',
    'a@b.invalid',
    'postgres://u:p@localhost:5432/db',
    '@anthropic-ai/claude-code@2.1.319',
    'react@18.3.1',
    '@types/node',
  ])('%s — остаётся', (input) => {
    expect(clean(input)).toBe(input);
  });

  it('считает, сколько чего заменено', () => {
    const r = scrubCode('a@mail.ru, +7 914 000-11-22, b@yandex.ru');
    expect(r).toEqual({ text: `${EMAIL_MARK}, ${PHONE_MARK}, ${EMAIL_MARK}`, phones: 1, emails: 2 });
  });
});

describe('обход каталога', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('текст чистится на месте; бинарное, .git и ссылки не трогаются; в выводе — только счётчики', () => {
    dir = mkdtempSync(join(tmpdir(), 'scrub-'));
    mkdirSync(join(dir, 'lib'));
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'lib', 'a.ts'), "export const phone = '+7 914 782-22-22';\n");
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0x2b, 0x37, 0x39, 0x31, 0x34]);
    writeFileSync(join(dir, 'img.png'), bin);
    writeFileSync(join(dir, '.git', 'config'), 'email = dev@mail.ru\n');
    writeFileSync(join(dir, 'outside.txt'), 'dev@mail.ru\n');
    symlinkSync(join(dir, 'outside.txt'), join(dir, 'lib', 'link.txt'));

    const r = spawnSync(process.execPath, ['scripts/review-pii-scrub.mjs', join(dir, 'lib'), join(dir, 'img.png'), join(dir, '.git')], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/изменено 1, телефонов 1, почт 0, не текст 1/);
    expect(r.stdout).not.toContain('914');
    expect(readFileSync(join(dir, 'lib', 'a.ts'), 'utf-8')).toBe(`export const phone = '${PHONE_MARK}';\n`);
    expect(readFileSync(join(dir, 'img.png'))).toEqual(bin);
    expect(readFileSync(join(dir, 'outside.txt'), 'utf-8')).toBe('dev@mail.ru\n');
    expect(readFileSync(join(dir, '.git', 'config'), 'utf-8')).toBe('email = dev@mail.ru\n');
  });

  it('пути нет — отказ, а не «почищено»', () => {
    const r = spawnSync(process.execPath, ['scripts/review-pii-scrub.mjs', join(tmpdir(), 'нет-такого-каталога-scrub')], { encoding: 'utf-8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Чистка копии не удалась/);
  });

  it('без аргументов — отказ', () => {
    expect(spawnSync(process.execPath, ['scripts/review-pii-scrub.mjs'], { encoding: 'utf-8' }).status).toBe(2);
  });

  it('scrubPaths считает файлы', () => {
    dir = mkdtempSync(join(tmpdir(), 'scrub-'));
    writeFileSync(join(dir, 'a.md'), 'нет ничего');
    expect(scrubPaths([dir])).toEqual({ files: 1, changed: 0, phones: 0, emails: 0, skipped: 0 });
  });
});

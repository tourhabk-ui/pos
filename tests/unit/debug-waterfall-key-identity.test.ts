/**
 * tests/unit/debug-waterfall-key-identity.test.ts
 *
 * Диагностика провайдеров говорит, КАКОЙ ключ, а не «ключ есть».
 *
 * ── Что случилось (08.09) ──────────────────────────────────────────────────
 *
 * Владелец сменил ключи, а предупреждения остались теми же: «Qwen недоступен:
 * ключ отвергнут в ОБОИХ регионах», «OpenRouter недоступен с прода». Вопрос
 * простой — доехала ли замена до контейнера, — и ответить на него было нечем:
 * диагностика отдавала булево `present`, одинаковое у старого отвергнутого
 * ключа и у нового.
 *
 * Ключей у нас ДВА комплекта: секреты GitHub для раннера и переменные Timeweb
 * для прода (§8). Правка одного не меняет другой, и «сменил» без указания
 * места — это две разные истории.
 *
 * Отпечаток различает: не совпал с прежним — новый ключ на месте и отвергнут
 * по-настоящему, чинить у провайдера; совпал — замена сюда не дошла, чинить
 * доставку. Раньше обе беды выглядели одинаково.
 *
 * ── Граница ────────────────────────────────────────────────────────────────
 *
 * Отпечаток — 8 hex от SHA-256, ключ по нему не восстановить. Хвоста и
 * префикса ключа в ответе нет: у роута уже была история с выдачей первых 12
 * символов, и возвращать её нельзя.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyIdentity } from '@/lib/ai/key-identity';

const SRC = readFileSync(join(process.cwd(), 'app/api/ai/debug-waterfall/route.ts'), 'utf-8');

describe('ответ различает ключи, а не только их наличие', () => {
  it('в карту ключей идёт отпечаток', () => {
    expect(SRC).toMatch(/fingerprint: id\.fingerprint/);
  });

  it('булевого «задан» одного больше недостаточно', () => {
    // Прежняя строка: `envKeys[k] = !!process.env[k]` — ровно она и не давала
    // отличить новый ключ от старого.
    expect(SRC).not.toMatch(/envKeys\[k\]\s*=\s*!!process\.env/);
  });

  it('место запуска названо: тот же ответ с раннера и с прода — про разные ключи', () => {
    expect(SRC).toMatch(/place: runPlace\(\)/);
  });
});

describe('секрет не утекает', () => {
  it('ни префикса, ни хвоста ключа в ответе нет', () => {
    // История роута: до 01.09 он отдавал первые 12 символов ключа OpenRouter
    // без секрета вовсе. Возврат этого — не регресс диагностики, а утечка.
    const body = SRC.slice(SRC.indexOf('const envKeys'), SRC.indexOf('return NextResponse.json'));
    expect(body).not.toMatch(/slice\(\s*0\s*,\s*\d+\s*\)/);
    expect(body).not.toMatch(/process\.env\[k\]\s*\?\.\s*slice/);
  });

  it('по отпечатку ключ не восстанавливается: он короткий и односторонний', () => {
    const a = keyIdentity('sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const b = keyIdentity('sk-or-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(a.fingerprint).toHaveLength(8);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    // Отпечаток не содержит самого ключа ни куском.
    expect('sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').not.toContain(a.fingerprint as string);
  });

  it('ключа нет — отпечатка нет, а не пустая строка', () => {
    const none = keyIdentity(undefined);
    expect(none.present).toBe(false);
    expect(none.fingerprint).toBeNull();
  });
});

/**
 * Ключ из одних пробелов — это отсутствие ключа, а не ключ.
 *
 * 22.08 отчёт судьи (issue #1338) назвал причину отказа первой ступени:
 * `HTTP 401 {"error":{"message":"Missing Authentication header","code":401}}`.
 * OpenRouter утверждает, что заголовка авторизации НЕТ, — при том что ветка
 * «ключ не задан» не срабатывала, значит переменная непустая. Обе вещи
 * сходятся ровно в одном случае: значение непусто как строка и пусто как
 * ключ. `Bearer ` — заголовок формально есть, авторизации в нём нет.
 *
 * Разница между «ключа нет» и «ключ есть, но не работает» — это разница
 * между минутой и половиной дня: причину искали в релее, гео-блоке и
 * Cloudflare, а она была в форме значения.
 *
 * Форма ключа наружу уходит БЕЗ содержимого: ответ health читают в логах
 * Actions, и ключу там не место.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getOpenRouterKey, getOpenRouterKeySource, describeOpenRouterKey } from '@/lib/ai/provider-config';

const KEYS = ['OR_API_KEY', 'OPENROUTER_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const only = (name: (typeof KEYS)[number], value: string) => {
  for (const k of KEYS) delete process.env[k];
  process.env[name] = value;
};

describe('выдача ключа', () => {
  it('строка из пробелов — не ключ', () => {
    only('OPENROUTER_API_KEY', '   ');
    expect(getOpenRouterKey()).toBeNull();
  });

  it('перевод строки по краям срезается', () => {
    only('OPENROUTER_API_KEY', '\nsk-or-v1-abc\n');
    expect(getOpenRouterKey()).toBe('sk-or-v1-abc');
  });

  it('источник судит по тому же правилу, что и выдача', () => {
    // Иначе диагностика скажет «источник OPENROUTER_API_KEY», а вызов
    // получит null — два несогласных ответа об одном и том же.
    only('OPENROUTER_API_KEY', '  ');
    expect(getOpenRouterKeySource()).toBeNull();
    expect(getOpenRouterKey()).toBeNull();
  });

  it('старый OR_API_KEY по-прежнему главнее', () => {
    for (const k of KEYS) delete process.env[k];
    process.env.OR_API_KEY = 'sk-or-old';
    process.env.OPENROUTER_API_KEY = 'sk-or-new';
    expect(getOpenRouterKey()).toBe('sk-or-old');
    expect(getOpenRouterKeySource()).toBe('OR_API_KEY');
  });
});

describe('форма ключа', () => {
  it('называет длину, начало и пробелы — и ни одного символа ключа', () => {
    only('OPENROUTER_API_KEY', ' sk-or-v1-secret ');
    const shape = describeOpenRouterKey()!;
    expect(shape).toEqual({
      key_len: 'sk-or-v1-secret'.length,
      key_prefix_ok: true,
      key_had_outer_space: true,
      key_has_inner_space: false,
    });
    // Главное свойство: в выдаче нет самого ключа.
    expect(JSON.stringify(shape)).not.toContain('secret');
  });

  it('чужое начало видно, содержимое — нет', () => {
    only('OPENROUTER_API_KEY', 'sk-ant-api03-zzz');
    const shape = describeOpenRouterKey()!;
    expect(shape.key_prefix_ok).toBe(false);
    expect(JSON.stringify(shape)).not.toContain('zzz');
  });

  it('пробел внутри значения виден отдельно от краевого', () => {
    only('OPENROUTER_API_KEY', 'sk-or-v1 abc');
    const shape = describeOpenRouterKey()!;
    expect(shape.key_has_inner_space).toBe(true);
    expect(shape.key_had_outer_space).toBe(false);
  });

  it('переменной нет — формы нет, а не выдуманный ноль', () => {
    for (const k of KEYS) delete process.env[k];
    expect(describeOpenRouterKey()).toBeNull();
  });
});

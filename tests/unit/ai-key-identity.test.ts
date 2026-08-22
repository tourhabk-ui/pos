/**
 * Сторож опознания ключей: отпечаток различает, но не раскрывает.
 *
 * Решение владельца 23.08.2026: ключи провайдеров в секретах GitHub и в
 * переменных Timeweb РАЗНЫЕ намеренно — «чтоб я сам понимал, откуда какой
 * работает». Платформа этому не помогала: и раннер, и прод отвечали одинаковым
 * «не ответил ни один провайдер».
 *
 * Здесь две вещи разом: что опознание работает и что оно НЕ протекает. Ключ в
 * логе, отчёте или на экране — это утечка секрета, а отпечаток нужен именно
 * там, где его увидят люди.
 *
 * Вторая половина теста — про границу поверхностей. Ключ GitHub чинит одно,
 * ключ Timeweb другое, и путать их дорого: 23.08 владелец обновил ключ в
 * секретах, а разведчик от этого не ожил бы — его AI-вызов идёт на проде.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  keyIdentity, runPlace, keyReport, formatKeyLine, TRACKED_KEYS,
} from '@/lib/ai/key-identity';

const WF = (f: string) => readFileSync(join(process.cwd(), '.github/workflows', f), 'utf8');

describe('keyIdentity: различает, не раскрывая', () => {
  // Фикстура собирается из кусков намеренно: целый литерал формата OpenRouter
  // ловится push protection GitHub и блокирует пуш — сканер не может отличить
  // выдуманный ключ от настоящего, и это правильно. Проверять же надо именно
  // поведение на строке такого вида.
  const KEY = `sk-${'or'}-v1-${'0123456789abcdef'.repeat(4)}`;

  it('два разных ключа дают разные отпечатки', () => {
    const a = keyIdentity(KEY);
    const b = keyIdentity(`${KEY}X`);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('один и тот же ключ — один и тот же отпечаток', () => {
    expect(keyIdentity(KEY).fingerprint).toBe(keyIdentity(KEY).fingerprint);
  });

  it('отпечаток НЕ содержит ни куска ключа', () => {
    const id = keyIdentity(KEY);
    expect(id.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    // Ни одна восьмёрка символов ключа не должна встретиться в отпечатке.
    for (let i = 0; i + 8 <= KEY.length; i++) {
      expect(id.fingerprint).not.toBe(KEY.slice(i, i + 8));
    }
  });

  it('строка из пробелов — НЕ заданный ключ', () => {
    // 09.08 значение из пробелов выглядело как заданное и стоило дня разбора.
    const id = keyIdentity('   ');
    expect(id.present).toBe(false);
    expect(id.fingerprint).toBeNull();
    expect(id.length).toBe(0);
  });

  it('пустое и отсутствующее — одинаково честно', () => {
    expect(keyIdentity(undefined).present).toBe(false);
    expect(keyIdentity(null).present).toBe(false);
    expect(keyIdentity('').present).toBe(false);
  });

  it('формат распознаётся, а нераспознанный не выдумывается', () => {
    expect(keyIdentity(KEY).format).toBe('sk-or-v1-');
    expect(keyIdentity('sk-ant-abc').format).toBe('sk-ant-');
    expect(keyIdentity('произвольная-строка').format).toBeNull();
  });

  it('строка отчёта не содержит ключа', () => {
    const line = formatKeyLine(
      { id: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY', identity: keyIdentity(KEY) },
      'github-actions',
    );
    expect(line).toContain(keyIdentity(KEY).fingerprint!);
    expect(line).not.toContain(KEY);
    expect(line).not.toContain(KEY.slice(-8));
    expect(line).not.toContain(KEY.slice(9, 25));
  });

  it('модуль нигде не отдаёт хвост ключа наружу', () => {
    // Соблазн «показать последние 4 символа» — самый частый способ утечки.
    const src = readFileSync(join(process.cwd(), 'lib/ai/key-identity.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    expect(src).not.toMatch(/\.slice\(\s*-\d/);
    expect(src).not.toMatch(/substr\(/);
  });
});

describe('runPlace: откуда спросили', () => {
  it('раннер GitHub опознаётся', () => {
    expect(runPlace({ GITHUB_ACTIONS: 'true' } as NodeJS.ProcessEnv)).toBe('github-actions');
  });
  it('прод опознаётся', () => {
    expect(runPlace({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe('prod');
  });
  it('неизвестное место так и называется — не выдаётся за локальное', () => {
    expect(runPlace({} as NodeJS.ProcessEnv)).toBe('unknown');
  });
});

describe('keyReport: снимок по всем отслеживаемым ключам', () => {
  it('отдаёт строку на каждый ключ реестра', () => {
    const rows = keyReport({} as NodeJS.ProcessEnv);
    expect(rows).toHaveLength(TRACKED_KEYS.length);
    expect(rows.every(r => r.identity.present === false)).toBe(true);
  });
});

describe('граница ключей: какая поверхность чем спрашивает', () => {
  it('разведчик зовёт ПРОД — значит работает ключом Timeweb', () => {
    // Обновление ключа в секретах GitHub разведчика не оживит: его AI-вызов
    // исполняется на vedarai.ru, а туда секреты репозитория не попадают.
    const wf = WF('cron-scout-digest.yml');
    expect(wf).toMatch(/https:\/\/vedarai\.ru\/api\/cron\/scout-digest/);
    expect(wf, 'если сюда когда-нибудь передадут ключ — правило выше сломается')
      .not.toMatch(/OPENROUTER_API_KEY/);
  });

  it('судья эволюции идёт НА РАННЕРЕ — значит работает ключом GitHub', () => {
    const wf = WF('evo-judge.yml');
    expect(wf).toMatch(/OPENROUTER_API_KEY:\s*\$\{\{\s*secrets\.OPENROUTER_API_KEY\s*\}\}/);
    expect(wf).toMatch(/npx tsx scripts\/evo-judge\.ts/);
  });
});

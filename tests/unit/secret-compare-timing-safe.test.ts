/**
 * Секрет не сравнивается обычным равенством.
 *
 * ── Почему это не педантизм ────────────────────────────────────────────────
 *
 * `a !== b` для строк выходит из цикла на ПЕРВОМ различии. Разница во времени
 * ответа мала, но измерима, и по ней секрет подбирается посимвольно: сначала
 * первый знак, потом второй. Для ключа из тридцати двух символов это тысяча
 * запросов вместо астрономического перебора.
 *
 * На платформе есть готовые постоянные по времени сравнения —
 * `verifyCronSecret` (lib/auth/cron) и `timingSafeCompare`
 * (lib/security/timing-safe), — и большинство маршрутов ими пользуется.
 *
 * ── Почему это не поймал прежний страж ─────────────────────────────────────
 *
 * `lib/agents/evo/static-checks` считает признаком защиты само УПОМИНАНИЕ
 * `CRON_SECRET`. То есть наивное сравнение засчитывалось как защита — страж
 * подтверждал ровно ту строку, которая и была дырой.
 *
 * Находки эволюции называли это трижды («небезопасное сравнение секрета»,
 * «слабая проверка cron-секрета», «утечка секрета в сравнении») в двух
 * дайджестах, 16.08 и 18.08. Оба разбора вышли «модель не ответила», и
 * находки пролежали неразобранными.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

function sources(): string[] {
  const out = execSync("git ls-files 'app/**/*.ts' 'lib/**/*.ts'", { encoding: 'utf-8', cwd: process.cwd() });
  return out.split('\n').filter(Boolean).filter((f) => !f.includes('/tests/'));
}

/**
 * Сравнение секретной переменной окружения обычным равенством.
 *
 * Секретными считаются переменные с этими словами в имени — они и есть то,
 * по чему пускают внутрь.
 */
const SECRET_ENV = /(SECRET|TOKEN|API_KEY|PASSWORD)/;
const COMPARISON = /(===|!==)/;

function naiveSecretCompares(src: string): string[] {
  const bad: string[] = [];
  src.split('\n').forEach((line, i) => {
    const code = line.split('//')[0];
    if (!COMPARISON.test(code)) return;
    if (!/process\.env\.\w*/.test(code)) return;
    const envName = code.match(/process\.env\.(\w+)/)?.[1] ?? '';
    if (!SECRET_ENV.test(envName)) return;
    // Проверки «задана ли переменная» безопасны: сравнение не с секретом.
    if (/(===|!==)\s*(undefined|null|''|""|'1'|"1"|'true'|"true")/.test(code)) return;
    if (/typeof\s+process\.env/.test(code)) return;
    bad.push(`${i + 1}: ${line.trim()}`);
  });
  return bad;
}

describe('секреты сравниваются постоянным временем', () => {
  it('сторож ловит ровно те формы, что были в коде', () => {
    expect(naiveSecretCompares("if (auth !== `Bearer ${process.env.CRON_SECRET}`) {").length).toBe(1);
    expect(naiveSecretCompares("if (!secret || secret !== process.env.CRON_SECRET) {").length).toBe(1);
    expect(naiveSecretCompares("const ok = cronSecret === process.env.CRON_SECRET;").length).toBe(1);
  });

  it('и не трогает законные проверки наличия', () => {
    expect(naiveSecretCompares("if (process.env.CRON_SECRET === undefined) return;")).toEqual([]);
    expect(naiveSecretCompares("if (process.env.NODE_ENV === 'production') {}")).toEqual([]);
    expect(naiveSecretCompares("if (verifyCronSecret(req)) {}")).toEqual([]);
  });

  it('в исходниках таких сравнений нет', () => {
    const bad: string[] = [];
    for (const f of sources()) {
      for (const hit of naiveSecretCompares(readFileSync(f, 'utf-8'))) bad.push(`${f}:${hit}`);
    }
    expect(
      bad,
      'сравнивать секрет через verifyCronSecret (lib/auth/cron) или timingSafeCompare (lib/security/timing-safe)',
    ).toEqual([]);
  });
});

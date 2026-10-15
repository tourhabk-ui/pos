/**
 * Запрет: X-Forwarded-For читается руками только там, где это названо
 * (P3-02 аудита 15.10).
 *
 * Уязвимость подделки адреса разобрана 29.09 и описана в lib/rate-limit.ts,
 * но починена адресно — и рядом жили самописные чтения заголовка, три из них
 * в обратном порядке (XFF раньше x-real-ip). Каждое новое такое чтение —
 * новое место, где клиент сам называет свой адрес. Порядок один и живёт в
 * одном файле: `getTrustedClientIp` / `getTrustedClientIpOrNull`.
 *
 * Регулярка здесь — запрет («этого быть не должно», §4), не проверка
 * поведения: поведение трёх переведённых роутов держит
 * `trusted-ip-writers.test.ts` вызовом.
 *
 * Список ниже может только сокращаться: файл из списка перестал читать
 * заголовок — тест требует убрать запись (как `KNOWN_UNPRODUCED`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** Кто читает заголовок сам и почему. */
const ALLOWED: Record<string, string> = {
  'lib/rate-limit.ts': 'единственное место доверенного порядка и старый getClientIp (часть 2 P3-02 — после замера пробой client-ip-headers-probe)',
  'lib/security/client-ip-headers.ts': 'проба описывает заголовки как они пришли — родами и флагами, без значений',
  'middleware.ts': '§7 НЕ ТРОГАТЬ: Edge-лимит Upstash, порядок уже доверенный',
  'app/api/safety/sos/route.ts': '§7: SOS только через staging; ключ лимита анонима — отдельный разбор P1-01',
  'app/api/carrier-trips/route.ts': 'порядок уже доверенный (x-real-ip первым), переписан руками; перевести на getTrustedClientIp при следующем касании',
  'app/api/push/subscribe/route.ts': 'порядок уже доверенный (x-real-ip первым), переписан руками; перевести на getTrustedClientIp при следующем касании',
};

const READS_XFF = /\.get\(\s*['"`]x-forwarded-for['"`]\s*\)/i;

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const files = [
  ...['app', 'lib', 'components', 'hooks'].flatMap((d) => walk(join(ROOT, d))),
  join(ROOT, 'middleware.ts'),
];
const readers = files
  .filter((f) => READS_XFF.test(stripComments(readFileSync(f, 'utf-8'))))
  .map((f) => relative(ROOT, f))
  .sort();

describe('X-Forwarded-For руками — только в названных местах', () => {
  it('нет новых самописных чтений заголовка', () => {
    const extra = readers.filter((f) => !(f in ALLOWED));
    expect(extra, 'адрес клиента — через getTrustedClientIp / getTrustedClientIpOrNull из lib/rate-limit').toEqual([]);
  });

  it('список разрешённых самоустаревает', () => {
    const stale = Object.keys(ALLOWED).filter((f) => !readers.includes(f));
    expect(stale, 'файл больше не читает заголовок — убери его из ALLOWED').toEqual([]);
  });

  it('у каждого разрешения названа причина', () => {
    for (const [f, why] of Object.entries(ALLOWED)) expect(why.length, f).toBeGreaterThan(20);
  });
});

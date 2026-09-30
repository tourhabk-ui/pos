/**
 * Путь к API MAX — lib/max/max-fetch.ts.
 *
 * С 03.08 по 30.09 прод не отправил в MAX ни одного сообщения: сертификат
 * platform-api2.max.ru выдан УЦ Минцифры, которого нет в хранилище Node.
 * Сторож держит связку целиком: корень тот самый (сверен со вторым
 * источником — промежуточным сертификатом, который отдаёт сам MAX), доверие
 * ему не выходит за адреса MAX, и ни один вызов MAX не идёт мимо модуля.
 */
import { describe, it, expect } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  RUSSIAN_TRUSTED_ROOT_CA, RUSSIAN_TRUSTED_ROOT_CA_SHA256, RUSSIAN_TRUSTED_SUB_CA, isMaxHost, maxFetch,
} from '@/lib/max/max-fetch';

const root = process.cwd();

function sources(dir: string, acc: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, acc);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) acc.push(full);
  }
  return acc;
}
const code = [...sources(join(root, 'app'), []), ...sources(join(root, 'lib'), [])]
  .map((f) => ({ file: relative(root, f), src: readFileSync(f, 'utf-8') }));

describe('корень Минцифры', () => {
  const rootCert = new X509Certificate(RUSSIAN_TRUSTED_ROOT_CA);
  const sub = new X509Certificate(RUSSIAN_TRUSTED_SUB_CA);

  it('отпечаток совпадает с записанным', () => {
    expect(rootCert.fingerprint256).toBe(RUSSIAN_TRUSTED_ROOT_CA_SHA256);
    expect(rootCert.subject).toContain('Russian Trusted Root CA');
  });

  it('им подписан промежуточный сертификат, который отдаёт сам platform-api2.max.ru', () => {
    expect(sub.issuer).toBe(rootCert.subject);
    expect(sub.verify(rootCert.publicKey)).toBe(true);
  });
});

describe('доверие не выходит за MAX', () => {
  it('адреса MAX — только max.ru и его поддомены', () => {
    expect(isMaxHost('platform-api2.max.ru')).toBe(true);
    expect(isMaxHost('max.ru')).toBe(true);
    expect(isMaxHost('evilmax.ru')).toBe(false);
    expect(isMaxHost('max.ru.evil.com')).toBe(false);
    expect(isMaxHost('api.telegram.org')).toBe(false);
  });

  it('чужой адрес и http отвергаются, а не уходят с расширенным доверием', async () => {
    await expect(maxFetch('https://api.telegram.org/x')).rejects.toThrow(/только https:\/\/\*\.max\.ru/);
    await expect(maxFetch('http://platform-api2.max.ru/me')).rejects.toThrow(/только https/);
  });

  it('проверка TLS нигде не отключается ради MAX и хранилище Node не расширяется глобально', () => {
    const mod = readFileSync(join(root, 'lib/max/max-fetch.ts'), 'utf-8');
    expect(mod).not.toMatch(/rejectUnauthorized/);
    expect(mod).toMatch(/ca: \[\.\.\.tls\.rootCertificates, RUSSIAN_TRUSTED_ROOT_CA\]/);
    const global = code.filter(({ src }) => /NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|setGlobalDispatcher/.test(src));
    expect(global.map((g) => g.file)).toEqual([]);
  });
});

describe('ни один вызов MAX не идёт мимо модуля', () => {
  it('клиент библиотеки создаётся только через maxBot', () => {
    const direct = code.filter(({ file, src }) => file !== 'lib/max/max-fetch.ts' && /new Bot\(/.test(src));
    expect(direct.map((d) => d.file)).toEqual([]);
  });

  it('прямые запросы к platform-api2.max.ru — только maxFetch', () => {
    // Смотрим сам вызов: адрес MAX или MAX_API_BASE в первых строках аргументов
    // обычного fetch. Соседние fetch к Telegram и RSS в тех же файлах законны.
    const bad: string[] = [];
    for (const { file, src } of code) {
      if (file === 'lib/max/max-fetch.ts') continue;
      for (const m of src.matchAll(/(?<![A-Za-z])fetch\(/g)) {
        const args = src.slice(m.index ?? 0, (m.index ?? 0) + 200);
        if (/platform-api2?\.max\.ru|MAX_API_BASE/.test(args)) bad.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

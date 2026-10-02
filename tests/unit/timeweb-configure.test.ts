/**
 * Сторож воркфлоу настройки Timeweb (timeweb-configure.yml, 02.10).
 *
 * Правка облачных ресурсов делается с раннера по маркеру, и у неё три
 * правила, каждое из которых держится здесь, а не абзацем:
 *  - маркер в репозитории лежит в dry: файл, забытый в apply, однажды уехал бы
 *    правкой сам (тот же урок, что у images-repack);
 *  - удаления (слово владельца 02.10 «удаляй IP, файрволы и ключи через
 *    API») идут одной дверью `remove()`: только в apply, только по явной
 *    задаче, и только над непривязанным — свободный IP, группа без ресурсов,
 *    дубль ключа; привязанное не трогается никогда;
 *  - запись идёт через одну дверь `write()`, которая в dry печатает план и
 *    не зовёт API.
 * Домен берётся из маркера, а не вписан в воркфлоу: сторож
 * marker-waits-for-deploy читает слово vedarai.ru в коде воркфлоу как вызов
 * прода, а здесь это запрос к api.timeweb.cloud.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const WF = read('.github/workflows/timeweb-configure.yml');
const MARKER = JSON.parse(read('.github/triggers/timeweb-configure.json')) as {
  mode?: string; domain?: string; app_id?: number; tasks?: string[];
};
const CODE = WF.replace(/^[ \t]*#.*$/gm, '');

describe('timeweb-configure: маркер', () => {
  it('в репозитории лежит в dry и называет домен и приложение', () => {
    expect(MARKER.mode ?? 'dry').toBe('dry');
    expect(MARKER.domain).toBe('vedarai.ru');
    expect(MARKER.app_id).toBe(198048);
    expect(Array.isArray(MARKER.tasks)).toBe(true);
  });
  it('запускается правкой маркера в main', () => {
    expect(CODE).toMatch(/paths:\s*\n\s*- '\.github\/triggers\/timeweb-configure\.json'/);
  });
});

describe('timeweb-configure: воркфлоу', () => {
  it('удаление — одной дверью remove(), DELETE больше нигде, PATCH нет вовсе', () => {
    expect(CODE).toMatch(/def remove\(label, path\):/);
    expect(CODE).toMatch(/api\('DELETE', path\)/);
    expect((CODE.match(/['"]DELETE['"]/g) ?? []).length).toBe(1);
    expect(CODE).not.toMatch(/['"]PATCH['"]/);
    // Привязанное не трогается: удаление только при отсутствии привязки/ресурсов/дубля.
    expect(CODE).toMatch(/if not bound:\s*\n\s*remove\(/);
    expect(CODE).toMatch(/if n == 0:\s*\n\s*remove\(/);
    expect(CODE).toMatch(/for k in keys\[:-1\]:\s*\n\s*remove\(/);
  });
  it('запись — одной дверью write(), и в dry она не зовёт API', () => {
    expect(CODE).toMatch(/def write\(label, path, body=None\):/);
    expect((CODE.match(/if not APPLY:\s*\n\s*planned\.append\(label\)/g) ?? []).length).toBe(2);
    expect(CODE).toMatch(/api\('POST', path, body\)/);
    // Прямых POST мимо write() нет.
    expect(CODE).not.toMatch(/api\('POST', f'/);
  });
  it('умолчание режима — dry', () => {
    expect(CODE).toMatch(/MODE = marker\.get\('mode', 'dry'\)/);
    expect(CODE).toMatch(/APPLY = MODE == 'apply'/);
  });
  it('домен не вписан в воркфлоу — берётся из маркера', () => {
    expect(CODE).not.toMatch(/vedarai\.ru/);
    expect(CODE).toMatch(/DOMAIN = marker\['domain'\]/);
  });
  it('токен только из секретов и не печатается', () => {
    expect(CODE).toMatch(/TIMEWEB_TOKEN: \$\{\{ secrets\.TIMEWEB_TOKEN \}\}/);
    expect(CODE).not.toMatch(/print\([^)]*TOKEN/);
  });
  it('привязка www — A-запись с app_id по адресу v2', () => {
    expect(CODE).toMatch(/\/api\/v2\/domains\/\{target\}\/dns-records/);
    expect(CODE).toMatch(/'app_id': APP_ID/);
    expect(CODE).toMatch(/\/api\/v1\/domains\/\{DOMAIN\}\/subdomains\/www/);
  });
});

describe('www.vedarai.ru сводится к канону (next.config.js)', () => {
  it('редирект на vedarai.ru по host и x-forwarded-host, корень и путь, постоянный', () => {
    const cfg = read('next.config.js');
    const rules = cfg.match(/value: 'www\\\\\.vedarai\\\\\.ru'/g) ?? [];
    expect(rules.length).toBe(4);
  });
});

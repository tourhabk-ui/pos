/**
 * Сторож воркфлоу настройки Timeweb (timeweb-configure.yml, 02.10).
 *
 * Правка облачных ресурсов делается с раннера по маркеру, и у неё три
 * правила, каждое из которых держится здесь, а не абзацем:
 *  - маркер в репозитории лежит в dry: файл, забытый в apply, однажды уехал бы
 *    правкой сам (тот же урок, что у images-repack);
 *  - воркфлоу только ДОБАВЛЯЕТ — ни одного DELETE в нём нет по построению;
 *    освобождение IP, снос групп файрвола и ключей необратимы и делаются
 *    владельцем в панели;
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
  it('только добавляет: ни одного DELETE и ни одного PATCH', () => {
    expect(CODE).not.toMatch(/['"]DELETE['"]/);
    expect(CODE).not.toMatch(/['"]PATCH['"]/);
  });
  it('запись — одной дверью write(), и в dry она не зовёт API', () => {
    expect(CODE).toMatch(/def write\(label, path, body=None\):/);
    expect(CODE).toMatch(/if not APPLY:\s*\n\s*planned\.append\(label\)/);
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

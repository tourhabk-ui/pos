/**
 * Разделы хаба: у каждого объявлен гейт, и реестры Edge не указывают в пустоту.
 *
 * ── Повод (26.09) ─────────────────────────────────────────────────────────
 *
 * Владелец прислал таблицу «раздел — путь — роль» и попросил проверить все
 * роли. Роли сошлись, а реестры Edge — нет, и расходились они молча:
 *
 *  - `PUBLIC_HUB_PATHS` держал '/hub/transfer'. Каталога с таким именем нет:
 *    кабинет перевозчика назван '/hub/carrier' (02.09). Пока рядом жил
 *    `app/hub/transfer-operator`, запись делала ВЕСЬ кабинет перевозчика
 *    публичным на Edge — сверка шла простым `startsWith` без разделителя;
 *  - `API_ROLE_REQUIREMENTS` держал '/api/transfer' и '/api/transfer-operator'
 *    при полном отсутствии таких роутов. Правило, нацеленное в пустоту, не
 *    защищает ничего и при чтении выглядит защитой;
 *  - тип `AuthRole` не знал ролей 'stay' и 'gear', хотя обе живые. На Edge они
 *    не значились ни в одном правиле, и `normalizeRole` отвечал о них null —
 *    молчание читалось как «такой роли нет» (§4.0).
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 * Не список ролей (он в `ROLE_HUB`), а СВЯЗКУ: объявление против диска.
 * Запись реестра обязана указывать на существующий путь, кабинет роли —
 * объявлять свою роль, публичный раздел — не требовать входа. Сторож, который
 * проверял бы только текст реестра, зеленел бы ровно тогда, когда реестр
 * оторвался от кода.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_HUB } from '@/lib/auth/role-routes';

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), 'utf-8');
const MW = read('middleware.ts');
/** Комментарии вырезаны: в них прежние записи разобраны намеренно. */
const MW_CODE = MW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Значения массива-литерала из middleware по имени константы. */
function literalList(name: string): string[] {
  const m = MW_CODE.match(new RegExp(`const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`не найден список ${name}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

/** Ключи карты API_ROLE_REQUIREMENTS. */
function apiRoleKeys(): string[] {
  const at = MW_CODE.indexOf('API_ROLE_REQUIREMENTS');
  const open = MW_CODE.indexOf('{', at);
  const close = MW_CODE.indexOf('};', open);
  return [...MW_CODE.slice(open, close).matchAll(/'([^']+)'\s*:/g)].map(x => x[1]);
}

/** Путь /hub/... или /api/... → существует ли он на диске. */
function routeExists(urlPath: string): boolean {
  const dir = join(root, 'app', urlPath.replace(/^\//, ''));
  if (existsSync(dir)) return true;
  // Динамический сегмент: /api/foo/[id] лежит как каталог со скобками.
  const parts = urlPath.replace(/^\//, '').split('/');
  const parent = join(root, 'app', ...parts.slice(0, -1));
  if (!existsSync(parent)) return false;
  return readdirSync(parent).some(e => e.startsWith('[') || e === parts[parts.length - 1]);
}

describe('публичные разделы хаба — существуют и не требуют входа', () => {
  const publicPaths = literalList('PUBLIC_HUB_PATHS');

  it('список не пуст и состоит из путей /hub/...', () => {
    expect(publicPaths.length).toBeGreaterThan(0);
    for (const p of publicPaths) expect(p.startsWith('/hub/')).toBe(true);
  });

  it('каждая запись указывает на существующий раздел', () => {
    const dead = publicPaths.filter(p => !routeExists(p));
    expect(dead, `запись ведёт в пустоту: ${dead.join(', ')}`).toEqual([]);
  });

  it('публичный раздел не объявляет роль — иначе он не публичный', () => {
    for (const p of publicPaths) {
      const layout = join(root, 'app', p.replace(/^\//, ''), 'layout.tsx');
      if (!existsSync(layout)) continue;
      expect(readFileSync(layout, 'utf-8'), `${p}: публичный раздел требует роль`)
        .not.toMatch(/requiredRole/);
    }
  });

  it('сверка публичных путей сегментная, а не по началу строки', () => {
    // startsWith без разделителя открыл бы и '/hub/safety-drafts'.
    expect(MW_CODE).toMatch(/PUBLIC_HUB_PATHS\.some\(p => isPathMatch\(pathname, p\)\)/);
  });
});

describe('карта «префикс API → роль» не указывает в пустоту', () => {
  const keys = apiRoleKeys();

  it('карта не пуста', () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  it('каждый префикс существует в app/api', () => {
    const dead = keys.filter(k => !routeExists(k));
    expect(dead, `правило на несуществующий префикс: ${dead.join(', ')}`).toEqual([]);
  });

  it('удалённого модуля трансфера в карте нет', () => {
    expect(keys).not.toContain('/api/transfer');
    expect(keys).not.toContain('/api/transfer-operator');
  });
});

describe('Edge знает все роли, у которых есть кабинет', () => {
  it('каждая роль из ROLE_HUB распознаётся normalizeRole', () => {
    // ROLE_HUB — единая карта «роль → кабинет». Роль, которой Edge не знает,
    // получает null и любое роль-правило для неё недостижимо.
    const known = MW_CODE.slice(MW_CODE.indexOf('const allowedRoles'));
    const listed = [...known.slice(0, known.indexOf(']')).matchAll(/'([^']+)'/g)].map(x => x[1]);
    const missing = Object.keys(ROLE_HUB).filter(r => !listed.includes(r));
    expect(missing, `Edge не знает роль: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('кабинет роли объявляет свою роль', () => {
  /** Разделы хаба, кроме публичных и служебных файлов. */
  const sections = readdirSync(join(root, 'app/hub'), { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  const publicNames = literalList('PUBLIC_HUB_PATHS').map(p => p.replace('/hub/', ''));

  it('разделы найдены', () => {
    expect(sections.length).toBeGreaterThan(5);
  });

  it('у каждого непубличного раздела в layout стоит requiredRole', () => {
    const naked = sections
      .filter(s => !publicNames.includes(s))
      .filter(s => {
        const layout = join(root, 'app/hub', s, 'layout.tsx');
        return !existsSync(layout) || !readFileSync(layout, 'utf-8').includes('requiredRole');
      });
    expect(naked, `раздел без объявленной роли: ${naked.join(', ')}`).toEqual([]);
  });

  it('роль каждого кабинета ведёт на него же по ROLE_HUB', () => {
    // Иначе человек с этой ролью войдёт и будет отправлен в другой кабинет —
    // ровно то, что случилось с перевозчиком до 02.09 (роль вела на 404).
    for (const [role, hub] of Object.entries(ROLE_HUB)) {
      expect(routeExists(hub), `${role}: кабинет ${hub} не существует`).toBe(true);
    }
  });
});

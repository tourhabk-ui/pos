/**
 * Сторож: экран «Клиенты» есть в каждом кабинете партнёра (CRM #2325, 1а-2).
 *
 * Клиент партнёра заводится хуками на шести источниках; без экрана он —
 * запись, которую партнёр не видит. Здесь держится связка: страница рендерит
 * общий экран, пункт меню ведёт на неё, исключения названы причиной и сами
 * устаревают, когда причина уходит.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Кабинет → своя причина, если экрана CRM в нём (пока) нет. */
const KNOWN_WITHOUT_SCREEN: Readonly<Record<string, string>> = {
  agent:
    'клиенты агента остаются в agent_clients до разговора с владельцем (ответ «обсудим потом», #2325 вопрос 5)',
};

const CABINETS = ['operator', 'guide', 'stay', 'gear', 'carrier', 'agent'] as const;

describe('экран «Клиенты» в кабинетах партнёров', () => {
  for (const cab of CABINETS) {
    if (cab in KNOWN_WITHOUT_SCREEN) continue;
    it(`${cab}: страница рендерит общий экран CRM и не индексируется`, () => {
      const page = read(`app/hub/${cab}/clients/page.tsx`);
      expect(page).toMatch(/import \{ ContactsScreen \} from '@\/components\/crm\/ContactsScreen'/);
      expect(page).toMatch(/<ContactsScreen \/>/);
      expect(page).toMatch(/robots: 'noindex, nofollow'/);
    });

    it(`${cab}: пункт «Клиенты» в меню кабинета`, () => {
      expect(read(`app/hub/${cab}/layout.tsx`)).toMatch(new RegExp(`href: '/hub/${cab}/clients',\\s+label: 'Клиенты'`));
    });
  }

  for (const cab of CABINETS) {
    // Задачи (1в) — во всех шести, без исключений: задача без клиента — общее
    // дело кабинета, ей экран «Клиенты» не нужен.
    it(`${cab}: экран «Задачи» и пункт меню рядом с «Клиентами»`, () => {
      const page = read(`app/hub/${cab}/tasks/page.tsx`);
      expect(page).toMatch(/import \{ TasksScreen \} from '@\/components\/crm\/TasksScreen'/);
      expect(page).toMatch(/<TasksScreen \/>/);
      expect(page).toMatch(/robots: 'noindex, nofollow'/);
      expect(read(`app/hub/${cab}/layout.tsx`)).toMatch(new RegExp(`href: '/hub/${cab}/tasks',\\s+label: 'Задачи'`));
    });
  }

  it('исключения названы причиной и не пережили её', () => {
    for (const [cab, reason] of Object.entries(KNOWN_WITHOUT_SCREEN)) {
      expect(reason.length, cab).toBeGreaterThan(40);
      const page = `app/hub/${cab}/clients/page.tsx`;
      // Экран CRM появился — убрать из исключений.
      expect(existsSync(join(ROOT, page)) && /ContactsScreen/.test(read(page)), `${cab}: экран CRM уже есть — убрать из KNOWN_WITHOUT_SCREEN`).toBe(false);
    }
  });
});

describe('экран CRM по правилам дизайн-системы', () => {
  const files = readdirSync(join(ROOT, 'components', 'crm')).map((n) => `components/crm/${n}`);

  it('без хардкода цвета, font-black, rounded-2xl и эмодзи', () => {
    for (const f of files) {
      const src = read(f);
      // Номера issue в комментариях («#2325») — не цвет.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(code, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, f).not.toMatch(/\bfont-black\b|\brounded-2xl\b|\btext-white\b|\bbg-white\b/);
      expect(src, f).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('данные клиента — только из API CRM, и адреса — в одном месте', () => {
    // Любой /api-литерал в экране — один из адресов CRM_API или задач.
    const literals = files.flatMap((f) => [...read(f).matchAll(/['`](\/api\/[^'`$?]*)/g)].map((m) => `${f}: ${m[1]}`));
    expect(literals.length).toBeGreaterThanOrEqual(3);
    for (const l of literals) expect(l).toMatch(/^components\/crm\/api\.ts: \/api\/(hub|admin)\/crm\/contacts$|^components\/crm\/api\.ts: \/api\/hub\/crm\/(tasks|contacts\/export)$/);
    // А fetch зовёт только через CRM_API / CRM_TASKS_API — своего адреса мимо карты нет.
    const fetches = files.flatMap((f) => [...read(f).matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => `${f}: ${m[1]}`));
    expect(fetches.length).toBeGreaterThan(0);
    for (const call of fetches) expect(call).toMatch(/: (`\$\{)?(CRM_API(\[mode\]|\.partner(?!\w))|CRM_TASKS_API(?!\w)|CRM_EXPORT_API(?!\w))/);
    // Выгрузка — только партнёрская: у администратора кнопки нет.
    expect(read('components/crm/ContactsScreen.tsx')).toMatch(/\{!isAdmin && \(\s*<div className="flex items-center gap-2">\s*<button\s+type="button"\s+onClick=\{\(\) => void exportCsv\(\)\}/);
    // Задачи — только партнёрские: администратору адреса задач экран не даёт.
    expect(read('components/crm/ContactPanel.tsx')).toMatch(/\{!readOnly && \(\s*<section className="space-y-2" aria-label="Задачи">/);
  });

  it('администратор видит клиентов всех партнёров и ничего не правит', () => {
    const page = read('app/hub/admin/clients/page.tsx');
    expect(page).toMatch(/<ContactsScreen mode="admin" \/>/);
    expect(page).toMatch(/robots: 'noindex, nofollow'/);
    expect(read('app/hub/admin/layout.tsx')).toMatch(/href: '\/hub\/admin\/clients',\s+label: 'Клиенты партнёров'/);
    // Запись в карточке — только партнёрским адресом и только не в режиме admin.
    const panel = read('components/crm/ContactPanel.tsx');
    expect(panel).toMatch(/if \(readOnly\) return false;/);
    expect(panel).toMatch(/method: 'PATCH'/);
    expect(panel).not.toMatch(/CRM_API\.admin|CRM_API\[mode\]\}\/\$\{encodeURIComponent\(contactId\)\}`, \{\s*method/);
    // Ручного клиента администратор не заводит: форма — только у партнёра.
    expect(read('components/crm/ContactsScreen.tsx')).toMatch(/\{adding && !isAdmin && \(/);
  });

  it('экран CRM монтируется только в кабинетах за входом (app/hub)', () => {
    // На этом держится запись components/crm в PROTECTED_COMPONENT_DIRS
    // сторожа public-fetch-edge: импорт с публичной страницы сделал бы её
    // клиентом личного API, который Edge режет гостю молча.
    const walk = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
      const rel = `${dir}/${e.name}`;
      return e.isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
    });
    const importers = [...walk('app'), ...walk('components'), ...walk('lib')]
      .filter((f) => !f.startsWith('components/crm/'))
      .filter((f) => /from '@\/components\/crm\//.test(read(f)));
    expect(importers.length).toBeGreaterThan(0);
    for (const f of importers) expect(f, f).toMatch(/^app\/hub\//);
  });

  it('диалоги — с ловушкой фокуса, а не одним aria-modal', () => {
    for (const f of files.filter((x) => /aria-modal/.test(read(x)))) {
      expect(read(f), f).toMatch(/useModalDialog\(/);
    }
  });
});

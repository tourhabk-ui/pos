/**
 * Старые адреса живут строкой в next.config, а не папкой в app/.
 *
 * Перепись страниц 01.10 нашла девять папок, в которых page.tsx делал ровно
 * одно — redirect() на новый адрес. Папка ради редиректа — это роут в сборке,
 * строка в переписи и место, где следующий автор решит, что «страница есть».
 * Правило next.config отвечает 308 до роутера и не выглядит страницей.
 *
 * Та же перепись: /marketplace и /marketplace/tours/[id] уже редиректили в
 * next.config (правило `/marketplace/:path*`), а их page.tsx лежали мёртвыми —
 * до них не доходил ни один запрос, держали их только тесты. Компонент
 * карточки тура переехал к единственной странице, которая его рендерит.
 *
 * Сторож держит связку целиком: правило есть, папки нет. Вернуть папку —
 * красный; убрать правило — красный.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CONFIG = readFileSync(join(ROOT, 'next.config.js'), 'utf-8');

/** Старый адрес → куда ведёт; папка в app/, которой больше не должно быть. */
const LEGACY: ReadonlyArray<{ source: string; destination: string; dir: string }> = [
  { source: '/auth/register-operator', destination: '/operators/join',          dir: 'app/auth/register-operator' },
  { source: '/hub/operator/register',  destination: '/operators/join',          dir: 'app/hub/operator/register' },
  { source: '/cart',                   destination: '/hub/tourist/cart',        dir: 'app/cart' },
  { source: '/hub/tourist/eco-points', destination: '/hub/tourist/loyalty',     dir: 'app/hub/tourist/eco-points' },
  { source: '/hub/agent/leads',        destination: '/hub/agent/clients',       dir: 'app/hub/agent/leads' },
  { source: '/hub/admin/leads/:id',    destination: '/hub/operator/leads/:id',  dir: 'app/hub/admin/leads/[id]' },
  { source: '/kuzmich/hub',            destination: '/',                        dir: 'app/kuzmich/hub' },
  { source: '/on-route',               destination: '/planning?mode=trail',     dir: 'app/on-route' },
  { source: '/routes/detail/:id',      destination: '/routes/:id',              dir: 'app/routes/detail' },
  { source: '/marketplace/:path*',     destination: '/catalog/:path*',          dir: 'app/marketplace' },
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('старые адреса: правило в next.config, папки в app/ нет', () => {
  for (const { source, destination, dir } of LEGACY) {
    it(`${source} → ${destination}`, () => {
      const rule = new RegExp(`source:\\s*'${esc(source)}',\\s*destination:\\s*'${esc(destination)}',\\s*permanent:\\s*true`);
      expect(CONFIG, `нет правила для ${source}`).toMatch(rule);
      expect(existsSync(join(ROOT, dir)), `${dir} должна быть удалена: адрес обслуживает next.config`).toBe(false);
    });
  }

  it('карточка тура живёт у единственной страницы, которая её рендерит', () => {
    expect(existsSync(join(ROOT, 'app/catalog/tours/[id]/_TourDetailClient.tsx'))).toBe(true);
    const page = readFileSync(join(ROOT, 'app/catalog/tours/[id]/page.tsx'), 'utf-8');
    expect(page).toMatch(/from '\.\/_TourDetailClient'/);
  });

  it('листинг операторов живёт у /operators', () => {
    expect(existsSync(join(ROOT, 'app/operators/_OperatorsClient.tsx'))).toBe(true);
    const page = readFileSync(join(ROOT, 'app/operators/page.tsx'), 'utf-8');
    expect(page).toMatch(/from '\.\/_OperatorsClient'/);
  });
});

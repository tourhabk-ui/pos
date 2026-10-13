/**
 * Сторож меню кабинета оператора для команды (CRM фаза 2г).
 *
 * Меню — удобство, а не защита: деньги и настройки закрывает сервер
 * (сторож operator-team-gates). Здесь держится связка меню с этим реестром:
 *   - layout строит меню только из OPERATOR_MENU через menuForSeat;
 *   - менеджеру не попадают пункты владельца и «пока закрытые», скидки —
 *     только с правом цен; «не узнали» — полное меню, как до команды;
 *   - «пока закрыто» (later) обязано опираться на роут со старым поиском
 *     кабинета: переведут роут в шаге 2г-2 — сторож потребует открыть пункт;
 *   - открытый менеджеру экран, который зовёт роут владельца, прячет этот
 *     блок от менеджера (isManagerSeat), а не показывает ему 403.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { OPERATOR_MENU, menuForSeat, type OperatorMenuItem } from '@/components/operator/operator-menu';
import { parseOperatorSeat, type OperatorSeat } from '@/hooks/use-operator-seat';
import { GATES, ROOT, apiUrlsIn, read, resolveRoute, sourceFiles } from '../helpers/operator-gates';

const labels = (items: OperatorMenuItem[]) => items.map(i => i.label);
const manager = (can_edit_prices: boolean): OperatorSeat => ({
  state: 'ok', kind: 'manager', perms: { can_edit_prices, can_cancel_bookings: false },
});

/** Файлы экрана пункта меню: каталог страницы без вложенных экранов других пунктов. */
function screenFiles(href: string): string[] {
  const dir = `app${href}`;
  const nested = OPERATOR_MENU.map(i => `app${i.href}/`).filter(d => d !== `${dir}/` && d.startsWith(`${dir}/`));
  const own = sourceFiles(dir).filter(f => !nested.some(n => f.startsWith(n)));
  // Обзор — корень кабинета: только его собственные файлы и виджеты Dashboard.
  if (href === '/hub/operator') {
    return [...own.filter(f => !f.slice(dir.length + 1).includes('/')), ...sourceFiles('components/operator/Dashboard')];
  }
  return own;
}

function seatsOf(href: string): string[] {
  const seats = new Set<string>();
  for (const url of apiUrlsIn(screenFiles(href))) {
    const file = resolveRoute(url);
    const gate = file ? GATES[file] : undefined;
    if (gate) seats.add(gate.seat);
  }
  return [...seats];
}

describe('меню кабинета оператора и команда', () => {
  it('layout строит меню только из OPERATOR_MENU через menuForSeat', () => {
    const layout = read('app/hub/operator/layout.tsx');
    expect(layout).toMatch(/sidebarItems=\{menuForSeat\(OPERATOR_MENU, seat\)\}/);
    expect(layout).toMatch(/const seat = useOperatorSeat\(\);/);
    expect(layout).not.toMatch(/\{\s*href:\s*'/);
  });

  it('у каждого пункта есть страница', () => {
    const missing = OPERATOR_MENU.filter(i => !existsSync(join(ROOT, `app${i.href}`, 'page.tsx'))).map(i => i.href);
    expect(missing).toEqual([]);
  });

  it('владельцу, пока место не узнано, и при сбое — полное меню, как до команды', () => {
    const all = labels(OPERATOR_MENU);
    expect(labels(menuForSeat(OPERATOR_MENU, { state: 'ok', kind: 'owner', perms: { can_edit_prices: true, can_cancel_bookings: true } }))).toEqual(all);
    expect(labels(menuForSeat(OPERATOR_MENU, { state: 'loading' }))).toEqual(all);
    expect(labels(menuForSeat(OPERATOR_MENU, { state: 'unknown' }))).toEqual(all);
    expect(all).toContain('Команда');
  });

  it('менеджеру — без денег, настроек и «пока закрытого»; скидки только с правом цен', () => {
    const bare = menuForSeat(OPERATOR_MENU, manager(false));
    const withPrices = menuForSeat(OPERATOR_MENU, manager(true));
    expect(bare.every(i => i.access === 'team')).toBe(true);
    expect(labels(bare)).not.toContain('Скидки');
    expect(labels(withPrices)).toContain('Скидки');
    for (const hidden of ['Финансы', 'Аналитика', 'Отчёты', 'Интеграции', 'Профиль', 'Команда']) {
      expect(labels(withPrices), hidden).not.toContain(hidden);
    }
  });

  it('ответ /me разбирается строго: неполный — «не узнали», а не менеджер', () => {
    expect(parseOperatorSeat({ success: true, data: { kind: 'manager', perms: { can_edit_prices: false, can_cancel_bookings: true } } }))
      .toEqual({ state: 'ok', kind: 'manager', perms: { can_edit_prices: false, can_cancel_bookings: true } });
    expect(parseOperatorSeat({ success: true, data: { kind: 'manager' } })).toEqual({ state: 'unknown' });
    expect(parseOperatorSeat({ success: false, error: 'Профиль оператора не найден' })).toEqual({ state: 'unknown' });
    expect(parseOperatorSeat(null)).toEqual({ state: 'unknown' });
  });

  it('«пока закрыто» опирается на роут со старым поиском кабинета', () => {
    const unjustified = OPERATOR_MENU
      .filter(i => i.access === 'later')
      .filter(i => !seatsOf(i.href).includes('legacy'))
      .map(i => `${i.label}: ${seatsOf(i.href).join(', ') || 'роутов не найдено'}`);
    expect(unjustified, 'роут переведён на общий резолвер — откройте пункт команде').toEqual([]);
  });

  it('открытый менеджеру экран прячет от него блоки владельца', () => {
    const leaking: string[] = [];
    let checked = 0;
    for (const item of OPERATOR_MENU.filter(i => i.access === 'team' || i.access === 'can_edit_prices')) {
      const files = screenFiles(item.href);
      for (const block of files) {
        const ownerCalls = [...apiUrlsIn([block])].filter(url => {
          const file = resolveRoute(url);
          return file !== null && GATES[file]?.seat === 'owner';
        });
        if (ownerCalls.length === 0) continue;
        // Блок владельца — отдельный компонент; каждое место, где его рисуют,
        // стоит под условием «не менеджер». Хук, вызванный рядом, — не защита.
        const base = block.split('/').pop()!.replace(/\.tsx?$/, '');
        const importers = files
          .map(f => ({ f, src: read(f) }))
          .map(({ f, src }) => ({ f, src, name: new RegExp(`import (\\w+) from '\\./${base}'`).exec(src)?.[1] }))
          .filter((x): x is { f: string; src: string; name: string } => Boolean(x.name));
        if (importers.length === 0) {
          leaking.push(`${item.label}: ${block} зовёт ${ownerCalls.join(', ')} сам — вынесите блок в компонент под условием`);
          continue;
        }
        for (const { f, src, name } of importers) {
          const uses = src.match(new RegExp(`<${name}\\b`, 'g'))?.length ?? 0;
          const guarded = src.match(new RegExp(`\\{\\s*!\\s*(?:manager|isManagerSeat\\([^)]*\\))\\s*&&\\s*(?:\\(\\s*)?<${name}\\b`, 'g'))?.length ?? 0;
          checked += uses;
          if (uses === 0 || guarded !== uses) leaking.push(`${item.label}: <${name}> в ${f} — ${guarded} из ${uses} под условием «не менеджер»`);
        }
      }
    }
    expect(leaking).toEqual([]);
    expect(checked, 'блоки владельца на открытых экранах найдены').toBeGreaterThan(1);
  });
});

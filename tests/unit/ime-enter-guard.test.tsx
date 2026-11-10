// @vitest-environment jsdom
/**
 * tests/unit/ime-enter-guard.test.tsx
 *
 * Набор иероглифа — не команда (lib/ui/ime, разбор meta/astryx 10.11).
 * Китайский турист выбирает иероглиф клавишей Enter, и браузер шлёт этот
 * Enter обычным keydown. До 10.11 23 поля по нему отправляли недописанное
 * сообщение. Что держит:
 *  - признак: isComposing и запасной keyCode 229;
 *  - рендер: чат спасателя и поиск на Enter во время набора молчат, обычный
 *    Enter работает как раньше;
 *  - запрет: обработчик Enter без isImeKeyEvent и onKeyPress — красные.
 */
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { isImeKeyEvent } from '@/lib/ui/ime';
import RescueChat from '@/components/safety/RescueChat';
import { GlobalSearchModal } from '@/components/search/GlobalSearchModal';

const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalScrollTo = Element.prototype.scrollTo;
beforeAll(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() { /* jsdom: прокрутки нет */ };
  Element.prototype.scrollTo = function scrollTo() { /* jsdom: прокрутки нет */ } as typeof Element.prototype.scrollTo;
});
afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
  Element.prototype.scrollTo = originalScrollTo;
});
afterEach(() => { cleanup(); push.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('признак набора', () => {
  it('isComposing — набор; keyCode 229 — набор; обычный Enter и Escape — нет', () => {
    expect(isImeKeyEvent({ isComposing: true })).toBe(true);
    expect(isImeKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeKeyEvent({ keyCode: 13 })).toBe(false);
    expect(isImeKeyEvent({ keyCode: 27 })).toBe(false);
    expect(isImeKeyEvent({})).toBe(false);
  });
});

describe('чат спасателя: Enter во время набора не отправляет', () => {
  it('набор — ответа нет и поле не очищено; обычный Enter — отправлено', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('нет сети')));
    render(<RescueChat surface="sos" />);
    fireEvent.click(screen.getByRole('button', { name: /AI Спасатель/ }));
    const field = screen.getByLabelText('Опишите ситуацию') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Мы заблудились' } });

    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
    expect(screen.queryByText(/3 свистка подряд/)).toBeNull();
    expect(field.value).toBe('Мы заблудились');

    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText(/3 свистка подряд/)).toBeTruthy();
  });
});

describe('поиск: Enter во время набора не переходит', () => {
  it('набор — перехода нет; обычный Enter — в каталог по набранному', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: [] }) }));
    render(<GlobalSearchModal />);
    act(() => { window.dispatchEvent(new Event('open-search')); });
    const input = await screen.findByLabelText('Что ищем');
    fireEvent.change(input, { target: { value: '堪察加' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true });
    expect(push).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith(`/catalog?search=${encodeURIComponent('堪察加')}`);
  });
});

describe('запрет: Enter-команда без проверки набора', () => {
  const ROOT = process.cwd();
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx$/.test(name)) files.push(p);
    }
  };
  for (const d of ['app', 'components', 'hooks']) walk(join(ROOT, d));

  /** Обработчик, в котором стоит проверка: строка Enter или начало обработчика выше неё. */
  function guarded(lines: string[], at: number): boolean {
    for (let i = at; i >= Math.max(0, at - 30); i--) {
      if (lines[i].includes('isImeKeyEvent(')) return true;
      if (i < at && /onKeyDown=|KeyboardEvent/.test(lines[i])) return false;
    }
    return false;
  }

  it('каждая проверка `key === \'Enter\'` стоит за isImeKeyEvent', () => {
    const bare: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (/key\s*===?\s*['"]Enter['"]/.test(l) && !guarded(lines, i)) bare.push(`${relative(ROOT, f)}:${i + 1}`);
      });
    }
    expect(bare).toEqual([]);
  });

  it('onKeyPress не используется: устарел и по-разному ведёт себя при наборе', () => {
    const used = files.filter((f) => /onKeyPress=/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
    expect(used).toEqual([]);
  });
});

// @vitest-environment jsdom
/**
 * tests/unit/overlay-stack.test.tsx
 *
 * Слои поверх экрана — одна стопка (lib/ui/overlay-stack, hooks/use-modal-dialog;
 * контракт «overlay dismissal» из meta/astryx, разбор владельца 10.11).
 * До правки 12 окон из 17 не закрывались по Escape и не держали фокус, а
 * Escape во вложенном окне закрывал оба. Что держит — рендером:
 *  - одно нажатие Escape — один слой, верхний;
 *  - Escape во время набора иероглифа и Escape, который забрало содержимое, —
 *    ничего не закрывают;
 *  - «нельзя закрыть сейчас» (идёт отправка) — Escape поглощён, окно стоит;
 *  - фокус уходит в окно, Tab держит его в верхнем окне, после закрытия фокус
 *    возвращается на кнопку;
 *  - настоящие слои: просмотр фото поверх карточки землетрясения, поиск;
 *  - запрет: role="dialog" без общего правила и свой обработчик Escape —
 *    красные.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import React, { useRef, useState } from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/image', () => ({
  default: (props: { src: string; alt: string }) => React.createElement('img', { src: props.src, alt: props.alt }),
}));

import { useModalDialog, useOverlayEscape } from '@/hooks/use-modal-dialog';
import { overlayDepth } from '@/lib/ui/overlay-stack';
import { PhotoLightbox } from '@/components/shared/PhotoLightbox';
import { QuakeCard } from '@/components/map/QuakeCard';
import { GlobalSearchModal } from '@/components/search/GlobalSearchModal';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Окно с кнопкой-открывателем; `busy` — «нельзя закрыть сейчас». */
function Modal({ name, children, busy = false }: { name: string; children?: React.ReactNode; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useModalDialog(ref, () => setOpen(false), () => !busy, open);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Открыть {name}</button>
      {open && (
        <div ref={ref} role="dialog" aria-modal="true" aria-label={name}>
          <button type="button">Первая в {name}</button>
          {children}
          <button type="button">Последняя в {name}</button>
        </div>
      )}
    </>
  );
}

const esc = (init: Partial<KeyboardEventInit> & { keyCode?: number } = {}) => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', ...init });

describe('стопка: одно нажатие — один слой', () => {
  it('вложенное окно закрывается одно; второй Escape — нижнее', () => {
    render(<Modal name="карточка"><Modal name="фото" /></Modal>);
    fireEvent.click(screen.getByText('Открыть карточка'));
    fireEvent.click(screen.getByText('Открыть фото'));
    expect(screen.getAllByRole('dialog')).toHaveLength(2);

    esc();
    expect(screen.queryByRole('dialog', { name: 'фото' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'карточка' })).toBeTruthy();

    esc();
    expect(screen.queryAllByRole('dialog')).toHaveLength(0);
    expect(overlayDepth()).toBe(0);
  });

  it('Escape во время набора иероглифа и уже забранный содержимым — не закрывают', () => {
    render(<Modal name="окно" />);
    fireEvent.click(screen.getByText('Открыть окно'));
    esc({ isComposing: true });
    esc({ keyCode: 229 });
    const inner = screen.getByText('Первая в окно');
    inner.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    fireEvent.keyDown(inner, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'окно' })).toBeTruthy();
    esc();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('модальное окно запирает прокрутку страницы, закрытое — возвращает прежнюю', () => {
    document.body.style.overflow = 'auto';
    render(<Modal name="окно" />);
    fireEvent.click(screen.getByText('Открыть окно'));
    expect(document.body.style.overflow).toBe('hidden');
    esc();
    expect(document.body.style.overflow).toBe('auto');
    document.body.style.overflow = '';
  });

  it('Escape, посланный прямо в window, тоже доходит до стопки', () => {
    render(<Modal name="окно" />);
    fireEvent.click(screen.getByText('Открыть окно'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('идёт отправка — Escape поглощён, окно стоит', () => {
    render(<Modal name="заявка" busy />);
    fireEvent.click(screen.getByText('Открыть заявка'));
    esc();
    expect(screen.getByRole('dialog', { name: 'заявка' })).toBeTruthy();
  });
});

describe('фокус', () => {
  it('уходит в окно, Tab кружит в верхнем, после закрытия — на кнопку', () => {
    render(<Modal name="окно" />);
    const opener = screen.getByText('Открыть окно');
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'окно' });
    expect(dialog.contains(document.activeElement)).toBe(true);

    const last = screen.getByText('Последняя в окно');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('Первая в окно'));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    esc();
    expect(document.activeElement).toBe(opener);
  });

  it('два соседних окна: Tab кружит только в верхнем, нижнее фокус к себе не тянет', () => {
    render(<><Modal name="заявка" /><Modal name="фото" /></>);
    fireEvent.click(screen.getByText('Открыть заявка'));
    fireEvent.click(screen.getByText('Открыть фото'));
    const last = screen.getByText('Последняя в фото');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('Первая в фото'));
  });

  it('немодальная карточка: Escape закрывает, Tab свободен', () => {
    function Card() {
      const [open, setOpen] = useState(true);
      const ref = useRef<HTMLDivElement>(null);
      useOverlayEscape(open, () => setOpen(false), ref);
      return open ? <div ref={ref} role="dialog" aria-label="точка"><button type="button">в карточке</button></div> : null;
    }
    render(<><button type="button">на карте</button><Card /></>);
    const btn = screen.getByText('в карточке');
    btn.focus();
    fireEvent.keyDown(btn, { key: 'Tab' });
    expect(document.activeElement).toBe(btn); // jsdom сам не двигает фокус — главное, что хук не перехватил Tab
    esc();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('настоящие слои', () => {
  const QUAKE = { id: 'q1', magnitude: 4.2, depth: 30, place: 'у Петропавловска', time: new Date().toISOString(), lat: 53, lng: 159 } as unknown as Parameters<typeof QuakeCard>[0]['quake'];

  it('просмотр фото поверх карточки землетрясения: Escape закрывает только просмотр', () => {
    function Map() {
      const [quake, setQuake] = useState(true);
      const [photo, setPhoto] = useState(true);
      return (
        <>
          {quake && <QuakeCard quake={QUAKE} onClose={() => setQuake(false)} />}
          {photo && <PhotoLightbox images={['/a.jpg', '/b.jpg']} alt="Вулкан" startIdx={0} onClose={() => setPhoto(false)} />}
        </>
      );
    }
    render(<Map />);
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    esc();
    expect(screen.queryByRole('dialog', { name: /Вулкан: фото/ })).toBeNull();
    expect(screen.getByRole('dialog', { name: /Землетрясение M4\.2/ })).toBeTruthy();
    esc();
    expect(screen.queryAllByRole('dialog')).toHaveLength(0);
  });

  it('поиск: открывается событием, Escape закрывает, во время набора — нет', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: [] }) }));
    render(<GlobalSearchModal />);
    act(() => { window.dispatchEvent(new Event('open-search')); });
    await screen.findByRole('dialog', { name: 'Поиск по платформе' });
    esc({ isComposing: true });
    expect(screen.getByRole('dialog', { name: 'Поиск по платформе' })).toBeTruthy();
    esc();
    expect(screen.queryByRole('dialog', { name: 'Поиск по платформе' })).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('запрет: слой мимо общего правила', () => {
  const ROOT = process.cwd();
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx$/.test(name)) files.push(p);
    }
  };
  for (const d of ['app', 'components']) walk(join(ROOT, d));
  const rel = (f: string) => relative(ROOT, f);

  /**
   * Слои, которым Escape не положен, — с причиной. Список может только
   * сокращаться: новый слой встаёт в стопку.
   */
  const NO_ESCAPE: Record<string, string> = {
    'components/legal/ThirdPartyScripts.tsx': 'баннер согласия: закрыть его можно только выбором — «принять» или «отказаться»',
  };

  it('каждый role="dialog" стоит на useModalDialog или useOverlayEscape', () => {
    const bare = files
      .filter((f) => /role="dialog"/.test(readFileSync(f, 'utf8')))
      .filter((f) => !/use(ModalDialog|OverlayEscape)\(/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .filter((f) => !(f in NO_ESCAPE));
    expect(bare).toEqual([]);
  });

  it('список исключений не устарел: каждое исключение ещё рисует role="dialog"', () => {
    for (const f of Object.keys(NO_ESCAPE)) {
      expect(readFileSync(join(ROOT, f), 'utf8')).toMatch(/role="dialog"/);
    }
  });

  /** Свой Escape — только в другом документе (iframe, скрипт на сайте партнёра). */
  const OWN_ESCAPE: Record<string, string> = {
    'app/widget/lead-form/[slug]/page.tsx': 'форма живёт в iframe на сайте партнёра: Escape закрывает iframe у родителя, стопки там нет',
  };

  it('свой обработчик Escape — только в другом документе', () => {
    const own = files
      .filter((f) => /key === ['"]Escape['"]/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .filter((f) => !(f in OWN_ESCAPE));
    expect(own).toEqual([]);
  });
});

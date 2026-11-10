'use client';

/**
 * Слой поверх экрана по правилам доступности. Два хука, одна стопка
 * (lib/ui/overlay-stack, контракт «overlay dismissal» из meta/astryx):
 *
 * `useModalDialog` — модальное окно (`aria-modal="true"`): фокус внутрь при
 * открытии, Escape закрывает, Tab не уходит на страницу под затемнением,
 * прокрутка страницы стоит, после закрытия фокус возвращается туда, откуда
 * окно открыли. Тот же приём, что у формы запроса мест
 * (components/planner/SeatRequestForm.tsx), вынесенный для диалогов CRM и
 * с 10.11 — для всех окон.
 *
 * `useOverlayEscape` — немодальный слой (карточка на карте, шторка, баннер,
 * который можно закрыть): Escape закрывает, фокус возвращается, а Tab и
 * прокрутка страницы свободны — страница под ним живая.
 *
 * Оба встают в одну стопку: одно нажатие Escape закрывает только верхний
 * слой (снимок поверх карточки закрывается один, карточка остаётся), Escape
 * во время набора иероглифа отменяет набор, а не закрывает окно, а Escape,
 * который уже забрало содержимое (`preventDefault`), стопка не трогает.
 *
 * `aria-modal` без ловушки фокуса — обещание без исполнителя: скринридер
 * верит, что за окном ничего нет, а Tab туда уводит.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { focusablesIn, overlayTop, pushOverlay, type OverlayEntry } from '@/lib/ui/overlay-stack';

/** Вернуть фокус открывшему элементу, если он ещё на странице, а фокус потерян. */
function restoreFocus(opener: HTMLElement | null, root: HTMLElement | null): void {
  if (!opener || !opener.isConnected) return;
  const active = document.activeElement;
  const lost = !active || active === document.body || (root !== null && (root.contains(active) || !root.isConnected));
  if (lost) opener.focus();
}

/**
 * Модальное окно. Хук живёт, пока окно на экране: открытое окно —
 * смонтированный компонент. `canClose` — «можно ли закрыть сейчас» (идёт
 * отправка): нет — Escape поглощается и окно остаётся.
 */
export function useModalDialog(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  canClose: () => boolean = () => true,
  /** Окно на экране. Для компонента, который смонтирован и закрытым. */
  open = true,
): void {
  // onClose приходит новой функцией на каждом рендере родителя, поэтому лежит
  // в ref: в зависимостях эффекта он возвращал бы фокус в диалог при каждом
  // нажатии клавиши.
  const onCloseRef = useRef(onClose);
  const canCloseRef = useRef(canClose);
  useEffect(() => {
    onCloseRef.current = onClose;
    canCloseRef.current = canClose;
  });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialogRef.current;
    if (root && !root.contains(document.activeElement)) {
      // Контейнер — не элемент управления: фокус ему нужен, чтобы диктор прочёл
      // окно, а рамка фокуса вокруг всего окна — шум.
      if (!root.hasAttribute('tabindex')) {
        root.setAttribute('tabindex', '-1');
        root.style.outline = 'none';
      }
      root.focus();
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const entry: OverlayEntry = {
      onEscape: () => { if (canCloseRef.current()) onCloseRef.current(); },
    };
    const pop = pushOverlay(entry);

    // Tab держит только верхнее окно: у вложенного свой круг, и нижнее не
    // должно уводить фокус обратно к себе.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || overlayTop() !== entry) return;
      const el = dialogRef.current;
      if (!el) return;
      const items = focusablesIn(el);
      if (items.length === 0) { e.preventDefault(); el.focus(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!el.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      pop();
      document.body.style.overflow = prevOverflow;
      restoreFocus(opener, root);
    };
  }, [dialogRef, open]);
}

/**
 * Немодальный слой: Escape закрывает его (если он верхний), фокус
 * возвращается. `open` — слой на экране; `rootRef` — его корень (по нему
 * видно, потерян ли фокус после закрытия).
 */
export function useOverlayEscape(
  open: boolean,
  onClose: () => void,
  rootRef?: RefObject<HTMLElement | null>,
): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = rootRef?.current ?? null;
    const pop = pushOverlay({ onEscape: () => onCloseRef.current() });
    return () => {
      pop();
      restoreFocus(opener, root);
    };
  }, [open, rootRef]);
}

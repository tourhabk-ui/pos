'use client';

/**
 * Модальный диалог по правилам доступности: фокус внутрь при открытии,
 * Escape закрывает, Tab не уходит на страницу под затемнением, прокрутка
 * страницы стоит, а после закрытия фокус возвращается туда, откуда окно
 * открыли. Тот же приём, что у формы запроса мест
 * (components/planner/SeatRequestForm.tsx), вынесенный для диалогов CRM.
 *
 * `aria-modal` без ловушки фокуса — обещание без исполнителя: скринридер
 * верит, что за окном ничего нет, а Tab туда уводит.
 */
import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalDialog(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  canClose: () => boolean = () => true,
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
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (canCloseRef.current()) onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) { e.preventDefault(); root.focus(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!root.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && (active === first || active === root)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus();
    };
  }, [dialogRef]);
}

'use client';

import { useEffect, useState } from 'react';

/**
 * Текущее время, которое само обновляется раз в `everyMs` (по умолчанию —
 * полминуты). Нужно там, где на экране стоит возраст данных — «3 мин назад»:
 * без этого строка замирала на моменте открытия страницы, и через полчаса
 * свежие по виду данные были на самом деле старыми (12.11, «Радар»).
 *
 * Возраст по-прежнему считается от настоящей метки времени источника — этот
 * хук двигает только «сейчас», а не данные. Вкладка в фоне не тикает
 * впустую: при возврате время обновляется сразу.
 */
export function useNow(everyMs = 30_000, serverNow?: string): Date {
  // serverNow — «сейчас» сервера на момент разметки: первый рендер клиента
  // совпадает с ней (без расхождения гидрации), а сразу после монтирования
  // время берётся своё.
  const [now, setNow] = useState(() => (serverNow ? new Date(serverNow) : new Date()));
  useEffect(() => {
    const tick = () => setNow(new Date());
    if (serverNow) tick();
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') tick();
    }, everyMs);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [everyMs, serverNow]);
  return now;
}

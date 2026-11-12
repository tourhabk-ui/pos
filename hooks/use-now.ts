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
export function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') tick();
    }, everyMs);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [everyMs]);
  return now;
}

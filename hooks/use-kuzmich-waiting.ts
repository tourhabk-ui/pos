'use client';

/**
 * Очередь вопросов, заданных Кузьмичу без сети (`lib/kuzmich/offline-queue`).
 *
 * Вопрос уходит, только когда есть признак связи: событие `online`, удачный
 * ответ сервера (`connected()`) или очередь, найденная во вкладке после
 * перезагрузки. Добавление в очередь отправку не запускает: браузер может
 * считать сеть живой, когда её нет, и тогда вопрос уходил бы и возвращался
 * без конца. Пока экран занят ответом (`ready` = false), отправка ждёт.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { browserOffline } from '@/lib/kuzmich/offline-answer';
import {
  WAITING_MAX, joinWaiting, readWaiting, storeWaiting,
  type AskedOffline, type WaitingKept, type WaitingQuestion, type WaitingSurface,
} from '@/lib/kuzmich/offline-queue';

export interface KuzmichWaiting {
  waiting: readonly WaitingQuestion[];
  /** Поставить вопрос ждать связи. Очередь полна — null. */
  add: (text: string, askedAt?: number) => WaitingKept | null;
  /** «Не отправлять»: человек передумал. */
  clear: () => void;
  /** Сервер ответил — связь есть, ждущие вопросы можно отправлять. */
  connected: () => void;
}

export function useKuzmichWaiting(
  surface: WaitingSurface,
  session: string | null,
  ready: boolean,
  flush: (text: string, asked: AskedOffline) => void,
): KuzmichWaiting {
  const [waiting, setWaiting] = useState<readonly WaitingQuestion[]>([]);
  const listRef = useRef<WaitingQuestion[]>([]);
  const wantRef = useRef(false);
  const readyRef = useRef(ready);
  const flushRef = useRef(flush);
  useEffect(() => { flushRef.current = flush; });

  const put = useCallback((list: WaitingQuestion[]): boolean => {
    listRef.current = list;
    setWaiting(list);
    return storeWaiting(surface, list);
  }, [surface]);

  const tryFlush = useCallback(() => {
    if (!wantRef.current || !readyRef.current || browserOffline()) return;
    const out = joinWaiting(listRef.current);
    wantRef.current = false;
    if (!out) return;
    put([]);
    flushRef.current(out.text, out.asked);
  }, [put]);

  // Вопросы этого разговора, оставшиеся во вкладке: страницу перезагрузили.
  useEffect(() => {
    if (session === null) return;
    const found = readWaiting(surface, session);
    listRef.current = found;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- очередь из вкладки: до монтирования и до номера разговора её не прочитать, а чтение при отрисовке спорило бы с гидрацией
    setWaiting(found);
    if (found.length > 0) {
      wantRef.current = true;
      tryFlush();
    }
  }, [surface, session, tryFlush]);

  useEffect(() => {
    readyRef.current = ready;
    tryFlush();
  }, [ready, tryFlush]);

  useEffect(() => {
    const onOnline = () => { wantRef.current = true; tryFlush(); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [tryFlush]);

  const add = useCallback((text: string, askedAt: number = Date.now()): WaitingKept | null => {
    const t = text.trim();
    if (!t || session === null || listRef.current.length >= WAITING_MAX) return null;
    return put([...listRef.current, { text: t, askedAt, session }]) ? 'tab' : 'page';
  }, [put, session]);

  const clear = useCallback(() => { wantRef.current = false; put([]); }, [put]);

  const connected = useCallback(() => {
    if (listRef.current.length === 0) return;
    wantRef.current = true;
    tryFlush();
  }, [tryFlush]);

  return { waiting, add, clear, connected };
}

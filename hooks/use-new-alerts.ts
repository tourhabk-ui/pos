'use client';

import { useEffect, useState } from 'react';
import { newAlertKeys, nextSeen, readSeen, writeSeen, NEW_ALERT_HIGHLIGHT_MS } from '@/lib/safety/new-alerts';

/**
 * Какие из предупреждений этот браузер видит впервые — для одноразовой
 * подсветки (12.11). Ключи — `alertKey` строки. В первый визит набор пуст:
 * «новым» становится только то, что появилось после показа прежней ленты.
 * Набор очищается через NEW_ALERT_HIGHLIGHT_MS — подсветка не держится.
 * Нет localStorage (приватный режим, запрет) — подсветки нет, лента та же.
 */
export function useNewAlerts(keys: string[]): Set<string> {
  const keysSig = keys.join('\n');
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const list = keysSig ? keysSig.split('\n') : [];
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { storage = null; }
    const seen = readSeen(storage);
    const added = newAlertKeys(list, seen);
    writeSeen(storage, nextSeen(list, seen));
    if (added.size === 0) return;
    setFresh(added);
    const t = window.setTimeout(() => setFresh(new Set()), NEW_ALERT_HIGHLIGHT_MS);
    return () => window.clearTimeout(t);
  }, [keysSig]);
  return fresh;
}

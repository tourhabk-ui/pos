'use client';

/**
 * Якорь прибора карточки места: откуда меряем пеленг и дистанцию.
 * По умолчанию — Петропавловск-Камчатский с честной подписью; геолокация
 * ТОЛЬКО по явному тапу по прибору (requestGeo) — браузерный промпт без
 * контекста запрещён владельцем. Отказ/ошибка — молча остаёмся на ПК.
 */

import { useCallback, useRef, useState } from 'react';
import type { GeoPoint } from './place-horizons';

export const PK: GeoPoint = { lat: 53.0195, lng: 158.6505 };
const PK_LABEL = 'от Петропавловска';

export function useAnchor(): { anchor: GeoPoint; label: string; requestGeo: () => void } {
  const [anchor, setAnchor] = useState<GeoPoint>(PK);
  const [label, setLabel] = useState(PK_LABEL);
  const requested = useRef(false);

  const requestGeo = useCallback(() => {
    if (requested.current) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    requested.current = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setAnchor({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLabel('от вас');
      },
      () => { /* отказ — остаёмся на ПК молча */ },
      { maximumAge: 60_000, timeout: 10_000 },
    );
  }, []);

  return { anchor, label, requestGeo };
}

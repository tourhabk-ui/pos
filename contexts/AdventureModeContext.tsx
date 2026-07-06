'use client';

/**
 * AdventureModeContext — «Режим похода»: категория активности, которую
 * пользователь исследует прямо сейчас, влияет на персонализацию
 * (MobileForYouTile → /api/tourist/recommendations?category=).
 *
 * Категории — не выдуманные: тот же activity_type, что уже фильтрует
 * /marketplace?activity_type=... (см. components/homepage/FeaturedDirections.tsx).
 *
 * Паттерн персистентности — по образцу contexts/GeoContext.tsx.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';

export type AdventureCategory = 'trekking' | 'bears' | 'thermal' | 'boat_trip' | 'helicopter';
export type AdventureMode = AdventureCategory | 'all';

interface AdventureModeContextValue {
  mode: AdventureMode;
  setMode: (mode: AdventureMode) => void;
}

const AdventureModeContext = createContext<AdventureModeContextValue>({
  mode: 'all',
  setMode: () => {},
});

const LS_MODE_KEY = 'kh-adventure-mode';
const VALID_MODES: AdventureMode[] = ['all', 'trekking', 'bears', 'thermal', 'boat_trip', 'helicopter'];

function loadPersisted(): AdventureMode {
  try {
    const raw = localStorage.getItem(LS_MODE_KEY);
    return raw && (VALID_MODES as string[]).includes(raw) ? (raw as AdventureMode) : 'all';
  } catch {
    return 'all';
  }
}

function savePersisted(mode: AdventureMode): void {
  try {
    if (mode === 'all') localStorage.removeItem(LS_MODE_KEY);
    else localStorage.setItem(LS_MODE_KEY, mode);
  } catch {
    // localStorage недоступен — игнорируем
  }
}

export function AdventureModeProvider({ children }: { children: ReactNode }) {
  const persisted = useRef(loadPersisted());
  const [mode, setModeState] = useState<AdventureMode>(persisted.current);

  const setMode = useCallback((m: AdventureMode) => {
    setModeState(m);
    savePersisted(m);
  }, []);

  const value: AdventureModeContextValue = { mode, setMode };
  return <AdventureModeContext.Provider value={value}>{children}</AdventureModeContext.Provider>;
}

export function useAdventureMode(): AdventureModeContextValue {
  return useContext(AdventureModeContext);
}

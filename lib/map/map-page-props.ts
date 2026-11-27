/**
 * Что страница карты передаёт клиенту по адресу: одна функция на `/map` и
 * узкий вход `/map/compact` (мини-приложение MAX) — правило ссылки одно
 * (lib/map/map-target.ts), место из базы (lib/map/map-focus.ts).
 */
import { mapTargetFromSearch, type MapFocus } from '@/lib/map/map-target';
import { loadMapFocus } from '@/lib/map/map-focus';

export async function mapPageProps(
  searchParams: Promise<Record<string, string | string[] | undefined>>,
): Promise<{ focus: MapFocus | null; openSafety: boolean }> {
  const target = mapTargetFromSearch(await searchParams);
  const focus = target.kind === 'place' ? await loadMapFocus(target.ref) : null;
  return { focus, openSafety: target.kind === 'safety' };
}

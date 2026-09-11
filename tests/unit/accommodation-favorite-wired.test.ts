/**
 * Сердечко на карточке жилья подключено к избранному (#1786).
 *
 * Находка эволюции говорила о кнопках «подтвердить/отменить», которых в
 * `AccommodationCard` нет. Настоящий дефект того же рода был рядом: кнопка
 * «В избранное» на каждой карточке /accommodations не делала ничего —
 * страница не передавала обработчик. Здесь держится связка: карточка получает
 * `onFavoriteToggle` и `isFavorite`, а страница ходит в тот же
 * `/api/tourist/wishlist` по единому контракту типом `accommodation`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WISHLIST_TYPES } from '@/lib/wishlist/contract';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('избранное жилья (#1786)', () => {
  const page = read('app/accommodations/_AccommodationsClient.tsx');

  it('страница передаёт карточке обработчик и состояние избранного', () => {
    expect(page).toMatch(/isFavorite=\{favMap\.has\(acc\.id\)\}/);
    expect(page).toMatch(/onFavoriteToggle=\{toggleFavorite\}/);
  });

  it('состояние читается из /api/tourist/wishlist, тип — из общего контракта', () => {
    expect(page).toMatch(/fetch\('\/api\/tourist\/wishlist\?type=accommodation'\)/);
    expect(page).toMatch(/itemType: 'accommodation'/);
    expect(WISHLIST_TYPES).toContain('accommodation');
  });

  it('гость уводится на вход, отказ откатывает сердце и пишет причину (§4.0)', () => {
    expect(page).toMatch(/res\?\.status === 401/);
    expect(page).toMatch(/router\.push\('\/auth\/login'\)/);
    expect(page).toMatch(/console\.error\('\[accommodations\] избранное не сохранено'/);
  });

  it('карточка по-прежнему зовёт обработчик, а не пишет в localStorage', () => {
    const card = read('components/shared/AccommodationCard.tsx');
    expect(card).toMatch(/onFavoriteToggle\(id\)/);
    expect(card).not.toMatch(/localStorage/);
  });
});

/**
 * Плитка берёт копию под рамку 4:3 только при совпавшей точке кадра
 * (#3564 п.1). Точку поправили, копию ещё не перерезали — копии нет, и плитка
 * режет копию 640 сама по новой точке, а не показывает старую обрезку.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const focus = vi.hoisted(() => ({ y: null as number | null }));
vi.mock('@/lib/tours/photo-focus', () => ({ photoFocusY: () => focus.y }));

import { platePhotoSrc } from '@/lib/images/plate-photo';

const WINTER = '/api/images/s3/photos/fishingkam/2025-01-27_142818_1.jpg';

describe('копия под рамку 4:3', () => {
  beforeEach(() => { focus.y = null; });

  it('точка кадра совпала (верх кадра) — копия', () => {
    expect(platePhotoSrc(WINTER)).toBe('/api/images/s3/photos/fishingkam/2025-01-27_142818_1.plate0.webp');
  });

  it('точку поправили, копию не перерезали — копии нет', () => {
    focus.y = 40;
    expect(platePhotoSrc(WINTER)).toBeNull();
  });

  it('снимка нет в списке или адреса нет — копии нет', () => {
    expect(platePhotoSrc('/images/tours/uploaded-later.jpg')).toBeNull();
    expect(platePhotoSrc(null)).toBeNull();
    expect(platePhotoSrc('constructor')).toBeNull();
  });
});

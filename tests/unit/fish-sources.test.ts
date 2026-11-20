import { describe, it, expect } from 'vitest';
import { FISH_TEXT_REVISION, fishBaseUrl } from '@/lib/fish/fish-sources';
import { FISH_SPECIES } from '@/lib/fish-species';

describe('/fish: источники и дата', () => {
  it('FishBase — только для биноменов рыб', () => {
    expect(fishBaseUrl('Oncorhynchus nerka')).toBe('https://www.fishbase.se/summary/Oncorhynchus-nerka.html');
    expect(fishBaseUrl('Oncorhynchus spp.')).toBeNull();
    expect(fishBaseUrl('Salmo trutta / O. mykiss')).toBeNull();
    expect(fishBaseUrl('Paralithodes camtschaticus')).toBeNull();
    expect(FISH_SPECIES.filter((f) => fishBaseUrl(f.nameLatin)).length).toBeGreaterThanOrEqual(10);
  });
  it('дата правки — ISO-день', () => {
    expect(FISH_TEXT_REVISION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

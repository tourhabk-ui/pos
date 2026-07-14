/**
 * Wikimedia Commons: фильтр свободных лицензий, очистка HTML-автора и сборка
 * кандидата из imageinfo. Только чистые функции — без сети.
 */
import { describe, it, expect } from 'vitest';
import { isFreeLicense, stripHtml, buildCandidate } from '@/lib/services/wikimedia-photos';

describe('isFreeLicense', () => {
  it('принимает CC-BY / CC-BY-SA / CC0 / PD по машинному коду', () => {
    expect(isFreeLicense('cc-by-sa-4.0', 'CC BY-SA 4.0')).toBe(true);
    expect(isFreeLicense('cc-by-3.0', 'CC BY 3.0')).toBe(true);
    expect(isFreeLicense('cc0', 'CC0')).toBe(true);
    expect(isFreeLicense('pd', 'Public domain')).toBe(true);
  });

  it('отвергает fair use / non-free / all rights reserved', () => {
    expect(isFreeLicense('fairuse', 'Fair use')).toBe(false);
    expect(isFreeLicense('', 'All rights reserved')).toBe(false);
    expect(isFreeLicense('nonfree', 'Non-free')).toBe(false);
  });

  it('судит по короткому имени, если машинного кода нет', () => {
    expect(isFreeLicense(null, 'CC BY-SA 4.0')).toBe(true);
    expect(isFreeLicense(null, 'Public domain')).toBe(true);
    expect(isFreeLicense(null, 'Copyrighted, all rights reserved')).toBe(false);
  });
});

describe('stripHtml', () => {
  it('снимает теги и декодирует сущности', () => {
    expect(stripHtml('<a href="x">Ivan &amp; Co</a>')).toBe('Ivan & Co');
    expect(stripHtml('<span>  Name\n\t here </span>')).toBe('Name here');
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
  });
});

describe('buildCandidate', () => {
  const freePage = {
    pageid: 42,
    title: 'File:Avacha.jpg',
    imageinfo: [{
      url: 'https://upload.wikimedia.org/avacha.jpg',
      thumburl: 'https://upload.wikimedia.org/thumb/avacha.jpg',
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Avacha.jpg',
      width: 4000,
      height: 3000,
      mime: 'image/jpeg',
      extmetadata: {
        Artist: { value: '<a>Jane Doe</a>' },
        LicenseShortName: { value: 'CC BY-SA 4.0' },
        License: { value: 'cc-by-sa-4.0' },
        LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
      },
    }],
  };

  it('собирает кандидата для свободного растрового фото достаточного размера', () => {
    const c = buildCandidate(freePage, 120, 800);
    expect(c).not.toBeNull();
    expect(c!.author).toBe('Jane Doe');
    expect(c!.license).toBe('CC BY-SA 4.0');
    expect(c!.imageUrl).toContain('avacha.jpg');
    expect(c!.distanceM).toBe(120);
  });

  it('отвергает несвободную лицензию', () => {
    const page = { ...freePage, imageinfo: [{ ...freePage.imageinfo[0], extmetadata: { LicenseShortName: { value: 'All rights reserved' }, License: { value: 'fairuse' } } }] };
    expect(buildCandidate(page, null, 800)).toBeNull();
  });

  it('отвергает слишком маленькое фото', () => {
    const page = { ...freePage, imageinfo: [{ ...freePage.imageinfo[0], width: 400, height: 300 }] };
    expect(buildCandidate(page, null, 800)).toBeNull();
  });

  it('отвергает не-растровый mime (svg/tiff)', () => {
    const page = { ...freePage, imageinfo: [{ ...freePage.imageinfo[0], mime: 'image/svg+xml' }] };
    expect(buildCandidate(page, null, 800)).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { deviceClass, referrerHost, sourceGroup } from '@/lib/analytics/visit-sources';

describe('источник визита по рефереру', () => {
  it.each([
    [null, 'direct'],
    ['https://yandex.ru/search/?text=камчатка', 'search'],
    ['https://www.google.com/', 'search'],
    ['https://chatgpt.com/', 'ai'],
    ['https://gemini.google.com/app', 'ai'],
    ['https://www.perplexity.ai/search', 'ai'],
    ['https://alice.yandex.ru/', 'ai'],
    ['https://t.me/', 'messenger'],
    ['https://web.max.ru/', 'messenger'],
    ['https://vk.com/wall', 'social'],
    ['https://vedarai.ru/tours', 'internal'],
    ['https://kamchatka-travel.example/', 'other'],
  ])('%s → %s', (ref, group) => {
    expect(sourceGroup(referrerHost(ref))).toBe(group);
  });
});

describe('класс устройства', () => {
  it('телефон, планшет, компьютер, пусто', () => {
    expect(deviceClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148')).toBe('mobile');
    expect(deviceClass('Mozilla/5.0 (Linux; Android 14; SM-S918B) Mobile Safari/537.36')).toBe('mobile');
    expect(deviceClass('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(deviceClass('Mozilla/5.0 (Linux; Android 13; SM-X700) Safari/537.36')).toBe('tablet');
    expect(deviceClass('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130')).toBe('desktop');
    expect(deviceClass('')).toBeNull();
  });
});

/**
 * Новостной канал по назначению (слово владельца 28.11): «в РФ в постах и на
 * сайте ставить канал MAX, в других странах — Telegram».
 *
 * Держит два правила lib/seo/news-channel вызовом на граничных данных:
 *   - пост: в тексте для MAX корень Telegram-канала становится корнем канала
 *     MAX, и наоборот; ссылка на пост, бот и чужой канал не меняются, нового
 *     «мы в …» нет (crossLinkedTexts — то же правило);
 *   - сайт: страна из заголовка прокси, иначе первый язык браузера; раздел
 *     /en и /zh и неопределённость — Telegram.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORGANIZATION_PROFILES, ORGANIZATION_SAME_AS } from '@/lib/seo/organization-profiles';
import {
  adaptNewsChannelLinks,
  newsChannelForRequest,
  newsChannelDestForRequest,
  NEWS_CHANNEL_LABELS,
} from '@/lib/seo/news-channel';
import { crossLinkedTexts } from '@/lib/notifications/telegram-channel';

const TG = ORGANIZATION_PROFILES.telegramChannel; // https://t.me/kamchatka_real
const MAX = ORGANIZATION_PROFILES.maxChannel; // https://max.ru/id4101147649_biz

afterEach(() => { vi.unstubAllEnvs(); });

describe('пост в MAX: корень Telegram-канала — корнем канала MAX', () => {
  it.each([
    ['https://t.me/kamchatka_real'],
    ['http://t.me/kamchatka_real'],
    ['https://www.t.me/kamchatka_real'],
    ['t.me/kamchatka_real'],
    ['@kamchatka_real'],
    ['https://t.me/kamchatka_real/'],
    ['https://t.me/kamchatka_real?start=post'],
    ['https://t.me/kamchatka_real#top'],
    ['https://T.ME/Kamchatka_Real'],
  ])('%s → канал MAX', (root) => {
    expect(adaptNewsChannelLinks(`Новости: ${root}`, 'max')).toBe(`Новости: ${MAX}`);
    expect(adaptNewsChannelLinks(root, 'max')).toBe(MAX);
  });

  it('пост канала не трогается: в MAX такого адреса нет', () => {
    for (const post of ['https://t.me/kamchatka_real/444', 't.me/kamchatka_real/910', 'https://t.me/kamchatka_real/s/12', 'https://t.me/kamchatka_real/444?single']) {
      expect(adaptNewsChannelLinks(`Разбор: ${post} и всё`, 'max')).toBe(`Разбор: ${post} и всё`);
    }
  });

  it('граница слова: другое имя не совпадает, пунктуация после корня — совпадает', () => {
    for (const other of ['@kamchatka_realism', 't.me/kamchatka_real_extra', 'https://t.me/kamchatka_real2', 'mail@kamchatka_real']) {
      expect(adaptNewsChannelLinks(`см. ${other} тут`, 'max')).toBe(`см. ${other} тут`);
    }
    expect(adaptNewsChannelLinks('Пишите в @kamchatka_real, отвечаем.', 'max')).toBe(`Пишите в ${MAX}, отвечаем.`);
    expect(adaptNewsChannelLinks('Канал — t.me/kamchatka_real.', 'max')).toBe(`Канал — ${MAX}.`);
    expect(adaptNewsChannelLinks('(t.me/kamchatka_real)', 'max')).toBe(`(${MAX})`);
  });

  it('корень в HTML-ссылке заменяется, разметка остаётся', () => {
    expect(adaptNewsChannelLinks('<a href="https://t.me/kamchatka_real">наш канал</a>', 'max'))
      .toBe(`<a href="${MAX}">наш канал</a>`);
  });

  it('боты и чужие каналы не трогаются', () => {
    const text = 'Кузьмич: t.me/kuzmichai_bot, max.ru/id4101147649_bot, https://t.me/other_channel';
    expect(adaptNewsChannelLinks(text, 'max')).toBe(text);
    expect(adaptNewsChannelLinks(text, 'telegram')).toBe(text);
  });

  it('текст без канала возвращается тем же, корень своего канала тоже', () => {
    const plain = 'Авачинский открыт, выход с приюта в шесть утра: https://vedarai.ru/catalog/tours/avacha';
    expect(adaptNewsChannelLinks(plain, 'max')).toBe(plain);
    expect(adaptNewsChannelLinks(plain, 'telegram')).toBe(plain);
    expect(adaptNewsChannelLinks(`Мы тут: ${TG}`, 'telegram')).toBe(`Мы тут: ${TG}`);
    expect(adaptNewsChannelLinks(`Мы тут: ${MAX}`, 'max')).toBe(`Мы тут: ${MAX}`);
  });

  it('подпись прямо перед корнем меняется вместе с ним', () => {
    expect(adaptNewsChannelLinks('Наш канал в Telegram: https://t.me/kamchatka_real', 'max'))
      .toBe(`Наш канал в MAX: ${MAX}`);
    expect(adaptNewsChannelLinks('Подписывайтесь, наш канал в Telegram — @kamchatka_real', 'max'))
      .toBe(`Подписывайтесь, наш канал в MAX — ${MAX}`);
    expect(adaptNewsChannelLinks('канал в Telegram t.me/kamchatka_real', 'max'))
      .toBe(`канал в MAX ${MAX}`);
  });

  it('голое «в Telegram» в другом месте и подпись не вплотную — не трогаются', () => {
    expect(adaptNewsChannelLinks('Ответим в Telegram. Канал: https://t.me/kamchatka_real', 'max'))
      .toBe(`Ответим в Telegram. Канал: ${MAX}`);
    expect(adaptNewsChannelLinks('Наш канал в Telegram и новости: https://t.me/kamchatka_real', 'max'))
      .toBe(`Наш канал в Telegram и новости: ${MAX}`);
    expect(adaptNewsChannelLinks('Телеканал в Telegram: https://t.me/kamchatka_real', 'max'))
      .toBe(`Телеканал в Telegram: ${MAX}`);
    // Подпись перед ссылкой-тегом: между ней и корнем стоит разметка.
    expect(adaptNewsChannelLinks('Наш канал в Telegram: <a href="https://t.me/kamchatka_real">ссылка</a>', 'max'))
      .toBe(`Наш канал в Telegram: <a href="${MAX}">ссылка</a>`);
  });

  it('вводный пост MAX 28.11: ссылка и подпись — на канал MAX', () => {
    const intro = 'Это канал Ведара в MAX.\nНаш канал в Telegram: https://t.me/kamchatka_real\nРазбор недели: https://t.me/kamchatka_real/444';
    expect(adaptNewsChannelLinks(intro, 'max')).toBe(
      `Это канал Ведара в MAX.\nНаш канал в MAX: ${MAX}\nРазбор недели: https://t.me/kamchatka_real/444`,
    );
  });
});

describe('пост в Telegram: корень канала MAX — корнем Telegram-канала', () => {
  it.each([
    ['https://max.ru/id4101147649_biz'],
    ['http://max.ru/id4101147649_biz'],
    ['max.ru/id4101147649_biz'],
    ['https://max.ru/id4101147649_biz/'],
    ['https://max.ru/id4101147649_biz?from=site'],
  ])('%s → Telegram-канал', (root) => {
    expect(adaptNewsChannelLinks(`Новости: ${root}`, 'telegram')).toBe(`Новости: ${TG}`);
  });

  it('пост канала MAX и @kamchatka_real в тексте для Telegram не трогаются', () => {
    const text = 'Пост: https://max.ru/id4101147649_biz/AaIhxBZ2Jbs, канал @kamchatka_real';
    expect(adaptNewsChannelLinks(text, 'telegram')).toBe(text);
  });

  it('подпись «Наш канал в MAX» становится «Наш канал в Telegram»', () => {
    expect(adaptNewsChannelLinks('Наш канал в MAX: https://max.ru/id4101147649_biz', 'telegram'))
      .toBe(`Наш канал в Telegram: ${TG}`);
  });
});

describe('адрес канала: реестр, переменная окружения переопределяет', () => {
  it('без переменных — адреса реестра, ссылки не пустые', () => {
    vi.stubEnv('MAX_CHANNEL_LINK', '');
    vi.stubEnv('TELEGRAM_CHANNEL_LINK', '');
    expect(adaptNewsChannelLinks('@kamchatka_real', 'max')).toBe(MAX);
    expect(newsChannelForRequest(new Headers({ 'accept-language': 'ru' })).href).toBe(MAX);
    expect(newsChannelForRequest(new Headers()).href).toBe(TG);
  });

  it('заданная переменная — адрес назначения', () => {
    vi.stubEnv('MAX_CHANNEL_LINK', 'https://max.ru/vedar_test');
    vi.stubEnv('TELEGRAM_CHANNEL_LINK', 'https://t.me/vedar_test');
    expect(adaptNewsChannelLinks('Канал: https://t.me/kamchatka_real', 'max')).toBe('Канал: https://max.ru/vedar_test');
    expect(adaptNewsChannelLinks('Канал: https://max.ru/id4101147649_biz', 'telegram')).toBe('Канал: https://t.me/vedar_test');
    expect(newsChannelForRequest(new Headers({ 'accept-language': 'ru-RU' })).href).toBe('https://max.ru/vedar_test');
    expect(newsChannelForRequest(new Headers({ 'accept-language': 'en' })).href).toBe('https://t.me/vedar_test');
  });

  it('переменная не ссылка — адрес реестра и одна строка в лог', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('MAX_CHANNEL_LINK', 'max.ru/" onclick="x');
    expect(adaptNewsChannelLinks('@kamchatka_real', 'max')).toBe(MAX);
    expect(adaptNewsChannelLinks('@kamchatka_real', 'max')).toBe(MAX);
    const lines = err.mock.calls.filter((c) => String(c[0]).includes('MAX_CHANNEL_LINK'));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][0])).not.toContain('onclick');
    err.mockRestore();
  });
});

describe('crossLinkedTexts: в каждом канале — свой канал', () => {
  it('корень Telegram-канала: в Telegram остаётся, в MAX — канал MAX', () => {
    const text = 'Обстановка на Авачинском. Наш канал в Telegram: https://t.me/kamchatka_real';
    const out = crossLinkedTexts(text);
    expect(out.telegram).toBe(text);
    expect(out.max).toBe(`Обстановка на Авачинском. Наш канал в MAX: ${MAX}`);
  });

  it('без канала обе версии равны исходному: «Мы в MAX» не добавляется', () => {
    vi.stubEnv('MAX_CHANNEL_LINK', 'https://max.ru/vedar_test');
    vi.stubEnv('TELEGRAM_CHANNEL_LINK', 'https://t.me/vedar_test');
    const text = 'Тур на Авачинский: https://vedarai.ru/catalog/tours/avacha';
    expect(crossLinkedTexts(text)).toEqual({ telegram: text, max: text });
  });

  it('с переменными — их адрес, но свой канал, а не соседний', () => {
    vi.stubEnv('MAX_CHANNEL_LINK', 'https://max.ru/vedar_test');
    vi.stubEnv('TELEGRAM_CHANNEL_LINK', 'https://t.me/vedar_test');
    const out = crossLinkedTexts('Канал: https://t.me/kamchatka_real');
    expect(out.max).toBe('Канал: https://max.ru/vedar_test');
    expect(out.telegram).not.toContain('max.ru');
  });

  it('пост t.me/kamchatka_real/444 в обеих версиях как был', () => {
    const text = 'Разбор недели: https://t.me/kamchatka_real/444';
    expect(crossLinkedTexts(text)).toEqual({ telegram: text, max: text });
  });
});

describe('сайт: какой канал показать посетителю', () => {
  const dest = (h: Record<string, string>) => newsChannelDestForRequest(new Headers(h));

  it.each([
    'cf-ipcountry', 'cloudfront-viewer-country', 'x-vercel-ip-country', 'x-appengine-country', 'x-country-code',
  ])('страна RU в %s — MAX, другая — Telegram даже при ru-RU', (name) => {
    expect(dest({ [name]: 'RU' })).toBe('max');
    expect(dest({ [name]: 'ru' })).toBe('max');
    expect(dest({ [name]: 'DE', 'accept-language': 'ru-RU' })).toBe('telegram');
  });

  it('первый найденный заголовок страны решает', () => {
    expect(dest({ 'cf-ipcountry': 'KZ', 'x-country-code': 'RU' })).toBe('telegram');
    expect(dest({ 'cf-ipcountry': '', 'x-country-code': 'RU' })).toBe('max');
  });

  it('без страны — первый язык браузера', () => {
    expect(dest({ 'accept-language': 'ru' })).toBe('max');
    expect(dest({ 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8' })).toBe('max');
    expect(dest({ 'accept-language': 'RU-ru' })).toBe('max');
    for (const lang of ['ru-KZ', 'ru-BY', 'ru-UA', 'ru-KZ,ru-RU;q=0.9', 'en-US,ru;q=0.9', 'zh-CN', 'en', '*', ';;', '']) {
      expect(dest({ 'accept-language': lang }), lang).toBe('telegram');
    }
  });

  it('пустые заголовки — Telegram', () => {
    expect(newsChannelDestForRequest(new Headers())).toBe('telegram');
  });

  it('раздел /en и /zh — Telegram даже при ru-RU', () => {
    expect(dest({ 'x-vedar-pathname': '/zh/tours/avacha', 'accept-language': 'ru-RU' })).toBe('telegram');
    expect(dest({ 'x-vedar-pathname': '/en/places', 'accept-language': 'ru-RU' })).toBe('telegram');
    expect(dest({ 'x-vedar-pathname': '/en', 'cf-ipcountry': 'RU' })).toBe('telegram');
    expect(dest({ 'x-vedar-pathname': '/catalog', 'accept-language': 'ru-RU' })).toBe('max');
  });

  it('ссылка подвала — адрес и подпись своего канала', () => {
    expect(newsChannelForRequest(new Headers({ 'accept-language': 'ru-RU' })))
      .toEqual({ href: MAX, label: NEWS_CHANNEL_LABELS.max });
    expect(newsChannelForRequest(new Headers({ 'accept-language': 'en' })))
      .toEqual({ href: TG, label: NEWS_CHANNEL_LABELS.telegram });
    expect(NEWS_CHANNEL_LABELS).toEqual({ telegram: 'Telegram-канал', max: 'Канал в MAX' });
  });

  it('язык и страна не пишутся в лог', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    newsChannelForRequest(new Headers({ 'accept-language': 'ru-RU', 'cf-ipcountry': 'RU', 'x-forwarded-for': '203.0.113.7' }));
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('разметка организации не тронута', () => {
  it('в sameAs оба канала', () => {
    expect(ORGANIZATION_SAME_AS).toContain(TG);
    expect(ORGANIZATION_SAME_AS).toContain(MAX);
  });
});

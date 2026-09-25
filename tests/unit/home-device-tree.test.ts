/**
 * Какое дерево главной получает User-Agent (lib/home/device-tree, П8, #43).
 *
 * Встроенный браузер Telegram на Android пишет в UA «Telegram-Android/…», и
 * голая подстрока `telegram` в регулярке ботов отдавала живому человеку со
 * ссылкой из чата десктопную главную (без лид-формы, с футером на 2000 px).
 * То же грозило приложению Яндекса («YandexSearch/…»). Маркеры сужены до
 * краулеров; общий `bot` сохранён — боты по-прежнему получают десктоп (SEO).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeTreeFor, isCrawlerUA } from '@/lib/home/device-tree';

const TG_ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-A546B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.146 Mobile Safari/537.36 Telegram-Android/11.1.3 (Samsung SM-A546B; Android 14; SDK 34; AVERAGE)';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
const YANDEX_APP = 'Mozilla/5.0 (Linux; Android 13; M2101K6G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 YaApp_Android/24.40.1 YaSearchBrowser/24.40.1 BroPP/1.0 SA/3 YandexSearch/24.40.1 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const GOOGLEBOT_PHONE = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const YANDEXBOT_PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 8_1 like Mac OS X) AppleWebKit/600.1.4 (KHTML, like Gecko) Version/8.0 Mobile/12B411 Safari/600.1.4 (compatible; YandexMobileBot/3.0; +http://yandex.com/bots)';
const YANDEX_IMAGES_PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari (compatible; YandexImages/3.0; +http://yandex.com/bots)';
const TELEGRAM_PREVIEW = 'TelegramBot (like TwitterBot)';
const WHATSAPP_PREVIEW = 'WhatsApp/2.23.20.0 A';

describe('живые люди с телефона получают мобильное дерево', () => {
  it.each([
    ['встроенный браузер Telegram на Android', TG_ANDROID],
    ['iPhone Safari', IPHONE],
    ['Chrome на Android', CHROME_ANDROID],
    ['приложение Яндекса', YANDEX_APP],
  ])('%s → mobile', (_name, ua) => {
    expect(homeTreeFor(ua)).toBe('mobile');
  });
});

describe('краулеры получают десктопное дерево (SEO)', () => {
  it.each([
    ['Googlebot smartphone', GOOGLEBOT_PHONE],
    ['YandexMobileBot', YANDEXBOT_PHONE],
    ['YandexImages с мобильным UA', YANDEX_IMAGES_PHONE],
    ['превью Telegram', TELEGRAM_PREVIEW],
    ['превью WhatsApp', WHATSAPP_PREVIEW],
  ])('%s → desktop', (_name, ua) => {
    expect(isCrawlerUA(ua)).toBe(true);
    expect(homeTreeFor(ua)).toBe('desktop');
  });

  it('общий маркер `bot` сохранён: любой, кто назвался ботом с телефонным UA, — десктоп', () => {
    expect(homeTreeFor(`${CHROME_ANDROID} SomeNewBot/1.0`)).toBe('desktop');
  });
});

describe('десктоп и неоднозначное — десктоп', () => {
  it.each([
    ['десктопный Chrome', DESKTOP],
    ['iPad', IPAD],
    ['пустой UA', ''],
  ])('%s → desktop', (_name, ua) => {
    expect(homeTreeFor(ua)).toBe('desktop');
  });

  it('null/undefined — десктоп', () => {
    expect(homeTreeFor(null)).toBe('desktop');
    expect(homeTreeFor(undefined)).toBe('desktop');
  });
});

describe('главная решает дерево этой функцией, а не своей регулярко', () => {
  const PAGE = readFileSync(join(process.cwd(), 'app/page.tsx'), 'utf-8');
  it('app/page.tsx зовёт homeTreeFor', () => {
    expect(PAGE).toMatch(/homeTreeFor\(\(await headers\(\)\)\.get\('user-agent'\)\) === 'mobile'/);
  });
  it('в app/page.tsx нет своей регулярки ботов с голыми telegram/whatsapp/yandex', () => {
    expect(PAGE).not.toMatch(/\|telegram\||\|whatsapp\||\|yandex\|/);
  });
});

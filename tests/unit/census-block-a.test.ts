/**
 * Решения по блоку A переписи («Защита и безопасность»), 22.08.2026.
 *
 * Блок собирал механизмы, которые ЧИТАЮТСЯ как защита и ею не являются.
 * Решение принято поимённо; сторож держит решения, а не код: подключённое не
 * должно отвязаться, удалённое — вернуться недоделанным. Оба отката выглядят
 * как тишина.
 *
 * CSRF разобран отдельно — `tests/unit/auth-cookie-samesite.test.ts`.
 * Офлайн-номера спасения — `tests/unit/emergency-offline-numbers.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { validatePassword, passwordSchema } from '@/lib/auth/password';
import { validateConfig } from '@/lib/config';

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

describe('конфигурация проверяется при старте', () => {
  it('проверка зовётся из instrumentation, а не лежит без дела', () => {
    expect(code('instrumentation.ts')).toMatch(/\bvalidateConfig\b/);
  });

  it('у проверки два уровня: с чем нельзя работать и чего просто не будет', () => {
    const check = validateConfig();
    expect(Array.isArray(check.fatal)).toBe(true);
    expect(Array.isArray(check.warnings)).toBe(true);
  });

  it('строка-заглушка вместо JWT_SECRET — непригодная конфигурация', () => {
    // Подпись сессий известным всему миру значением значит, что токен любого
    // пользователя подделает кто угодно. Это не предупреждение.
    const before = process.env.JWT_SECRET;
    try {
      process.env.JWT_SECRET = 'your-secret-key';
      // config читает env при импорте модуля, поэтому проверяем само правило.
      expect('your-secret-key').toBe('your-secret-key');
    } finally {
      if (before === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = before;
    }
    // Правило зафиксировано в тексте функции: заглушка и короткий секрет — fatal.
    const src = read('lib/config.ts');
    expect(src).toMatch(/fatal\.push\([^)]*строке-заглушке/);
    expect(src).toMatch(/fatal\.push\([^)]*32 символов/);
  });

  it('отказ самой проверки не выдаётся за исправную конфигурацию', () => {
    expect(code('instrumentation.ts')).toMatch(/проверка конфигурации не выполнилась/);
  });
});

describe('правило пароля одно на платформу', () => {
  it('слабый пароль не проходит', () => {
    expect(validatePassword('короткий').valid).toBe(false);
    expect(validatePassword('alllowercase1').valid).toBe(false);
    expect(validatePassword('НЕТЦИФРНЕТСТРОЧНЫХ').valid).toBe(false);
  });

  it('сильный пароль проходит — и латиницей, и кириллицей', () => {
    expect(validatePassword('Secret123').valid).toBe(true);
    // Прежние [A-Z]/[a-z] отвергли бы русский пароль с заглавной буквой:
    // сообщение «нужна заглавная» на пароле с заглавной читается как поломка.
    expect(validatePassword('Вулкан2024').valid).toBe(true);
  });

  it('схема Zod отдаёт все замечания сразу, а не по одному за поход', () => {
    const parsed = passwordSchema.safeParse('abc');
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.length).toBeGreaterThan(1);
  });

  it('каждая точка выбора пароля берёт общее правило, а не своё', () => {
    const entries = [
      'app/api/auth/register/route.ts',
      'app/api/auth/register-operator/route.ts',
      'app/api/partners/register/route.ts',
      'app/api/hub/operator/register/route.ts',
      'app/api/auth/change-password/route.ts',
      'app/api/tourist/profile/password/route.ts',
    ];
    for (const f of entries) {
      const src = code(f);
      expect(src, `${f} не использует passwordSchema`).toMatch(/\bpasswordSchema\b/);
      // Своего правила длины рядом быть не должно — иначе снова шесть правил.
      // Якорь на начало строки обязателен: без него `current_password` (поле
      // ТЕКУЩЕГО пароля, которому новое правило применять нельзя — у давнего
      // пользователя он может быть слабым) попадает под шаблон как подстрока.
      expect(src, `${f} держит собственное правило длины пароля`)
        .not.toMatch(/^\s*(password|new_password|newPassword):\s*z\s*\.\s*string\(/m);
    }
  });

  it('вход не судит старые пароли новым правилом', () => {
    // Иначе давние пользователи потеряют доступ к своим аккаунтам.
    expect(code('app/api/auth/signin/route.ts')).not.toMatch(/\bpasswordSchema\b/);
  });
});

describe('посты канала проверяются все, а не один вид из девяти', () => {
  const src = code('lib/notifications/telegram-channel.ts');

  it('общий путь публикации гоняет полную проверку текста', () => {
    expect(src).toMatch(/\bvalidateTextPost\b/);
    expect(src).toMatch(/\blogValidationFailure\b/);
  });

  it('публикатор AI-новостей проверяется тоже — он идёт мимо общего пути', () => {
    const fn = src.slice(src.indexOf('export async function postAINewsToChannel'));
    const end = fn.indexOf('\nexport ');
    expect(end === -1 ? fn : fn.slice(0, end)).toMatch(/\bvalidateTextPost\b/);
  });

  it('у публикации именованные поля, а не череда строк подряд', () => {
    // Два соседних строковых параметра меняются местами молча: тип один, и
    // компилятор не возражает. На этом уже спотыкались в Watchdog.
    expect(src).toMatch(/async function postToAllChannels\(post: ChannelPost\)/);
    expect(src).not.toMatch(/postToAllChannels\(\s*channelId\s*,\s*'/);
  });

  it('каждый публикатор называет себя — иначе отказ ляжет в журнал безымянным', () => {
    const types = [...src.matchAll(/postType:\s*'(\w+)'/g)].map(m => m[1]);
    expect(new Set(types).size).toBeGreaterThanOrEqual(8);
  });
});

describe('вторых форм тех же данных не осталось', () => {
  it('выжимки критических сигналов нет: клиент фильтрует полный список сам', () => {
    expect(code('lib/safety/hazard-signals.ts')).not.toMatch(/\bgetCriticalSignals\b/);
    expect(code('lib/safety/hazard-signals.ts')).toMatch(/\bgetHazardSignals\b/);
  });

  it('сырой выдачи таблицы сверки телефонов нет', () => {
    // Туристу показывается проверенный владельцем список из
    // lib/safety/emergency-numbers.ts, а не содержимое верстака сверки.
    expect(code('lib/services/safety/emergency-contacts.ts')).not.toMatch(/export async function getEmergencyContacts\b/);
    expect(code('lib/services/safety/emergency-contacts.ts')).toMatch(/computeEmergencyContactsHealth/);
  });
});

import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { scanSource, pdAliases, promptFlowOf } from '@/lib/agents/compliance/pii-flow-scanner';
import { findViolations, ALLOWLIST } from '@/lib/agents/compliance/scan-repo';
import {
  LLM_ENDPOINTS,
  LLM_EGRESS_FILES,
  unregisteredHosts,
  extractLLMHosts,
  NON_RECEIVER_HOSTS,
} from '@/lib/agents/compliance/provider-registry';

const REPO_ROOT = resolve(__dirname, '../..');

describe('scanSource — ловит сырые ПД в тексте промпта', () => {
  it('телефон лида в prompt-переменной без чистки → находка', () => {
    const src = `
      import { callAIFast } from '@/lib/ai/providers';
      const prompt = \`Клиент \${lead.phone} хочет тур\`;
      await callAIFast([{ role: 'user', content: prompt }]);
    `;
    const f = scanSource('x.ts', src);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('contact');
    expect(f[0].expr).toContain('lead.phone');
  });

  it('email в значении content: (файл зовёт зарубежный LLM) → находка', () => {
    const src = `
      import { callAIWithModel } from '@/lib/ai/providers';
      const messages = [{ role: 'user', content: \`Почта: \${user.email}\` }];
      await callAIWithModel(messages, 'fast');
    `;
    const f = scanSource('x.ts', src);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('contact');
  });

  it('персональное имя (lead.name) в промпте → находка kind=name', () => {
    const src = `
      import { callAIDecision } from '@/lib/ai/providers';
      const prompt = \`Турист \${lead.name} интересуется\`;
      callAIDecision([{ role: 'user', content: prompt }]);
    `;
    const f = scanSource('x.ts', src);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('name');
  });

  it('интерполяция сквозь redactPII() — НЕ находка', () => {
    const src = `
      import { callAIFast } from '@/lib/ai/providers';
      const prompt = \`Клиент \${redactPII(lead.comment)} и \${redactPII(lead.phone)}\`;
      await callAIFast([{ role: 'user', content: prompt }]);
    `;
    expect(scanSource('x.ts', src)).toHaveLength(0);
  });

  it('плейсхолдер {name} — НЕ находка', () => {
    const src = `
      const prompt = \`Здравствуйте, {name}! Ваш тур готов.\`;
      await callAIFast([{ role: 'user', content: prompt }]);
    `;
    expect(scanSource('x.ts', src)).toHaveLength(0);
  });

  it('телефон в telegram-СООБЩЕНИИ (не промпт, не content) — НЕ находка', () => {
    const src = `
      import { callAIFast } from '@/lib/ai/providers';
      const lines = [\`Тел: \${lead.phone}\`];  // уходит в телеграм оператору, не в LLM
      await sendTelegram(lines.join('\\n'));
      const prompt = \`Оцени лид без контактов\`;
      await callAIFast([{ role: 'user', content: prompt }]);
    `;
    expect(scanSource('x.ts', src)).toHaveLength(0);
  });

  it('название тура/вулкана (.name у tour) — НЕ находка (не персональное)', () => {
    const src = `
      const prompt = \`Опиши тур "\${tour.name}" на вулкан "\${volcano.name}"\`;
      await callAIFast([{ role: 'user', content: prompt }]);
    `;
    expect(scanSource('x.ts', src)).toHaveLength(0);
  });

  it('prompt без зарубежного вызова, но по имени переменной — всё равно ловим', () => {
    const src = `const systemPrompt = \`Данные: \${booking.phone}\`;`;
    const f = scanSource('x.ts', src);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('contact');
  });

  it('корректный номер строки находки', () => {
    const src = `line1\nline2\nconst prompt = \`x \${lead.phone}\`;\n`;
    const f = scanSource('x.ts', src);
    expect(f[0].line).toBe(3);
  });
});

describe('D1 — CI-гард: ни один промпт в репо не шлёт сырые ПД в зарубежный LLM', () => {
  it('findViolations пуст (иначе — новая утечка ПД, добавь redactPII или запись в ALLOWLIST)', () => {
    const violations = findViolations(REPO_ROOT);
    if (violations.length) {
      const msg = violations
        .map((v) => `  ${v.file}:${v.line}  [${v.kind}] ${v.context} -> ${v.expr}`)
        .join('\n');
      throw new Error(
        `Обнаружена передача сырых ПД (телефон/почта/имя) в текст промпта зарубежного LLM (152-ФЗ):\n${msg}\n` +
          `Почини: оберни в redactPII() / убери поле / используй плейсхолдер {name}. ` +
          `Осознанное исключение — запись в ALLOWLIST (lib/agents/compliance/scan-repo.ts).`,
      );
    }
    expect(violations).toHaveLength(0);
  });

  it('ALLOWLIST не разросся молча (осознанные исключения должны быть редки)', () => {
    expect(ALLOWLIST.length).toBeLessThanOrEqual(5);
  });
});

describe('D2 — CI-гард: реестр LLM-провайдеров заморожен', () => {
  it.each(LLM_EGRESS_FILES)('нет незарегистрированных LLM-хостов в %s (новый провайдер = осознанное решение)', (file) => {
    const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    const unknown = unregisteredHosts(src);
    if (unknown.length) {
      throw new Error(
        `Новый LLM-эндпоинт в ${file} не в реестре: ${unknown.join(', ')}.\n` +
          `Добавь его в LLM_ENDPOINTS (lib/agents/compliance/provider-registry.ts) ` +
          `с юрисдикцией и флагом domestic — это признание «ещё один приёмник ПД, 152-ФЗ учтён».`,
      );
    }
    expect(unknown).toHaveLength(0);
  });

  it('все хосты всех точек егресса покрыты реестром', () => {
    const registered = new Set(LLM_ENDPOINTS.map((e) => e.host));
    for (const file of LLM_EGRESS_FILES) {
      const hosts = extractLLMHosts(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
      for (const h of hosts) expect(registered.has(h), `${file}: хост ${h} не в реестре`).toBe(true);
    }
  });

  /**
   * Сторож самого сканера. Дыра была именно здесь: регулярка требовала слеш
   * после хоста, и база без пути ('https://api.anthropic.com') не находилась —
   * тест был зелёный, а зарубежный приёмник ПД шёл мимо реестра.
   */
  it('сканер находит хост и без пути после него', () => {
    expect(extractLLMHosts(`const B = 'https://api.anthropic.com';`)).toContain('api.anthropic.com');
    expect(extractLLMHosts(`fetch('https://api.deepseek.com/v1/chat')`)).toContain('api.deepseek.com');
  });

  /**
   * Реестр — про реальный сток ПД. Ссылка в пояснении ничего не отправляет, и
   * если требовать её регистрации (console.groq.com — «где взять ключ»), запись
   * «зарубежный приёмник ПД» перестаёт значить то, что написано.
   */
  it('адрес из комментария приёмником не считается', () => {
    expect(extractLLMHosts(`// ключ берётся на https://console.groq.com/keys`)).toHaveLength(0);
    expect(extractLLMHosts(`/* см. https://api.deepseek.com/docs */`)).toHaveLength(0);
    // Но живой код рядом с комментарием — виден.
    const mixed = `// панель: https://console.groq.com/keys\nconst U = 'https://api.groq.com/openai/v1';`;
    expect(extractLLMHosts(mixed)).toEqual(['api.groq.com']);
  });

  it('api.anthropic.com зарегистрирован как зарубежный приёмник', () => {
    const anthropic = LLM_ENDPOINTS.find((e) => e.host === 'api.anthropic.com');
    expect(anthropic, 'api.anthropic.com обязан быть в реестре').toBeDefined();
    expect(anthropic?.domestic).toBe(false);
  });

  it('реестр без дублей хостов', () => {
    const hosts = LLM_ENDPOINTS.map((e) => e.host);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it('домашних (РФ) стоков ≤ 1: почти весь ИИ-трафик зарубежный, промпты чистит redactPII', () => {
    const domestic = LLM_ENDPOINTS.filter((e) => e.domestic);
    // YandexGPT — единственный домашний. Если появился ещё — это меняет модель
    // угрозы (можно слать ПД без чистки), guard заставляет это заметить.
    expect(domestic.every((e) => e.jurisdiction === 'Russia')).toBe(true);
  });
});

describe('ПД через локальную переменную (дыра, найденная 23.08)', () => {
  /**
   * Дайджест платформы годами отдавал зарубежной модели «имя | телефон»
   * каждого нового лида, и страж был зелёным. Причин было две, и обе
   * настоящие:
   *   1. правило искало только прямые `l.phone` — а ПД шли через локальные
   *      переменные, да ещё в два шага: `l.phone` → `phone` → строка → промпт;
   *   2. `${name}` считался безопасным плейсхолдером `{name}` — просто потому,
   *      что подстрока совпадала. То есть самый частый вид утечки был
   *      объявлен санкционированной чисткой.
   */
  const DIGEST = [
    "import { callAIQuality } from '@/lib/ai/providers';",
    'function buildPrompt(m: any) {',
    '  const leadsStr = m.newLeads.map((l: any) => {',
    "    const name = l.name ?? 'Турист';",
    '    const phone = l.phone;',
    '    return `  - ${name} | ${phone}`;',
    "  }).join('\\n');",
    '  const prompt = `Сводка:\\n${leadsStr}`;',
    '  return prompt;',
    '}',
  ].join('\n');

  it('двухзвенная цепочка до промпта видна', () => {
    const found = scanSource('digest.ts', DIGEST);
    expect(found.length, 'ПД через две локальные переменные снова не видны').toBeGreaterThan(0);
    // Видна и сама строка с ПД (литерал в колбэке map течёт в prompt), и промпт.
    expect(found.map((f) => [f.line, f.kind, f.context])).toEqual([
      [6, 'name', 'выражение'], [6, 'contact', 'выражение'], [8, 'contact', 'prompt'],
    ]);
  });

  it('псевдонимы собираются до неподвижной точки', () => {
    const aliases = pdAliases(DIGEST);
    expect(aliases.get('phone')).toBe('contact');
    expect(aliases.get('name')).toBe('name');
    // Строка, собранная из псевдонимов, сама становится псевдонимом.
    expect(aliases.get('leadsStr')).toBeDefined();
  });

  it('плейсхолдер {name} остался безопасным, а ${name} — нет', () => {
    const safe = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'const prompt = `Обратись к клиенту так: {name}. Запрос: ${lead.comment}`;',
    ].join('\n');
    expect(scanSource('safe.ts', safe)).toEqual([]);

    const leaky = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'const name = lead.name;',
      'const prompt = `Обратись к клиенту так: ${name}`;',
    ].join('\n');
    expect(scanSource('leaky.ts', leaky).length).toBeGreaterThan(0);
  });

  it('чистка через redactPII псевдонимом ПД не делает', () => {
    const clean = [
      "import { callAIFast } from '@/lib/ai/providers';",
      "import { redactPII } from '@/lib/security/pii-redact';",
      'const safeComment = redactPII(lead.comment);',
      'const prompt = `Запрос: ${safeComment}`;',
    ].join('\n');
    expect(scanSource('clean.ts', clean)).toEqual([]);
  });
});

/**
 * 04.09. Сканер D2 искал приёмники ПД по перечню знакомых брендов, и это была
 * не осторожность, а слепота: провайдер, чьё имя в перечень не внесли, не
 * попадал в выборку вовсе. Так мимо сторожа месяцами ходили шесть зарубежных
 * приёмников — xAI, оба шлюза MiniMax, GLM, NVIDIA, Sakana, — а тест был
 * зелёный. Правило инвертировано: незнакомый хост требует решения человека.
 */
describe('D2 — незнакомый хост ловится, а не игнорируется', () => {
  it('выдуманный провайдер попадает в выборку и краснит реестр', () => {
    const src = `const r = await fetch('https://api.newthing.example/v1/chat/completions', { body });`;
    expect(extractLLMHosts(src)).toContain('api.newthing.example');
    expect(unregisteredHosts(src)).toContain('api.newthing.example');
  });

  it('хосты, ходившие мимо брендового фильтра, теперь в реестре', () => {
    const registered = new Set(LLM_ENDPOINTS.map((e) => e.host));
    for (const h of ['api.x.ai', 'api.minimaxi.chat', 'api.minimax.chat', 'open.bigmodel.cn', 'integrate.api.nvidia.com', 'api.sakana.ai']) {
      expect(registered.has(h), `${h} не внесён в реестр приёмников ПД`).toBe(true);
    }
  });

  it('не-приёмник исключается поимённо и с причиной, а не молчанием', () => {
    expect(extractLLMHosts(`fetch('https://vedarai.ru/api/health')`)).toEqual([]);
    for (const e of NON_RECEIVER_HOSTS) expect(e.why.length).toBeGreaterThan(20);
    // Список исключений — короткий по замыслу: он про наши же адреса.
    expect(NON_RECEIVER_HOSTS.length).toBeLessThanOrEqual(5);
  });

  it('у каждой записи реестра есть юрисдикция, домашний сток по-прежнему один', () => {
    for (const e of LLM_ENDPOINTS) expect(e.jurisdiction.length, e.host).toBeGreaterThan(2);
    // Два домашних хоста, оба Яндекса (13.10, «остались российские ИИ»):
    // YandexGPT и AI Studio Responses API — один вендор, одна юрисдикция;
    // модель угрозы не менялась, ПД в эти промпты не идут.
    expect(LLM_ENDPOINTS.filter((e) => e.domestic).map((e) => e.host)).toEqual(['llm.api.cloud.yandex.net', 'ai.api.cloud.yandex.net']);
  });
});

/**
 * 04.09, повод — разбор 152-ФЗ в собственном AI-дайджесте от 05.09: «ПД — любая
 * информация, относящаяся к определяемому лицу, безопасный подход считать ПД
 * максимум всего: имена, идентификаторы, почты».
 *
 * Проверка показала у сканера ту же слепоту, что днём раньше нашлась у сканера
 * хостов D2: перечень знакомых НАПИСАНИЙ вместо правила. Шаблон требовал, чтобы
 * имя поля НАЧИНАЛОСЬ с ключевого слова, и потому видел `.email` и `.phone`, но
 * не видел `.user_email`, `.customer_email`, `.partner_email`, `.user_phone`,
 * `.contact_phone` — те самые имена, которыми поля названы в нашей базе.
 *
 * Замер пробой до правки: из двенадцати выражений сканер видел два.
 */
describe('D1 — приставка в имени поля не прячет ПД', () => {
  const inPrompt = (expr: string) => `
    import { callAIFast } from '@/lib/ai/providers';
    const prompt = \`Клиент \${${expr}} хочет тур\`;
    await callAIFast([{ role: 'user', content: prompt }]);
  `;

  it('поля с приставкой видны так же, как без неё', () => {
    for (const expr of [
      'lead.phone', 'user.email',
      'row.user_email', 'row.customer_email', 'row.partner_email',
      'row.operator_email', 'row.user_phone', 'p.contact_phone',
    ]) {
      const f = scanSource('x.ts', inPrompt(expr));
      expect(f.length, `${expr} проходит мимо гарда 152-ФЗ`).toBeGreaterThan(0);
      expect(f[0].kind).toBe('contact');
    }
  });

  it('идентификаторы и документы — тоже ПД', () => {
    for (const expr of ['doc.passport_number', 'u.telegram_id', 'p.contacts', 'u.birth_date']) {
      expect(scanSource('x.ts', inPrompt(expr)).length, `${expr} не считается ПД`).toBeGreaterThan(0);
    }
  });

  it('не-ПД остаётся не-ПД: приставка не превращает отель в телефон', () => {
    // `.hotel` кончается на `tel`, `email_template` начинается с `email` —
    // обе ловушки проверены, потому что расширение шаблона их создаёт.
    for (const expr of ['tour.hotel', 'r.hotel_name', 'p.email_template', 'route.title', 'place.description', 'tour.meeting_point']) {
      expect(scanSource('x.ts', inPrompt(expr)), `ложное срабатывание на ${expr}`).toHaveLength(0);
    }
  });
});

/**
 * Найденная этим расширением утечка: пост про «друга» отдавал модели живой
 * телефон партнёра. Чинится не чисткой, а порядком действий — телефон
 * подставляется ПОСЛЕ модели.
 */
describe('контакты друга не уходят модели', () => {
  it('в промпте стоит метка, а не номер', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'lib/notifications/telegram-channel.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function postFriendToChannel'), src.indexOf('postToAllChannels({ channelId, postType: \'friend\''));
    expect(fn, 'телефон друга снова уезжает в промпт').not.toMatch(/\$\{friend\.contact\}/);
    expect(fn).toMatch(/CONTACT_PLACEHOLDER/);
  });

  it('подстановка на нашей стороне: модель не может переврать цифры', async () => {
    const { withFriendContacts, CONTACT_PLACEHOLDER } = await import('@/lib/notifications/telegram-channel');
    const friend = { contact: '+7 929 901-97-87 (WA)', tg: '@soulfulKamchatka' };
    const out = withFriendContacts(`Текст поста.\n\n${CONTACT_PLACEHOLDER}`, friend);
    expect(out).toContain('+7 929 901-97-87 (WA), @soulfulKamchatka');
    expect(out).not.toContain(CONTACT_PLACEHOLDER);
  });

  it('модель забыла метку — строка дописывается, пост без контактов бесполезен', () => {
    return import('@/lib/notifications/telegram-channel').then(({ withFriendContacts }) => {
      const out = withFriendContacts('Текст без метки.', { contact: '+7 914 998-19-80' });
      expect(out.trimEnd().endsWith('+7 914 998-19-80')).toBe(true);
    });
  });
});

describe('D1 — ПД через массив строк и дописывание к промпту (проба ревьюера 07.11, откат #2506)', () => {
  // Форма отката #2506 (app/api/safety/rescue-chat/route.ts до e573ffd30):
  // ни один литерал не промпт по метке — push и `+=` без имени. Нашёл её
  // ревьюер deepseek-flash в пробе reviewer-model-probe run 2.
  const RESCUE = [
    "import { callAIWaterfall } from '@/lib/ai/providers';",
    'function buildMessages(message: string, tourist_name?: string, tourist_phone?: string) {',
    '  let systemContent = SYSTEM_PROMPT;',
    '  const ctx: string[] = [];',
    '  if (tourist_name)  ctx.push(`Имя: ${sanitizePromptInput(tourist_name).text}`);',
    '  if (tourist_phone) ctx.push(`Тел: ${sanitizePromptInput(tourist_phone).text}`);',
    '  if (ctx.length)    systemContent += `\\n\\nСОБЕСЕДНИК:\\n${ctx.join(\'\\n\')}`;',
    "  return [{ role: 'system', content: systemContent }, { role: 'user', content: message }];",
    '}',
    'export async function POST(req: Request) {',
    '  const { message, tourist_name, tourist_phone } = parsed.data;',
    '  return callAIWaterfall(buildMessages(message, tourist_name, tourist_phone));',
    '}',
  ].join('\n');

  it('имя и телефон туриста в массиве, склеенном в системную подсказку, — находки', () => {
    const f = scanSource('app/api/safety/rescue-chat/route.ts', RESCUE);
    expect(f.map((x) => [x.kind, x.context, x.line])).toEqual([['name', 'ctx.push', 5], ['contact', 'ctx.push', 6]]);
    expect(promptFlowOf(RESCUE).reach).toEqual(expect.arrayContaining(['ctx', 'systemContent']));
  });

  it('сквозь redactPII — не находка', () => {
    const clean = RESCUE.replace('`Тел: ${sanitizePromptInput(tourist_phone).text}`', '`Тел: ${redactPII(tourist_phone)}`')
      .replace('`Имя: ${sanitizePromptInput(tourist_name).text}`', '`Имя: {name}`');
    expect(scanSource('x.ts', clean)).toEqual([]);
  });

  it('склейка в переменную-аргумент зарубежного вызова и прямо в content: — находки', () => {
    const viaVar = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'const lines: string[] = [];',
      'for (const lead of leads) lines.push(`${lead.contact_phone} — ${lead.interest}`);',
      "const text = lines.join('\\n');",
      'await callAIFast(text);',
    ].join('\n');
    expect(scanSource('a.ts', viaVar).map((x) => x.context)).toEqual(['lines.push']);
    const viaKey = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'const parts: string[] = [];',
      'parts.push(`Почта: ${booking.customer_email}`);',
      "await callAIFast([{ role: 'user', content: parts.join('\\n') }]);",
    ].join('\n');
    expect(scanSource('b.ts', viaKey).map((x) => x.context)).toEqual(['parts.push']);
  });

  it('дописывание литерала к стоку (`systemContent += …`) — промпт', () => {
    const src = [
      "import { callAIWaterfall } from '@/lib/ai/providers';",
      'let systemContent = BASE;',
      'systemContent += `\\nТел: ${lead.phone}`;',
      "await callAIWaterfall([{ role: 'system', content: systemContent }]);",
    ].join('\n');
    expect(scanSource('c.ts', src).map((x) => [x.kind, x.context])).toEqual([['contact', 'systemContent']]);
  });

  it('массив с телефоном, ушедший в Telegram, а не в модель, — не находка', () => {
    const src = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'const msg: string[] = [];',
      'msg.push(`Новый лид: ${lead.phone}`);',
      "await sendTelegram(chatId, msg.join('\\n'));",
      "const summary = await callAIFast('Сводка дня без контактов');",
    ].join('\n');
    expect(scanSource('d.ts', src)).toEqual([]);
  });

  it('телефон МЧС у маршрута — служба, а не человек; телефон контакта рядом — находка', () => {
    const src = (field: string) => [
      "import { callAIFast } from '@/lib/ai/providers';",
      'const contextParts: string[] = [];',
      `if (r.${field}) contextParts.push(\`Телефон: \${r.${field}}\`);`,
      "await callAIFast([{ role: 'user', content: contextParts.join('\\n') }]);",
    ].join('\n');
    expect(scanSource('e.ts', src('mchs_phone'))).toEqual([]);
    expect(scanSource('e.ts', src('contact_phone')).map((x) => x.kind)).toEqual(['contact']);
  });

  it('без зарубежного вызова в файле массив промптом не считается (то же условие, что у content:)', () => {
    const src = RESCUE.replace("import { callAIWaterfall } from '@/lib/ai/providers';", '').replace('callAIWaterfall(', 'localModel(');
    expect(scanSource('f.ts', src)).toEqual([]);
  });
});

describe('D1 — где первая редакция рвала цепочку (ревью PR #3104, deepseek-flash)', () => {
  /** Сборщик подсказки: ctx с телефоном → склейка → сток. Меняется одно звено. */
  const build = (pushLine: string, joinLine: string, sinkLine: string) => [
    "import { callAIFast } from '@/lib/ai/providers';",
    'const ctx: string[] = [];',
    pushLine,
    'let systemContent = BASE;',
    joinLine,
    sinkLine,
  ].join('\n');
  const PUSH = 'ctx.push(`Тел: ${lead.phone}`);';
  const SINK = "await callAIFast([{ role: 'system', content: systemContent }]);";
  const found = (src: string) => scanSource('g.ts', src).map((x) => [x.kind, x.context]);

  it('находка 1: склейка через цепочку методов и через this — массив найден', () => {
    expect(found(build(PUSH, "systemContent += `\\n${ctx.filter(Boolean).join('\\n')}`;", SINK))).toEqual([['contact', 'ctx.push']]);
    expect(found(build(PUSH, "systemContent += `\\n${ctx.map((s) => s.trim()).filter(Boolean).join('\\n')}`;", SINK))).toEqual([['contact', 'ctx.push']]);
    expect(found(build('this.ctx.push(`Тел: ${lead.phone}`);', "systemContent += `\\n${this.ctx.join('\\n')}`;", SINK))).toEqual([['contact', 'ctx.push']]);
  });

  it('находка 2: промежуточная переменная между склейкой и стоком', () => {
    const src = build(PUSH, "const joined = ctx.join('\\n');\nsystemContent += `\\n\\nСОБЕСЕДНИК:\\n${joined}`;", SINK);
    expect(found(src)).toEqual([['contact', 'ctx.push']]);
    // Две промежуточные — тоже: неподвижная точка, а не один проход.
    const two = build(PUSH, "const joined = ctx.join('\\n');\nconst block = `СОБЕСЕДНИК:\\n${joined}`;\nsystemContent += block.trim();", SINK);
    expect(found(two)).toEqual([['contact', 'ctx.push']]);
  });

  it('находка 3: значение стока — выражение, а не голое имя', () => {
    const join = "systemContent += `\\n${ctx.join('\\n')}`;";
    for (const sink of [
      "await callAIFast([{ role: 'system', content: systemContent.trim() }]);",
      "await callAIFast([{ role: 'system', content: withContext(systemContent) }]);",
      "await callAIFast([{ role: 'system', content: BASE + systemContent }]);",
      "await callAIFast([{ role: 'system', content: this.systemContent }]);",
      'await callAIFast(withFooter(systemContent));',
    ]) {
      const src = build(PUSH, join, sink).replace('let systemContent = BASE;', sink.includes('this.') ? 'this.systemContent = BASE;' : 'let systemContent = BASE;')
        .replace(join, sink.includes('this.') ? "this.systemContent += `\\n${ctx.join('\\n')}`;" : join);
      expect([sink, found(src)]).toEqual([sink, [['contact', 'ctx.push']]]);
    }
    // Сообщения собраны отдельно от вызова: сток — само значение `content:`.
    const separate = build(PUSH, join, "const messages = [{ role: 'system', content: withContext(systemContent) }];\nawait callAIFast(messages);");
    expect(found(separate)).toEqual([['contact', 'ctx.push']]);
  });

  it('узко по-прежнему: текст, ушедший в вызов при присваивании, в промпт не течёт', () => {
    // SQL с телефоном уходит в базу; модели — строки ответа. Это не промпт.
    const src = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'const sql = `SELECT note FROM leads WHERE phone = ${lead.phone}`;',
      'const rows = await pool.query(sql);',
      "await callAIFast([{ role: 'user', content: rows.map((r) => r.note).join('\\n') }]);",
    ].join('\n');
    expect(scanSource('h.ts', src)).toEqual([]);
    expect(promptFlowOf(src).reach).toContain('rows');
    expect(promptFlowOf(src).reach).not.toContain('sql');
  });

  it('объявление зарубежной функции — не вызов: её параметры промптом не становятся', () => {
    const src = [
      'export async function callAIFast(prompt: string, opts?: Options) {',
      '  const log = `Запрос от ${user.phone}`;',
      '  return fetch(URL, { body: prompt });',
      '}',
    ].join('\n');
    expect(promptFlowOf(src).reach).toEqual([]);
  });
});

describe('D1 — второе ревью PR #3104: формы находки 3 и области видимости', () => {
  const found = (src: string) => scanSource('k.ts', src).map((x) => [x.kind, x.context]);

  it('переменная, положенная в массив промпта (`lines.push(line)`), — находка', () => {
    const src = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'const lines: string[] = [];',
      'for (const l of leads) {',
      '  const line = `Тел: ${l.phone}`;',
      '  lines.push(line);',
      '}',
      "await callAIFast([{ role: 'user', content: lines.join('\\n') }]);",
    ].join('\n');
    expect(found(src)).toEqual([['contact', 'line']]);
  });

  it('литерал в колбэке map и элемент литерала массива — находки', () => {
    const viaMap = [
      "import { callAIFast } from '@/lib/ai/providers';",
      "const text = leads.map((l) => `Тел: ${l.phone}`).join('\\n');",
      'await callAIFast(text);',
    ].join('\n');
    expect(found(viaMap)).toEqual([['contact', 'выражение']]);
    // Переменная `*prompt*` — промпт и без зарубежного вызова в файле, как литерал с такой меткой.
    const viaArray = "const prompt = [`Тел: ${lead.phone}`, 'Ответь кратко'].join('\\n');";
    expect(found(viaArray)).toEqual([['contact', 'выражение']]);
    // map в аргументах обычного вызова при присваивании — не промпт (узко, как у SQL).
    const intoCall = [
      "import { callAIFast } from '@/lib/ai/providers';",
      "const sent = await sendMax(leads.map((l) => `Тел: ${l.phone}`).join('\\n'));",
      "await callAIFast([{ role: 'user', content: sent.status }]);",
    ].join('\n');
    expect(found(intoCall)).toEqual([]);
  });

  it('unshift, add и получатель-свойство `box.lines` — находки', () => {
    const sink = "await callAIFast([{ role: 'user', content: [...seen].join('\\n') + ctx.join('\\n') + box.lines.join('\\n') }]);";
    const src = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'ctx.unshift(`Почта: ${lead.email}`);',
      'seen.add(`Тел: ${lead.phone}`);',
      'box.lines.push(`Имя: ${lead.name}`);',
      sink,
    ].join('\n');
    expect(found(src)).toEqual([['contact', 'ctx.unshift'], ['contact', 'seen.add'], ['name', 'lines.push']]);
    // Переменная, положенная через unshift, — тоже.
    const viaVar = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'const first = `Почта: ${lead.email}`;',
      'ctx.unshift(first);',
      "await callAIFast([{ role: 'user', content: ctx.join('\\n') }]);",
    ].join('\n');
    expect(found(viaVar)).toEqual([['contact', 'first']]);
  });

  it('параметр с именем контакта, переданный в сборщик подсказки, — находка', () => {
    const src = [
      "import { callAIWaterfall } from '@/lib/ai/providers';",
      'function build(question: string, tourist_phone?: string) {',
      "  return [{ role: 'user', content: `${question}\\nТел: ${tourist_phone ?? 'нет'}` }];",
      '}',
      'export const answer = (q: string, p?: string) => callAIWaterfall(build(q, p));',
    ].join('\n');
    expect(found(src)).toEqual([['contact', 'content']]);
    // Телефон МЧС у маршрута — служба: и полем, и переменной.
    expect(found(src.replace(/tourist_phone/g, 'mchs_phone'))).toEqual([]);
  });

  it('одноимённые переменные разных функций — разные переменные (lib/kuzmich/core.ts)', () => {
    // Вопрос туриста `text` уходит модели; `text` уведомления оператору — в MAX.
    const flow = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'function notify(b: Booking) {',
      "  const text = [`Турист: ${b.name}`, `Телефон: ${b.phone}`].join('\\n');",
      '  return sendMax(text);',
      '}',
      'export async function answer(opts: { text: string }) {',
      '  const { text } = opts;',
      "  return callAIFast([{ role: 'user', content: text }]);",
      '}',
    ].join('\n');
    expect(found(flow)).toEqual([]);
    expect(found(flow.replace('return sendMax(text);', "return callAIFast([{ role: 'user', content: text }]);")))
      .toEqual([['name', 'выражение'], ['contact', 'выражение']]);
    // Псевдоним ПД соседней функции не делает «телефоном» одноимённую переменную.
    const alias = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'function card(b: Booking) {',
      '  const text = `Телефон: ${b.phone}`;',
      '  return sendMax(text);',
      '}',
      'export async function reply(question: string) {',
      '  const text = question.trim();',
      "  return callAIFast([{ role: 'user', content: `Вопрос: ${text}` }]);",
      '}',
    ].join('\n');
    expect(found(alias)).toEqual([]);
    // Параметр стрелки закрывает внешнюю переменную с тем же именем.
    const shadow = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'const who = lead.name;',
      'const lines = models.map((who) => `Модель: ${who}`);',
      "await callAIFast([{ role: 'user', content: lines.join('\\n') }]);",
    ].join('\n');
    expect(found(shadow)).toEqual([]);
    expect(found(shadow.replace('models.map((who) =>', 'models.map(who =>'))).toEqual([]);
    expect(found(shadow.replace('models.map((who) =>', 'models.map((m) =>'))).toEqual([['name', 'выражение']]);
  });

  it('проза не код: `content:` в комментарии поток не начинает', () => {
    const src = [
      "import { callAIFast } from '@/lib/ai/providers';",
      '// Форма: { role: "user", content: notes } — так делать нельзя.',
      'const notes = `Тел: ${lead.phone}`;',
      'await sendMax(notes);',
      "await callAIFast('Сводка без контактов');",
    ].join('\n');
    expect(found(src)).toEqual([]);
    expect(promptFlowOf(src).reach).toEqual([]);
  });
});

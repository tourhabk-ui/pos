import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { readFileSync, readdirSync, statSync } from 'fs';
import { scanSource, pdAliases, promptFlowOf, maskCode, sqlRowKinds, sqlRow, FOREIGN_LLM_CALLERS, DOMESTIC_LLM_CALLERS, EGRESS_DOORS, CONTACT_WORD, REDACTABLE_WORD, IDENT_WORD } from '@/lib/agents/compliance/pii-flow-scanner';
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
  it('findViolations пуст (иначе — новая утечка ПД: телефон и почту — redactPII, имя — убрать; или запись в ALLOWLIST)', () => {
    const violations = findViolations(REPO_ROOT);
    if (violations.length) {
      const msg = violations
        .map((v) => `  ${v.file}:${v.line}  [${v.kind}] ${v.context} -> ${v.expr}`)
        .join('\n');
      throw new Error(
        `Обнаружена передача сырых ПД (телефон/почта/имя) в текст промпта зарубежного LLM (152-ФЗ):\n${msg}\n` +
          `Почини: телефон и почту — redactPII(); имя — убери поле или плейсхолдер {name} (redactPII имён не чистит). ` +
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

  it('вызов в правой части: что он делает с текстом, страж не знает, — имена текут через него', () => {
    // Параметризованный SQL (CLAUDE.md §4): телефон — аргумент запроса, а не текст; находки нет.
    const param = [
      "import { callAIFast } from '@/lib/ai/providers';",
      "const rows = await pool.query('SELECT note FROM leads WHERE phone = $1', [lead.phone]);",
      "await callAIFast([{ role: 'user', content: rows.map((r) => r.note).join('\\n') }]);",
    ].join('\n');
    expect(scanSource('h.ts', param)).toEqual([]);
    expect(promptFlowOf(param).reach).toContain('rows');
    // Склейка через незнакомые вызовы (`format(ctx)`, `Object.values(…)`) — массив найден.
    const viaCall = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'ctx.push(`Тел: ${lead.phone}`);',
      "const block = Object.values(format(ctx)).join('\\n');",
      "await callAIFast([{ role: 'user', content: block }]);",
    ].join('\n');
    expect(scanSource('h.ts', viaCall).map((x) => [x.kind, x.context])).toEqual([['contact', 'ctx.push']]);
    // Сквозь redactPII имена дальше не текут: там ПД уже нет.
    const cleaned = viaCall.replace("Object.values(format(ctx)).join('\\n')", "redactPII(ctx.join('\\n'))");
    expect(scanSource('h.ts', cleaned)).toEqual([]);
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
    // Колбэк reduce и аргумент незнакомого вызова — тоже (третье ревью #3104):
    // что вызов делает с текстом, страж не знает, и литерал проверяет.
    const viaReduce = [
      "import { callAIFast } from '@/lib/ai/providers';",
      "const text = leads.reduce((acc, l) => acc + `\\nТел: ${l.phone}`, '');",
      "await callAIFast([{ role: 'user', content: text }]);",
    ].join('\n');
    expect(found(viaReduce)).toEqual([['contact', 'выражение']]);
    const viaCall = viaReduce.replace("leads.reduce((acc, l) => acc + `\\nТел: ${l.phone}`, '')", 'fmt(`Тел: ${lead.phone}`)');
    expect(found(viaCall)).toEqual([['contact', 'fmt']]);
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

describe('D1 — третье ревью PR #3104: строка из функции файла', () => {
  const found = (src: string) => scanSource('m.ts', src).map((x) => [x.kind, x.context]);
  const CALL = "await callAIFast([{ role: 'user', content: line(lead) }]);";
  const IMPORT = "import { callAIFast } from '@/lib/ai/providers';";

  it('функция-помощник, вызванная в стоке, — её строка в потоке', () => {
    const decl = [IMPORT, 'function line(l: { phone: string }) {', '  return `Тел: ${l.phone}`;', '}', CALL].join('\n');
    expect(found(decl)).toEqual([['contact', 'выражение']]);
    // Стрелка-выражение; стрелка-блок, возвращающая переменную.
    const arrow = [IMPORT, 'const line = (l: Lead) => `Тел: ${l.phone}`;', CALL].join('\n');
    expect(found(arrow)).toEqual([['contact', 'выражение']]);
    const viaVar = [IMPORT, 'const line = async (l: Lead) => {', '  const s = `Тел: ${l.phone}`;', '  return s;', '};', CALL].join('\n');
    expect(found(viaVar)).toEqual([['contact', 's']]);
  });

  it('метод через this и вызов внутри промпта по метке', () => {
    const method = [
      IMPORT,
      'class Digest {',
      '  describe(l: Lead) { return `Тел: ${l.phone}`; }',
      "  ask(l: Lead) { return callAIFast([{ role: 'user', content: this.describe(l) }]); }",
      '}',
    ].join('\n');
    expect(found(method)).toEqual([['contact', 'выражение']]);
    const inPrompt = ['function line(l: Lead) { return `Тел: ${l.phone}`; }', 'const prompt = `Данные: ${line(lead)}`;'].join('\n');
    expect(found(inPrompt)).toEqual([['contact', 'выражение']]);
  });

  it('узко: помощник для Telegram и `return` вложенной функции — не находки', () => {
    const telegram = [IMPORT, 'function card(l: Lead) { return `Тел: ${l.phone}`; }', 'await sendMax(card(lead));', "await callAIFast('Сводка без контактов');"].join('\n');
    expect(found(telegram)).toEqual([]);
    const nested = [
      IMPORT,
      'function outer(x: Lead) {',
      '  const f = () => { return `Тел: ${x.phone}`; };',
      '  void sendMax(f());',
      "  return 'готово';",
      '}',
      "await callAIFast([{ role: 'user', content: outer(lead) }]);",
    ].join('\n');
    expect(found(nested)).toEqual([]);
    // Литерал, отданный redactPII, очищен: проверять в нём нечего.
    expect(found([IMPORT, "await callAIFast([{ role: 'user', content: redactPII(`Тел: ${lead.phone}`) }]);"].join('\n'))).toEqual([]);
    expect(found([IMPORT, "await callAIFast([{ role: 'user', content: trim(`Тел: ${lead.phone}`) }]);"].join('\n'))).toEqual([['contact', 'trim']]);
  });

  it('поле ПД — обращение в коде, а не текст строки', () => {
    // Фото из Telegram уходит модели зрения; адрес API с `.telegram.org` — не ПД.
    const src = [IMPORT, "const url = `${process.env.TG_BASE || 'https://api.telegram.org'}/file/${path}`;", "await callAIFast([{ role: 'user', content: url }]);"].join('\n');
    expect(found(src)).toEqual([]);
    expect(found(src.replace('${path}', '${lead.telegram}'))).toEqual([['contact', 'url']]);
    // То же для чистимых слов: `.phone` в адресе внутри строки — не поле.
    const phoneUrl = [IMPORT, "const url = `${process.env.SMS_BASE || 'https://api.phone.example'}/send/${path}`;", "await callAIFast([{ role: 'user', content: url }]);"].join('\n');
    expect(found(phoneUrl)).toEqual([]);
    expect(found(phoneUrl.replace('${path}', '${lead.phone}'))).toEqual([['contact', 'url']]);
  });
});

describe('D1 — четвёртое ревью PR #3104: перенос строки и поле класса', () => {
  const found = (src: string) => scanSource('n.ts', src).map((x) => [x.kind, x.context]);
  const IMPORT = "import { callAIFast } from '@/lib/ai/providers';";

  it('правая часть на следующей строке и склейка через `+` в конце строки', () => {
    // Так записан lib/agents/platform-agent.ts: по литералу на строку.
    const plus = [
      IMPORT,
      'async function ask(lead: Lead, user: User) {',
      '  const prompt =',
      '    `Определи намерение одним словом.\\n` +',
      '    `Почта: ${user.email}\\n`;',
      "  return callAIFast([{ role: 'user', content: prompt }]);",
      '}',
    ].join('\n');
    expect(found(plus)).toEqual([['contact', 'выражение']]);
    // Тот же смысл в одну строку и с переносом после `=` — один вердикт.
    const oneLine = [IMPORT, "const text = leads.map((l) => `Тел: ${l.phone}`).join('\\n');", "await callAIFast([{ role: 'user', content: text }]);"].join('\n');
    const wrapped = oneLine.replace('const text = ', 'const text =\n  ');
    expect(found(oneLine)).toEqual([['contact', 'выражение']]);
    expect(found(wrapped)).toEqual(found(oneLine));
    // Конец выражения без точки с запятой — по-прежнему конец: следующая строка не тянется.
    const asi = [IMPORT, "const text = 'Сводка без контактов'", 'const card = `Тел: ${lead.phone}`', 'await sendMax(card)', "await callAIFast([{ role: 'user', content: text }])"].join('\n');
    expect(found(asi)).toEqual([]);
  });

  it('поле класса: `this.x = …` — ребро, как у переменной', () => {
    const src = [
      IMPORT,
      'class Prompter {',
      "  private systemContent = '';",
      '  build(lead: Lead) {',
      "    this.systemContent = [`Тел: ${lead.phone}`].join('\\n');",
      "    return callAIFast([{ role: 'user', content: this.systemContent }]);",
      '  }',
      '}',
    ].join('\n');
    expect(found(src)).toEqual([['contact', 'выражение']]);
  });
});

describe('D1 — пятое ревью PR #3104: реестр дверей, чистка по роду ПД, обёртка', () => {
  const found = (src: string) => scanSource('p.ts', src).map((x) => [x.kind, x.context]);

  it('реестр зарубежных дверей полон: каждый экспорт call* провайдеров решён', () => {
    const providers = readFileSync(resolve(REPO_ROOT, 'lib/ai/providers.ts'), 'utf8');
    const exported = [...providers.matchAll(/^export (?:async )?function (call[A-Z]\w*)/gm)].map((m) => m[1]);
    expect(exported.length).toBeGreaterThan(30);
    const decided = new Set<string>([...FOREIGN_LLM_CALLERS, ...DOMESTIC_LLM_CALLERS]);
    const undecided = exported.filter((f) => !decided.has(f));
    expect(undecided, `новая дверь к модели без решения «зарубежная/домашняя»: ${undecided.join(', ')}`).toEqual([]);
    // Запись без функции — устаревшая: страж сторожил бы не ту дверь.
    const stale = [...decided].filter((f) => !exported.includes(f));
    expect(stale).toEqual([]);
    const both = FOREIGN_LLM_CALLERS.filter((f) => (DOMESTIC_LLM_CALLERS as readonly string[]).includes(f));
    expect(both).toEqual([]);
  });

  it('двери, которых не было в реестре, — стоки', () => {
    const quality = [
      "import { callAIQuality } from '@/lib/ai/providers';",
      'const parts: string[] = [];',
      'parts.push(`Клиент ${lead.name}, тел. ${lead.phone}`);',
      "await callAIQuality([{ role: 'user', content: parts.join('\\n') }]);",
    ].join('\n');
    expect(found(quality)).toEqual([['name', 'parts.push'], ['contact', 'parts.push']]);
    const orNull = [
      "import { callAIFastOrNull } from '@/lib/ai/providers';",
      'const ctx: string[] = [];',
      'ctx.push(`Тел: ${lead.phone}`);',
      "await callAIFastOrNull(ctx.join('\\n'));",
    ].join('\n');
    expect(found(orNull)).toEqual([['contact', 'ctx.push']]);
  });

  it('redactPII режет телефон и почту, но не имя', () => {
    const IMPORT = "import { callAIFast } from '@/lib/ai/providers';";
    expect(found([IMPORT, 'const prompt = `Клиент ${redactPII(lead.name)} хочет тур`;'].join('\n'))).toEqual([['name', 'prompt']]);
    expect(found([IMPORT, "await callAIFast([{ role: 'user', content: redactPII(`Клиент ${lead.name}`) }]);"].join('\n')))
      .toEqual([['name', 'redactPII']]);
    // Телефон сквозь redactPII — по-прежнему не находка.
    expect(found([IMPORT, "await callAIFast([{ role: 'user', content: redactPII(`Тел: ${lead.phone}`) }]);"].join('\n'))).toEqual([]);
    expect(found([IMPORT, 'const prompt = `Тел: ${redactPII(lead.phone)}`;'].join('\n'))).toEqual([]);
    // Чистка по месту: телефон рядом с очищенным полем — находка (регрессия stmtEnd).
    const near = [IMPORT, 'const line = lead.phone +', '  redactPII(lead.comment);', 'const prompt = `Заявка: ${line}`;', "await callAIFast([{ role: 'user', content: prompt }]);"].join('\n');
    expect(found(near)).toEqual([['contact', 'prompt']]);
    expect(found(near.replace('lead.phone +\n  redactPII(lead.comment)', 'redactPII(lead.phone + lead.comment)'))).toEqual([]);
  });

  it('аргумент вызова функции файла — её параметр: тонкая обёртка над дверью', () => {
    const wrapper = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'async function askModel(prompt: string) {',
      "  return callAIFast([{ role: 'user', content: prompt }]);",
      '}',
      'export const run = (lead: Lead) => askModel(`Клиент ${lead.phone} оставил заявку`);',
    ].join('\n');
    expect(found(wrapper)).toEqual([['contact', 'askModel']]);
    // Обёртка, которая шлёт в MAX, а не модели, — не находка.
    const notify = [
      "import { callAIFast } from '@/lib/ai/providers';",
      'function notify(text: string) { return sendMax(text); }',
      'notify(`Тел: ${lead.phone}`);',
      "await callAIFast('Сводка без контактов');",
    ].join('\n');
    expect(found(notify)).toEqual([]);
  });
});

describe('D1 — шестое ревью PR #3104: деление или регулярное выражение', () => {
  const found = (src: string, file = 'p.ts') => scanSource(file, src).map((x) => [x.kind, x.context]);
  const IMPORT = "import { callAIFast } from '@/lib/ai/providers';";
  const SEND = "  await callAIFast([{ role: 'user', content: prompt }]);";
  const fn = (params: string, ...body: string[]) => [IMPORT, `export async function digest(${params}) {`, ...body, SEND, '}'].join('\n');
  const PROMPT = 'const prompt = `Лид: ${lead.phone}`;';

  it('сценарий ревьюера: деление после `++`/`--` не гасит ПД ни одного рода', () => {
    expect(found(fn('lead: Lead, shown: number, total: number',
      '  const rate = shown++ / total, prompt = `Лид: ${lead.phone} — ${shown}/${total}`;'))).toEqual([['contact', 'prompt']]);
    expect(found(fn('lead: Lead, shown: number, total: number',
      '  const rate = shown-- / total, prompt = `Лид: ${lead.name} — ${shown}/${total}`;'))).toEqual([['name', 'prompt']]);
  });

  // `sep = \`/.\`` — то, что проходит все проверки «выражения» (в теле один
  // бэктик, за `/` точка): если `/` после операнда принята за начало выражения,
  // затирается открывающий бэктик шаблона, и промпт за ним не виден.
  it('`++`, `--`, `!` TypeScript и свойство с именем ключевого слова — деление', () => {
    for (const division of ['shown++ / total', 'shown-- / total', 'count! / total', 'io.in / total']) {
      expect(found(fn('lead: Lead, shown: number, total: number, count?: number, io: { in: number }',
        `  const rate = ${division}, sep = \`/.\`; ${PROMPT}`)), division).toEqual([['contact', 'prompt']]);
    }
  });

  it('выражение после `=>` и выражение с кавычкой не сбивают разбор шаблонов', () => {
    // Прежний разбор литералов регулярных выражений не знал: три бэктика забора
    // кода открывали шаблон, апостроф — строку до следующей кавычки файла.
    expect(found(fn('lead: Lead, lines: string[]',
      '  const fence = lines.filter((l) => /```/.test(l));', `  ${PROMPT}`))).toEqual([['contact', 'prompt']]);
    expect(found(fn('lead: Lead, text: string', "  const clean = text.replace(/'/g, '');", `  ${PROMPT}`)))
      .toEqual([['contact', 'prompt']]);
    // `as` за выражением — законное продолжение: выражение с апострофом маскируется.
    expect(found(fn('lead: Lead', `  const quote = /'/g as RegExp; ${PROMPT}`))).toEqual([['contact', 'prompt']]);
  });

  it('ошибка выбора не затирает код: `${`, имя или число за `/` и несобираемое тело — не выражение', () => {
    // `of` здесь имя параметра, а не ключевое слово: `/` после него принимается
    // за начало выражения. Каждая строка проходит все проверки, кроме одной.
    const cases = [
      `const half = of / 2; const prompt = \`Лид: \${lead.phone} — \${half}/(1)\`;`, // подстановка в «теле»
      `const half = of / 2, s = \`a\`, t = \`b/1\`; ${PROMPT}`, // за «выражением» число
      `const half = of / 2, s = \`(/(1)\`; ${PROMPT}`, // «тело» не собирается
    ];
    for (const line of cases) expect(found(fn('lead: Lead, of: number', `  ${line}`)), line).toEqual([['contact', 'prompt']]);
  });

  it('скобка в строке внутри `${…}` подстановку не закрывает', () => {
    expect(found(fn('lead: Lead, short: boolean', "  const prompt = `Лид: ${short ? '}' : lead.phone}`;"))).toEqual([['contact', 'prompt']]);
  });

  it('апостроф в тексте JSX съедает только свою строку, длинный className — проза', () => {
    const tsx = [IMPORT, "export function Card() { return <p>Don't</p>; }", 'export async function digest(lead: Lead) {', `  ${PROMPT}`, SEND, '}'].join('\n');
    expect(found(tsx, 'p.tsx')).toEqual([['contact', 'prompt']]);
    const masked = maskCode('<div className="flex\n  items-center lead.phone">x</div>');
    expect(masked).not.toContain('items-center');
    expect(masked).not.toContain('lead.phone');
  });
});

describe('D1 — седьмое ревью PR #3104: двери, значение стока, род ПД по рёбрам', () => {
  const found = (src: string) => scanSource('q.ts', src).map((x) => [x.kind, x.context]);
  const FAST = "import { callAIFast } from '@/lib/ai/providers';";
  const SDK = "import { runSDKAgent } from '@/lib/agents/sdk/sdk-runner';";
  const ask = (...lines: string[]) => [FAST, ...lines].join('\n');

  it('реестр дверей вне провайдеров сверен с файлами: хост модели в коде — запись, экспорт — решение', () => {
    const foreign = new Set(LLM_ENDPOINTS.filter((e) => !e.domestic).map((e) => e.host));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(resolve(REPO_ROOT, dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(resolve(REPO_ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name)) files.push(rel);
      }
    };
    walk('lib');
    const egress = files.filter((f) => f !== 'lib/ai/providers.ts' && f !== 'lib/agents/compliance/provider-registry.ts'
      && extractLLMHosts(readFileSync(resolve(REPO_ROOT, f), 'utf8')).some((h) => foreign.has(h)));
    expect(egress.length).toBeGreaterThan(5);
    expect(Object.keys(EGRESS_DOORS).sort(), 'файл с зарубежным хостом модели без решения по дверям').toEqual(egress.sort());
    for (const f of egress) {
      const src = readFileSync(resolve(REPO_ROOT, f), 'utf8');
      const exported = [
        ...[...src.matchAll(/^export (?:async )?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]),
        ...[...src.matchAll(/^export const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/gm)].map((m) => m[1]),
      ].sort();
      const entry = EGRESS_DOORS[f];
      expect([...entry.doors, ...entry.others].sort(), `${f}: экспорт без решения «дверь или нет»`).toEqual(exported);
      expect(entry.why.length, f).toBeGreaterThan(20);
    }
  });

  it('находка 1: дверь вне провайдеров, прямой fetch к зарубежному хосту и ключ userMessage — стоки', () => {
    // Дословно сценарий ревьюера.
    expect(found([SDK, "await runSDKAgent({ agentId: 'operator', intent: 'operator_management',", '  systemPrompt: base, userMessage: `Клиент: ${lead.phone}`, tools, model });'].join('\n')))
      .toEqual([['contact', 'userMessage']]);
    const fetchRoute = ["const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {", "  method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content: `Тел: ${lead.phone}` }] }),", '});'].join('\n');
    expect(found(fetchRoute)).toEqual([['contact', 'content']]);
    // Адрес в комментарии — не выход: стоков нет, как и раньше.
    expect(found(fetchRoute.replace("fetch('https://openrouter.ai/api/v1/chat/completions'", "fetch(LOCAL /* https://openrouter.ai */"))).toEqual([]);
    expect(found([SDK, "const opts = { agentId: 'a', userMessage: 'Клиент: ' + lead.phone };", 'await runSDKAgent(opts);'].join('\n')))
      .toEqual([['contact', 'userMessage']]);
  });

  it('находка 2: ПД в самом значении стока, без шаблона, — находки', () => {
    expect(found(ask("await callAIFast([{ role: 'user', content: lead.email }]);"))).toEqual([['contact', 'content']]);
    expect(found(ask("await callAIFast([{ role: 'user', content: 'Клиент: ' + lead.phone }]);"))).toEqual([['contact', 'content']]);
    expect(found(ask("await callAIFast([{ role: 'user', content: [lead.name, lead.phone].join(', ') }]);")))
      .toEqual([['contact', 'content'], ['name', 'content']]);
    // Одна утечка — одна находка: значение переменной-промпта судится в нём самом, не в двери.
    expect(found(ask("const prompt = 'Клиент: ' + lead.phone;", 'await callAIFast(prompt);'))).toEqual([['contact', 'prompt']]);
    expect(found(ask("const text = 'Клиент: ' + lead.phone;", 'await callAIFast(text);'))).toEqual([['contact', 'callAIFast']]);
  });

  it('находка 3: род ПД идёт через параметр, поле и голое присваивание', () => {
    // Дословно три сценария ревьюера.
    expect(found(ask("function ask(v: string) { return callAIFast([{ role: 'user', content: `Заявка: ${v}` }]); }", 'ask(lead.phone);')))
      .toEqual([['contact', 'content']]);
    expect(found(ask('class A { async run(lead: Lead) {', '  this.ctx = lead.phone;', "  await callAIFast([{ role: 'user', content: `Почта: ${this.ctx}` }]);", '} }')))
      .toEqual([['contact', 'content']]);
    expect(found(ask('const a = lead.phone;', 'const b = a;', "await callAIFast([{ role: 'user', content: `Клиент: ${b}` }]);")))
      .toEqual([['contact', 'content']]);
  });

  it('род ПД: поле объекта, литерал объекта, элемент перебора, индекс, Map.set, функция файла, Promise.all', () => {
    const sink = (expr: string) => `await callAIFast([{ role: 'user', content: ${expr} }]);`;
    const cases: Array<[string, string[]]> = [
      ['box.value', ['box.value = lead.phone;', sink('`Клиент: ${box.value}`')]],
      ['весь объект', ['box.value = lead.phone;', sink('JSON.stringify(box)')]],
      ['литерал объекта', ["const ctx = { note: 'Тел: ' + lead.phone };", sink('`Данные: ${ctx.note}`')]],
      // Имя массива нейтральное: род у элемента — от `l.phone` внутри колбэка, а не от имени `phones`.
      ['перебор', ['const nums = leads.map((l) => l.phone);', "const text = nums.map((p) => `Тел: ${p}`).join('\\n');", sink('text')]],
      ['индекс', ['const parts: string[] = [];', 'parts[0] = lead.phone;', sink("parts.join(' ')")]],
      ['Map.set', ['const m = new Map<string, string>();', "m.set('tel', lead.phone);", sink("[...m.values()].join(' ')")]],
      ['функция файла', ["function line(l: Lead) { return 'Тел: ' + l.phone; }", sink('line(lead)')]],
    ];
    for (const [label, lines] of cases) expect(found(ask(...lines)).map((f) => f[0]), label).toEqual(['contact']);
    // Promise.all — по позициям: телефон у первого, название у второго.
    const all = ask('const [tel, title] = await Promise.all([loadPhone(lead.phone), loadTitle()]);', sink('`${title}`'), sink('`${tel}`'));
    expect(scanSource('q.ts', all).map((f) => [f.line, f.kind])).toEqual([[4, 'contact']]);
  });

  it('однобуквенный владелец имени: тип человека и for…of по лидам — имя, тип файла — нет', () => {
    const sink = "  return callAIFast([{ role: 'user', content: `Кому: ${who}` }]);";
    expect(found(ask('function f(b: Booking) {', '  const who = b.name;', sink, '}'))).toEqual([['name', 'content']]);
    expect(found(ask('function f(b: Buffer) {', '  const who = b.name;', sink, '}'))).toEqual([]);
    expect(found(ask('const lines: string[] = [];', 'for (const l of leads) { const who = l.name; lines.push(who); }', "await callAIFast(lines.join('\\n'));")))
      .toEqual([['name', 'callAIFast']]);
  });

  it('узость: поле строки из базы, поле объекта-параметра, имя модели, адрес гостиницы, параметры SQL, длина', () => {
    const sink = (expr: string) => `await callAIFast([{ role: 'user', content: ${expr} }]);`;
    const cases: Array<[string, string[]]> = [
      // Имя автора в строке есть, в промпт идут название тура и очищенный текст (analyze/route.ts).
      ['поле строки', ['const result = await query(`SELECT r.comment, u.name as user_name, t.title as tour_name FROM reviews r`, [id]);',
        'const review = result.rows[0];', sink('`Тур ${review.tour_name}: ${redactPII(review.comment)}`')]],
      // Деструктуризация объекта — чтение полей: text не получает рода fromName.
      ['поле параметра', ['async function f(opts: { fromName: string; text: string }) {', '  const { fromName, text } = opts;', '  ' + sink('text'), '}',
        'f({ fromName: msg.from.first_name, text: msg.text });']],
      // `m.name` модели — не имя человека.
      ['имя модели', ["const ids = (data.models ?? []).map((m) => m.name.replace(/^models\\//, ''));", 'const model = ids[0];', sink('`Модель: ${model}`')]],
      // Адрес гостиницы лежит в объекте, в промпт идут id и название.
      ['гостиница', ['function pick() { return rows.map((row) => ({ id: row.id, name: row.name, address: row.address })); }', 'const acc = pick();',
        sink('acc.map((a) => `${a.id}:${a.name}`).join(\', \')')]],
      // Параметры запроса, и с обобщённым типом, — не текст результата.
      ['параметры SQL', ["const rows = await pool.query<Row>('SELECT note FROM leads WHERE phone = $1', [lead.phone]);", sink('JSON.stringify(rows)')]],
      // Ключ литерала типа — не переменная.
      ['литерал типа', ["const r = await pool.query<{ id: number; tourist_phone: string }>('SELECT id FROM t');", sink('JSON.stringify(r)')]],
      // Тип массива `Row[]` — не элемент: тип не становится переменной с родом.
      ['тип массива', ['const tel: Row[] = [lead.phone];', 'void tel;', "const r = await pool.query<Row>('SELECT title FROM tours');", sink('JSON.stringify(r)')]],
      ['длина', ['const n = phones.length;', sink('`Лидов: ${n}`')]],
    ];
    for (const [label, lines] of cases) expect(found(ask(...lines)), label).toEqual([]);
  });
});

describe('D1 — восьмое ревью PR #3104: объект в аргументе и функция по ссылке', () => {
  const found = (src: string) => scanSource('r.ts', src).map((x) => [x.kind, x.context, x.expr]);
  const ask = (...lines: string[]) => ["import { callAIFast } from '@/lib/ai/providers';", ...lines].join('\n');
  const sink = (expr: string) => `await callAIFast([{ role: 'user', content: ${expr} }]);`;

  it('находка 1: литерал объекта в аргументе функции файла — род у поля параметра', () => {
    // Дословно сценарий ревьюера.
    expect(found(ask('function ask(o: { body: string }) {', "  return callAIFast([{ role: 'user', content: o.body }]);", '}',
      'export const run = (lead: Lead) => ask({ body: lead.phone });'))).toEqual([['contact', 'content', 'o.body']]);
    // Деструктурированный параметр и объект, собранный в переменную до вызова.
    expect(found(ask('function ask({ body }: { body: string }) {', "  return callAIFast([{ role: 'user', content: body }]);", '}',
      'ask({ body: lead.phone });'))).toEqual([['contact', 'content', 'body']]);
    expect(found(ask('function ask(o: { body: string }) {', "  return callAIFast([{ role: 'user', content: o.body }]);", '}',
      'const opts = { body: lead.phone };', 'ask(opts);'))).toEqual([['contact', 'content', 'o.body']]);
    expect(found(ask('function ask({ body }: { body: string }) {', "  return callAIFast([{ role: 'user', content: body }]);", '}',
      'const opts = { body: lead.phone };', 'ask(opts);'))).toEqual([['contact', 'content', 'body']]);
  });

  it('находка 2: функция файла по ссылке (`leads.map(line)`) и метод через объект', () => {
    // Дословно сценарий ревьюера: шаблон внутри функции, отданной по ссылке.
    expect(found(ask('function line(l: Lead) { return `Тел: ${l.phone}`; }', "const text = leads.map(line).join('\\n');", sink('text'))))
      .toEqual([['contact', 'выражение', 'l.phone']]);
    // Строка без шаблона — род результата функции; элемент массива — её параметр.
    expect(found(ask("function line(l: Lead) { return 'Тел: ' + l.phone; }", "const text = leads.map(line).join('\\n');", sink('text'))))
      .toEqual([['contact', 'content', 'text']]);
    expect(found(ask('function line(x: Item) { return `Тел: ${x.note}`; }', 'const items = [{ note: lead.phone }];', "const text = items.map(line).join('\\n');", sink('text'))))
      .toEqual([['contact', 'выражение', 'x.note']]);
    // Метод файла через чужой объект: и его возврат, и его параметр.
    expect(found(ask('class S { describe(l: Lead) { return `Тел: ${l.phone}`; } }', 'const svc = new S();', sink('svc.describe(lead)'))))
      .toEqual([['contact', 'выражение', 'l.phone']]);
    expect(found(ask('class S { describe(v: string) { return `Тел: ${v}`; } }', 'const svc = new S();', sink('svc.describe(lead.phone)'))))
      .toEqual([['contact', 'выражение', 'v']]);
  });

  it('род полей: деструктуризация, push объекта и for…of, массив литералов, псевдоним объекта', () => {
    const cases: Array<[string, string[], string]> = [
      ['деструктуризация', ['const o = { body: lead.phone };', 'const { body } = o;', sink('body')], 'body'],
      ['push и for…of', ['const list: Item[] = [];', 'list.push({ note: lead.phone });', 'for (const it of list) {', '  ' + sink('it.note'), '}'], 'it.note'],
      ['массив литералов', ['const list = [{ note: lead.phone }];', sink("list.map((x) => x.note).join(' ')")], 'x.note'],
      ['псевдоним объекта', ['const o = { body: lead.phone };', 'const p = o;', sink('p.body')], 'p.body'],
    ];
    for (const [label, lines, expr] of cases) expect(found(ask(...lines)), label).toEqual([['contact', 'content', expr]]);
  });

  it('узость: соседнее поле не несёт рода; одноимённый метод чужого объекта со строкой не в модель', () => {
    expect(found(ask('function ask(o: { body: string; tel: string }) {', "  return callAIFast([{ role: 'user', content: o.body }]);", '}',
      "ask({ body: 'Сводка', tel: lead.phone });"))).toEqual([]);
    expect(found(ask("const o = { body: 'Сводка', tel: lead.phone };", 'const { body } = o;', sink('body')))).toEqual([]);
    expect(found(ask('function ask({ body }: { body: string; tel: string }) {', "  return callAIFast([{ role: 'user', content: body }]);", '}',
      "ask({ body: 'Сводка', tel: lead.phone });"))).toEqual([]);
    expect(found(ask('function send(text: string) { return callAIFast(text); }', 'await bot.api.send(chatId, `Тел: ${lead.phone}`);',
      "await send('Сводка без контактов');"))).toEqual([]);
  });
});

describe('D1 — девятое ревью PR #3104: однобуквенный владелец имени и тип в одну строку', () => {
  const found = (src: string) => scanSource('r.ts', src).map((x) => [x.kind, x.context, x.expr]);
  const ask = (...lines: string[]) => ["import { callAIFast } from '@/lib/ai/providers';", ...lines].join('\n');
  const sink = (expr: string) => `return callAIFast([{ role: 'user', content: ${expr} }]);`;

  it('находка: имя из выборки под нейтральным именем — имя, пока не доказано обратное', () => {
    // Дословно сценарий ревьюера.
    expect(found(ask('export async function digest(rows: { name: string }[]) {', "  const who = rows.map((l) => l.name).join(', ');",
      '  const prompt = `Клиенты: ${who}`;', "  return callAIFast([{ role: 'user', content: prompt }]);", '}')))
      .toEqual([['name', 'prompt', 'who']]);
    // Параметр с типом без слова человека и параметр без типа.
    expect(found(ask('function f(b: { name: string; phone: string }) {', '  const who = b.name;', '  ' + sink('`Кто: ${who}`'), '}')))
      .toEqual([['name', 'content', 'who']]);
    expect(found(ask('function f(l) {', '  const who = l.name;', '  ' + sink('`Кто: ${who}`'), '}')))
      .toEqual([['name', 'content', 'who']]);
    // Слово человека в получателе сильнее слова не-человека.
    expect(found(ask("const who = leadFiles.map((l) => l.name).join(', ');", sink('`Кто: ${who}`'))))
      .toEqual([['name', 'content', 'who']]);
  });

  it('узость: владелец, доказуемо связанный с не-человеком — модели, файл, инструмент', () => {
    const cases: Array<[string, string[]]> = [
      // Так записан список моделей Gemini в providers.ts: группа в начале цепочки, filter перед map.
      ['цепочка от группы', ['const ids = (data.models ?? [])', "  .filter((m) => Array.isArray(m.methods))", "  .map((m) => m.name.replace(/^models\\//, ''));",
        'const model = ids[0];', sink('`Модель: ${model}`')]],
      ['for…of', ['const names: string[] = [];', 'for (const m of models) names.push(m.name);', sink("names.join(', ')")]],
      ['тип параметра', ['function f(b: Blob) {', '  const who = b.name;', '  ' + sink('`Файл: ${who}`'), '}']],
      ['инструмент', ["const toolNames = tools.map((u) => u.name).join(', ');", sink('`Инструменты: ${toolNames}`')]],
    ];
    for (const [label, lines] of cases) expect(found(ask(...lines)), label).toEqual([]);
  });

  it('находка: тело функции в одной строке с заголовком — тип параметра не съедает объявление', () => {
    const one = '`Кто: ${who}`';
    expect(found(ask(`function f(lead: Lead) { const who = lead.phone; ${sink(one)} }`))).toEqual([['contact', 'content', 'who']]);
    expect(found(ask(`function f(b: { name: string; phone: string }) { const who = b.name; ${sink(one)} }`))).toEqual([['name', 'content', 'who']]);
    // Тип в фигурных скобках у самой переменной — по-прежнему тип.
    expect(found(ask('const who: { tel: string } = { tel: lead.phone };', sink('`Тел: ${who.tel}`')))).toEqual([['contact', 'content', 'who.tel']]);
  });
});

describe('D1 — десятое ревью PR #3104: не-человека называет главное слово имени, а не подстрока', () => {
  const found = (src: string) => scanSource('r.ts', src).map((x) => [x.kind, x.context, x.expr]);
  const ask = (...lines: string[]) => ["import { callAIFast } from '@/lib/ai/providers';", ...lines].join('\n');
  const sink = (expr: string) => `return callAIFast([{ role: 'user', content: ${expr} }]);`;

  it('находка: `file` внутри `profiles`, слово в колбэке filter, `toolkit`, `modelUrls`, поле объектного типа', () => {
    // Дословно сценарий ревьюера.
    expect(found(ask('export async function digest(profiles: { name: string }[]) {', "  const who = profiles.map((l) => l.name).join(', ');",
      '  const prompt = `Клиенты: ${who}`;', "  return callAIFast([{ role: 'user', content: prompt }]);", '}')))
      .toEqual([['name', 'prompt', 'who']]);
    expect(found(ask('const who = list', '  .filter((p) => p.avatarFile)', '  .map((l) => l.name)', "  .join(', ');", sink('`Кто: ${who}`'))))
      .toEqual([['name', 'content', 'who']]);
    for (const coll of ['toolkit', 'modelUrls', 'profileFilesOwners']) {
      expect(found(ask(`const who = ${coll}.map((m) => m.name).join(', ');`, sink('`Кто: ${who}`'))), coll).toEqual([['name', 'content', 'who']]);
    }
    expect(found(ask('function f(b: { name: string; file: string }) {', '  const who = b.name;', '  ' + sink('`Кто: ${who}`'), '}')))
      .toEqual([['name', 'content', 'who']]);
    expect(found(ask('const names: string[] = [];', 'for (const m of profiles) names.push(m.name);', "await callAIFast(names.join(', '));")))
      .toEqual([['name', 'callAIFast', 'names']]);
  });

  it('узость: главное слово модели, файла, инструмента — в имени, в типе и его обобщении, в группе for…of', () => {
    const cases: Array<[string, string[]]> = [
      ['geminiModels', ["const who = geminiModels.map((m) => m.name).join(', ');", sink('`Модели: ${who}`')]],
      ['XMLFile', ['function f(b: XMLFile) {', '  const who = b.name;', '  ' + sink('`Файл: ${who}`'), '}']],
      ['тип-обобщение', ['function f(b: Readonly<GeminiModel>) {', '  const who = b.name;', '  ' + sink('`Модель: ${who}`'), '}']],
      ['for…of по группе', ['const names: string[] = [];', 'for (const m of (data.models ?? [])) names.push(m.name);', "await callAIFast(names.join(', '));"]],
    ];
    for (const [label, lines] of cases) expect(found(ask(...lines)), label).toEqual([]);
  });
});

describe('D1 — одиннадцатое ревью PR #3104: что чистит redactPII и строка из базы целиком', () => {
  const found = (src: string) => scanSource('r.ts', src).map((x) => [x.kind, x.context, x.expr]);
  const ask = (...lines: string[]) => ["import { callAIFast } from '@/lib/ai/providers';", "import { redactPII } from '@/lib/security/pii-redact';", ...lines].join('\n');
  const sink = (expr: string) => `await callAIFast([{ role: 'user', content: ${expr} }]);`;

  it('находка 1: адрес, дата рождения и ник сквозь redactPII — он чистит только телефон и почту', () => {
    // Дословно сценарий ревьюера.
    expect(found(ask('const prompt = `Гость: ${redactPII(order.address)}, д.р. ${redactPII(order.birth_date)}, tg: ${redactPII(order.telegram_username)}`;',
      "await callAIFast([{ role: 'user', content: prompt }]);"))).toEqual([
      ['contact', 'prompt', 'redactPII(order.address)'],
      ['contact', 'prompt', 'redactPII(order.birth_date)'],
      ['contact', 'prompt', 'redactPII(order.telegram_username)'],
    ]);
    // Значение стока, переменная с именем идентификатора, род через переменную.
    expect(found(ask(sink('redactPII(order.passport)')))).toEqual([['contact', 'content', 'order.passport']]);
    expect(found(ask('const address = await loadAddress();', sink('redactPII(address)')))).toEqual([['contact', 'content', 'address']]);
    expect(found(ask('const address = await loadAddress();', sink('`Куда: ${redactPII(address)}`')))).toEqual([['contact', 'content', 'redactPII(address)']]);
    expect(found(ask('const where = order.address;', sink('`Куда: ${redactPII(where)}`')))).toEqual([['contact', 'content', 'redactPII(where)']]);
    // Телефон и почта сквозь redactPII — по-прежнему чисты.
    expect(found(ask(sink('`Тел: ${redactPII(order.phone)}, почта: ${redactPII(order.email)}`')))).toEqual([]);
  });

  it('чистка — только redactPII: своя функция `redact` ничего не гасит', () => {
    expect(found(ask('function redact(x: string) { return x; }', sink('`Тел: ${redact(order.phone)}`')))).toEqual([['contact', 'content', 'redact(order.phone)']]);
  });

  it('слова ПД разделены без потерь: чистимые и нет — ровно CONTACT_WORD', () => {
    const words = (s: string) => new Set(s.split('|'));
    expect(new Set([...words(REDACTABLE_WORD), ...words(IDENT_WORD)])).toEqual(words(CONTACT_WORD));
    expect([...words(REDACTABLE_WORD)].filter((w) => words(IDENT_WORD).has(w))).toEqual([]);
  });

  it('находка 2: строка из базы целиком — род по колонкам запроса', () => {
    // Дословно сценарий ревьюера.
    expect(found(ask('const { rows } = await pool.query(',
      "  'SELECT tourist_name, tourist_phone, special_requests FROM operator_bookings WHERE operator_tour_id = $1', [tourId]);",
      'const prompt = `Брони тура: ${JSON.stringify(rows)}`;', "await callAIFast([{ role: 'user', content: prompt }]);")))
      .toEqual([['contact', 'prompt', 'JSON.stringify(rows)']]);
    // `SELECT *` — все роды; результат в переменной — и он, и его rows; первая строка — тоже строка.
    expect(found(ask("const res = await pool.query('SELECT * FROM operator_bookings WHERE id = $1', [id]);", sink('JSON.stringify(res.rows)'))).map((f) => f[0]))
      .toEqual(['contact', 'name']);
    expect(found(ask("const { rows } = await db.query<Row>('SELECT name FROM leads');", 'const first = rows[0];', sink('JSON.stringify(first)'))))
      .toEqual([['name', 'content', 'first']]);
  });

  it('узость: колонки без ПД, чтение поля строки, имя места, подсчёт', () => {
    expect(found(ask("const { rows } = await pool.query('SELECT title, base_price FROM operator_tours');", sink('JSON.stringify(rows)')))).toEqual([]);
    expect(found(ask("const { rows } = await pool.query('SELECT title, tourist_phone FROM operator_bookings');",
      "const t = rows.map((r) => r.title).join(', ');", sink('`Туры: ${t}`')))).toEqual([]);
    expect(sqlRowKinds("'SELECT p.name, p.slug FROM places p'")).toEqual([]);
    expect(sqlRowKinds("'SELECT COUNT(*) AS n FROM leads'")).toEqual([]);
    expect(sqlRowKinds("`SELECT r.comment, u.name AS user_name, t.title AS tour_name FROM reviews r JOIN users u ON u.id = r.user_id`")).toEqual(['name']);
    expect(sqlRowKinds("'SELECT name FROM leads'")).toEqual(['name']);
    expect(sqlRowKinds("'SELECT id, passport_number FROM guests'")).toEqual(['ident']);
  });
});

describe('D1 — двенадцатое ревью PR #3104: род колонки по выражению, формы результата, поля строки', () => {
  const found = (src: string) => scanSource('r.ts', src).map((x) => [x.kind, x.context, x.expr]);
  const ask = (...lines: string[]) => ["import { callAIFast } from '@/lib/ai/providers';", ...lines].join('\n');
  const sink = (expr: string) => `await callAIFast([{ role: 'user', content: ${expr} }]);`;

  it('находка 1: приведение и нейтральный псевдоним не прячут колонку', () => {
    // Дословно сценарий ревьюера.
    expect(found(ask('const { rows } = await pool.query(',
      '  "SELECT tourist_phone::text, tourist_name::text AS title, passport_number::text AS doc FROM operator_bookings WHERE operator_tour_id = $1", [tourId]);',
      'const prompt = `Брони тура: ${JSON.stringify(rows)}`;', "await callAIFast([{ role: 'user', content: prompt }]);")))
      .toEqual([['contact', 'prompt', 'JSON.stringify(rows)']]);
    expect(sqlRowKinds("'SELECT tourist_phone::text FROM operator_bookings'")).toEqual(['contact']);
    expect(sqlRowKinds("'SELECT tourist_name::text AS title FROM operator_bookings'")).toEqual(['name']);
    expect(sqlRowKinds("'SELECT passport_number::text AS doc FROM guests'")).toEqual(['ident']);
    expect(sqlRowKinds("'SELECT COALESCE(telegram_chat_id::text, telegram_id::text) AS tg FROM users'")).toEqual(['ident']);
    expect(sqlRowKinds("`SELECT tourist_name || ' ' || tourist_surname AS title FROM operator_bookings`")).toEqual(['name']);
    expect(sqlRowKinds("'SELECT DISTINCT l.name FROM leads l'")).toEqual(['name']);
    expect(sqlRowKinds("'SELECT DISTINCT name FROM leads'")).toEqual(['name']);
    // Псевдоним называет контакт там, где выражение его не называет: поле JSON по ключу-строке.
    expect(sqlRowKinds("`SELECT source_data->>'phone' AS phone FROM leads`")).toEqual(['contact']);
    // Поле строки — по выходному имени, род — по выражению.
    expect(sqlRow("'SELECT tourist_name::text AS title, passport_number::text AS doc, tourist_phone::text FROM operator_bookings'").fields)
      .toEqual(new Map([['title', ['name']], ['doc', ['ident']], ['tourist_phone', ['contact']]]));
  });

  it('узость находки 1: подсчёт, признак, название тура рядом с лидами, служебный телефон МЧС', () => {
    expect(sqlRowKinds("'SELECT COUNT(*) AS n FROM leads'")).toEqual([]);
    expect(sqlRowKinds("'SELECT COUNT(tourist_phone) AS n, tourist_phone IS NOT NULL AS has_phone FROM operator_bookings'")).toEqual([]);
    expect(sqlRowKinds("'SELECT t.name, t.title, l.status FROM operator_tours t JOIN leads l ON l.tour_id = t.id'")).toEqual([]);
    expect(sqlRowKinds("'SELECT name AS label, note FROM operator_tours'")).toEqual([]);
    expect(sqlRowKinds("'SELECT title, mchs_phone FROM kamchatka_routes'")).toEqual([]);
    expect(sqlRowKinds("`SELECT CASE WHEN x THEN 'a' ELSE 'b' END, title FROM operator_tours`")).toEqual([]);
    expect(sqlRowKinds("`SELECT title, 'phone' AS channel FROM operator_tours`")).toEqual([]);
  });

  it('находка 2: результат в скобках `.rows`, элемент `.rows[0]` и `const [row]`', () => {
    // Дословно сценарий ревьюера.
    expect(found(ask("const rows = (await pool.query('SELECT tourist_name, tourist_phone FROM operator_bookings')).rows;",
      'const prompt = `Брони: ${JSON.stringify(rows)}`;', "await callAIFast([{ role: 'user', content: prompt }]);")))
      .toEqual([['contact', 'prompt', 'JSON.stringify(rows)']]);
    expect(found(ask("const [row] = await query('SELECT name FROM leads WHERE id = $1', [id]);", sink('JSON.stringify(row)'))))
      .toEqual([['name', 'content', 'row']]);
    // Владелец поля — нейтральное имя: `lead.name` судится как имя и без строки запроса.
    expect(found(ask("const who = (await pool.query('SELECT name FROM leads WHERE id = $1', [id])).rows[0];", sink('`Клиент: ${who.name}`'))))
      .toEqual([['name', 'content', 'who.name']]);
    expect(found(ask("const { rows: [who] } = await pool.query('SELECT name FROM leads WHERE id = $1', [id]);", sink('`Клиент: ${who.name}`'))))
      .toEqual([['name', 'content', 'who.name']]);
    // Число строк — не строка.
    expect(found(ask("const n = (await pool.query('SELECT tourist_phone FROM operator_bookings')).rowCount;", sink('`Броней: ${n}`')))).toEqual([]);
    expect(found(ask("const n = (await pool.query('SELECT tourist_phone FROM operator_bookings')).rows.length;", sink('`Броней: ${n}`')))).toEqual([]);
  });

  it('находка 3: поле строки несёт род своей колонки', () => {
    // Дословно сценарий ревьюера.
    expect(found(ask("const { rows } = await pool.query('SELECT name FROM leads');",
      'const prompt = `Клиент: ${rows[0].name}`;', "await callAIFast([{ role: 'user', content: prompt }]);")))
      .toEqual([['name', 'prompt', 'rows[0].name']]);
    expect(found(ask("const { rows } = await pool.query('SELECT name FROM leads');", 'const first = rows[0];', sink('`Клиент: ${first.name}`'))))
      .toEqual([['name', 'content', 'first.name']]);
    expect(found(ask("const { rows } = await pool.query('SELECT name FROM leads');", 'const [first] = rows;', sink('`Клиент: ${first.name}`'))))
      .toEqual([['name', 'content', 'first.name']]);
    expect(found(ask("const { rows } = await pool.query('SELECT id, name FROM leads');", 'const match = rows.find((r) => r.id === id);', sink('`Клиент: ${match.name}`'))))
      .toEqual([['name', 'content', 'match.name']]);
    expect(found(ask("const res = await pool.query('SELECT name FROM users WHERE id = $1', [id]);", sink('`Кому: ${res.rows[0].name}`'))))
      .toEqual([['name', 'content', 'res.rows[0].name']]);
    expect(found(ask("const res = await pool.query('SELECT name FROM users');", 'const lines: string[] = [];',
      'for (const row of res.rows) lines.push(row.name);', sink("lines.join(', ')"))).map((f) => f[0])).toEqual(['name']);
    // Род строки на поле с ПД, а не на всё прочее: `title` рядом с телефоном и `name` тура — чисты.
    expect(found(ask("const { rows } = await pool.query('SELECT title, tourist_phone FROM operator_bookings');",
      'const first = rows[0];', sink('`Тур: ${rows[0].title}, ${first.title}`')))).toEqual([]);
    expect(found(ask("const { rows: [tourist] } = await pool.query('SELECT title, tourist_phone FROM operator_bookings');", sink('`Тур: ${tourist.title}`'))))
      .toEqual([]);
    expect(found(ask("const { rows } = await pool.query('SELECT t.name, t.title FROM operator_tours t');", sink('`Тур: ${rows[0].name}`')))).toEqual([]);
  });
});

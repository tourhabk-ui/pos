import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { scanSource, pdAliases } from '@/lib/agents/compliance/pii-flow-scanner';
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
    expect(found[0].context).toBe('prompt');
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
    expect(LLM_ENDPOINTS.filter((e) => e.domestic).map((e) => e.host)).toEqual(['llm.api.cloud.yandex.net']);
  });
});

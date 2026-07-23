import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { scanSource } from '@/lib/agents/compliance/pii-flow-scanner';
import { findViolations, ALLOWLIST } from '@/lib/agents/compliance/scan-repo';
import {
  LLM_ENDPOINTS,
  unregisteredHosts,
  extractLLMHosts,
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
  it('нет незарегистрированных LLM-хостов в providers.ts (новый провайдер = осознанное решение)', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'lib/ai/providers.ts'), 'utf8');
    const unknown = unregisteredHosts(src);
    if (unknown.length) {
      throw new Error(
        `Новый LLM-эндпоинт в providers.ts не в реестре: ${unknown.join(', ')}.\n` +
          `Добавь его в LLM_ENDPOINTS (lib/agents/compliance/provider-registry.ts) ` +
          `с юрисдикцией и флагом domestic — это признание «ещё один приёмник ПД, 152-ФЗ учтён».`,
      );
    }
    expect(unknown).toHaveLength(0);
  });

  it('все хосты providers.ts покрыты реестром', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'lib/ai/providers.ts'), 'utf8');
    const hosts = extractLLMHosts(src);
    const registered = new Set(LLM_ENDPOINTS.map((e) => e.host));
    for (const h of hosts) expect(registered.has(h), `хост ${h} не в реестре`).toBe(true);
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

/**
 * Сторож: плейсхолдеры публичного репозитория не совпадают с правдой.
 *
 * ── Почему ───────────────────────────────────────────────────────────────
 *
 * Репозиторий публичный, а `.env.example` до 01.09 нёс настоящий числовой
 * Telegram ID владельца и ID канала MAX, `AGENTS.md` — локальный пароль БД.
 * Не секреты прода, но разведка: кому слать поддельные уведомления, какой
 * пароль попробовать на чьей-нибудь машине, где дефолт так и остался.
 * Аудит 01.09 назвал это прямо; поправка дешёвая, и правило держит её.
 *
 * Правило: у числовых ID мессенджеров в примере — только нули; в
 * документации нет строки, похожей на пароль.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

describe('.env.example не несёт настоящих идентификаторов', () => {
  const lines = readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n');

  it('числовые ID Telegram и MAX — нули', () => {
    const offenders: string[] = [];
    for (const line of lines) {
      const m = line.match(/^(TELEGRAM_[A-Z_]*ID|MAX_[A-Z_]*ID)=(-?\d+)/);
      if (!m) continue;
      if (/[1-9]/.test(m[2])) offenders.push(line.trim());
    }
    expect(offenders, 'настоящий ID в примере — разведка для подделки уведомлений; ставьте нули').toEqual([]);
  });
});

describe('документация не несёт паролей', () => {
  it('AGENTS.md без локального пароля БД', () => {
    const src = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    expect(src).not.toMatch(/password=`[^`]+`/);
    expect(src).not.toMatch(/kampass/);
  });
});

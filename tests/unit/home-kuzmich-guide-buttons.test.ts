import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const HOME = read('app/_home/_HomeV8Client.tsx');
const ICONS = read('components/shared/MessengerIcons.tsx');

describe('блок «Проводник Кузьмич» на главной', () => {
  it('главная кнопка — «Спросить на сайте» и ведёт туда же, куда вёл «Спросить»', () => {
    expect(HOME).toContain('>Спросить на сайте</Link>');
    expect(HOME).toContain('<Link className="ask-site" href="/kuzmich">');
    expect(HOME).not.toContain('>Спросить</Link>');
  });

  it('мессенджеры — официальные знаки и прежние адреса без изменений', () => {
    expect(HOME).toContain('<TelegramIcon');
    expect(HOME).toContain('<MaxIcon');
    expect(HOME).toContain('href={KUZMICH_TELEGRAM_URL}');
    expect(HOME).toContain('href={KUZMICH_MAX_URL}');
    expect(HOME).toContain('aria-label="Кузьмич в Telegram"');
    expect(HOME).toContain('aria-label="Кузьмич в MAX"');
    expect(HOME).not.toContain('className="golead"');
    expect(ICONS).toContain('#2AABEE');
    expect(ICONS).toContain('#471AFF');
    expect(ICONS).toContain('#9500FF');
    expect(ICONS).not.toMatch(/https?:\/\//);
  });

  it('цели: сайт не ниже 52px, мессенджеры не ниже 48px в одном ряду', () => {
    expect(HOME).toMatch(/a\.ask-site\{min-height:52px/);
    expect(HOME).toMatch(/a\.msg\{min-height:48px/);
    expect(HOME).toMatch(/\.messengers\{display:grid;grid-template-columns:1fr 1fr/);
  });
});

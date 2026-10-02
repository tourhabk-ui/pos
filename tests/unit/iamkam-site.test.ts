/**
 * Сторож воркфлоу сайта партнёра iamkam.ru (iamkam-site.yml, 02.10).
 *
 * Чужой сайт правится с раннера по реквизитам из секретов, и у этого три
 * правила, которые держатся здесь, а не абзацем:
 *  - маркер в репозитории лежит в dry;
 *  - пароль не попадает ни в аргументы команд, ни в адрес: lftp берёт его из
 *    переменной LFTP_PASSWORD (--env-password), set -x не включается;
 *  - реквизиты только из секретов, ни одного значения в коде; TLS не отключается.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const WF = read('.github/workflows/iamkam-site.yml');
const CODE = WF.replace(/^[ \t]*#.*$/gm, '');
const MARKER = JSON.parse(read('.github/triggers/iamkam-site.json')) as { mode?: string; tasks?: string[] };

describe('iamkam-site: маркер', () => {
  it('в репозитории лежит в dry и называет задачи', () => {
    expect(MARKER.mode ?? 'dry').toBe('dry');
    expect(Array.isArray(MARKER.tasks)).toBe(true);
  });
  it('запускается правкой маркера в main', () => {
    expect(CODE).toMatch(/paths:\s*\n\s*- '\.github\/triggers\/iamkam-site\.json'/);
  });
});

describe('iamkam-site: воркфлоу', () => {
  it('реквизиты только из секретов, токенов GitHub не просит', () => {
    for (const name of ['IAMKAM_HOST', 'IAMKAM_USER', 'IAMKAM_PASS', 'IAMKAM_ROOT']) {
      expect(CODE).toContain(`${name}: \${{ secrets.${name} }}`);
    }
    expect(CODE).toMatch(/^permissions: \{\}$/m);
  });
  it('пароль уходит в lftp переменной, не аргументом и не адресом', () => {
    expect(CODE).toMatch(/export LFTP_PASSWORD="\$IAMKAM_PASS"/);
    expect(CODE).toMatch(/--env-password/);
    expect(CODE).not.toMatch(/-u "\$IAMKAM_USER","?\$IAMKAM_PASS/);
    expect(CODE).not.toMatch(/\$IAMKAM_USER:\$IAMKAM_PASS@/);
    expect(CODE).not.toMatch(/set -x/);
    expect(CODE).not.toMatch(/echo[^\n]*\$IAMKAM_PASS/);
  });
  it('TLS не отключается', () => {
    expect(CODE).toMatch(/ssl:verify-certificate yes/);
    expect(CODE).not.toMatch(/verify-certificate (no|false)/);
  });
  it('умолчание режима — dry, без секретов прогон краснеет словами', () => {
    expect(CODE).toMatch(/get\("mode","dry"\)/);
    expect(CODE).toMatch(/Не заданы секреты/);
  });
});

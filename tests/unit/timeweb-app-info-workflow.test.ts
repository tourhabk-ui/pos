/**
 * Разбор привязки приложения не выкладывает секреты прода в лог.
 *
 * 16.08 прод встал: Timeweb собирает успешно, но берёт revision
 * восемнадцатичасовой давности. Со стороны GitHub проверено всё — приложение
 * установлено, доступ есть, права на хуки есть. Неизвестным осталось одно: к
 * какой ВЕТКЕ привязано приложение и включён ли автодеплой. В `deploy.yml`
 * записано «is_auto_deploy: true», но это комментарий, а не факт.
 *
 * Спросить надо у API, и токен для этого уже лежит в секретах Actions —
 * выносить его на чью-то машину незачем.
 *
 * Главное свойство этого инструмента — НЕ печатать ответ целиком. В настройках
 * приложения живут переменные окружения: пароль базы, JWT-секрет, ключи
 * провайдеров. Лог прогона видят все, у кого есть доступ к репозиторию.
 * Вывести всё «на всякий случай» значило бы разложить секреты прода в
 * общедоступный лог ради одного поля про ветку.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WF = readFileSync(
  join(process.cwd(), '.github/workflows/timeweb-app-info.yml'),
  'utf-8',
);

describe('спрашивается по руке или по маркеру, без расписания', () => {
  it('триггеры — workflow_dispatch и маркер; расписания нет', () => {
    // Маркер (10.09, #1762): из песочницы workflow_dispatch не дёрнуть, а
    // ответ «есть ли у сборки переменная с SHA» нужен из API, не из памяти.
    expect(WF).toMatch(/workflow_dispatch:/);
    expect(WF).not.toMatch(/^\s*schedule:/m);
    expect(WF).toMatch(/push:\n\s+branches: \[main\]\n\s+paths:\n\s+- '\.github\/triggers\/timeweb-app-info\.json'/);
  });

  it('только чтение: один GET, ничего не запускается', () => {
    expect(WF).not.toMatch(/-X (POST|PUT|PATCH|DELETE)/);
    expect(WF).not.toMatch(/\/deploy/);
  });
});

describe('в лог уходит белый список полей, а не весь ответ', () => {
  it('поля перечислены явно', () => {
    expect(WF).toMatch(/FIELDS = \[/);
    expect(WF).toMatch(/'branch_name'/);
    expect(WF).toMatch(/'is_auto_deploy'/);
    expect(WF).toMatch(/'commit_sha'/);
  });

  it('ответ целиком не печатается', () => {
    // Ни `cat` файла, ни json.tool, ни print(app) — любой из них вывалил бы
    // переменные окружения прода.
    expect(WF).not.toMatch(/cat \/tmp\/app\.json/);
    expect(WF).not.toMatch(/json\.tool/);
    expect(WF).not.toMatch(/print\(app\)/);
    expect(WF).not.toMatch(/json\.dumps\(app/);
  });

  it('прочие поля показываются только именами', () => {
    // Имена подскажут, где искать привязку, если API называет её иначе,
    // и при этом ничего не раскроют.
    expect(WF).toMatch(/только имена, значения не выводятся/);
    expect(WF).toMatch(/', '\.join\(rest\)/);
  });

  it('переменные окружения — только имена, только похожие на коммит/сборку (#1762)', () => {
    expect(WF).toMatch(/envs = app\.get\('envs'\)/);
    expect(WF).toMatch(/re\.search\(r'commit\|sha\|git\|rev\|build\|version', n, re\.I\)/);
    // Значения не печатаются ни в какой форме.
    expect(WF).not.toMatch(/envs\[/);
    expect(WF).not.toMatch(/\.get\('value'\)/);
    expect(WF).not.toMatch(/print\(envs\)/);
    expect(WF).not.toMatch(/print\(names\)/);
    // Неизвестная форма поля называется вслух, а не молчит (§4.0).
    expect(WF).toMatch(/неожиданную форму/);
  });
});

describe('секрет остаётся в секретах', () => {
  it('берётся из secrets и уходит только заголовком', () => {
    expect(WF).toMatch(/TIMEWEB_TOKEN: \$\{\{ secrets\.TIMEWEB_TOKEN \}\}/);
    expect(WF).toMatch(/Authorization: Bearer \$TIMEWEB_TOKEN/);
    expect(WF).not.toMatch(/echo .*\$TIMEWEB_TOKEN/);
  });

  it('без секрета прогон краснеет, а не выходит с нулём', () => {
    const guard = WF.slice(WF.indexOf('if [ -z "$TIMEWEB_TOKEN" ]'));
    expect(guard.slice(0, 300)).toMatch(/exit 1/);
    expect(guard.slice(0, 300)).not.toMatch(/exit 0/);
  });

  it('не-200 от API тоже провал', () => {
    expect(WF).toMatch(/API Timeweb ответил \$HTTP/);
  });
});

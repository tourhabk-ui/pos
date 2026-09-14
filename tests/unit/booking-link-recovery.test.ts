/**
 * tests/unit/booking-link-recovery.test.ts
 *
 * #1889: два клиента `POST /api/hub/bookings/create` не давали туристу НИ
 * ОДНОГО способа вернуться к своей брони, кроме текущей вкладки.
 *
 *  - `app/p/[code]/_SelectionClient.tsx` — форма вообще не спрашивает email
 *    и до этой правки не читала `access_token` из ответа вовсе: сообщение
 *    об успехе не несло ссылки, только «✓».
 *  - `components/kuzmich/KuzmichWidget.tsx` — ссылка была, но без email и
 *    без явного «сохрани сейчас» турист мог закрыть виджет, ни разу её не
 *    заметив как единственный путь назад.
 *
 * Сторож судит устройство (текст компонентов), как соседний
 * booking-access.test.ts — поведение в реальном браузере снаружи фикстур.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const SELECTION = read('app/p/[code]/_SelectionClient.tsx');
const WIDGET     = read('components/kuzmich/KuzmichWidget.tsx');

describe('/p/[code]: ссылка на бронь больше не теряется молча', () => {
  it('access_token и id читаются из ответа create, а не игнорируются', () => {
    const fn = SELECTION.slice(SELECTION.indexOf('const handleBook'));
    const body = fn.slice(0, fn.indexOf('\n  };'));
    expect(body).toMatch(/access_token\?:\s*string/);
    expect(body).toMatch(/data\.id\s*&&\s*data\.access_token/);
    expect(body).toMatch(/booking-success\/\$\{data\.id\}\?t=/);
  });

  it('форма не собирает email — значит письма с ключом не будет никогда', () => {
    // Единственные поля формы — имя, телефон, дата, число участников.
    const formBlock = SELECTION.slice(SELECTION.indexOf('<form onSubmit'), SELECTION.indexOf('</form>'));
    expect(formBlock).not.toMatch(/tourist_email|type="email"/);
  });

  it('экран успеха показывает предупреждение и кнопку копирования, когда ссылка есть', () => {
    const successBlock = SELECTION.slice(SELECTION.indexOf('{sent ? ('), SELECTION.indexOf(') : ('));
    expect(successBlock).toMatch(/bookedLink &&/);
    expect(successBlock).toMatch(/Сохрани эту ссылку сейчас/);
    expect(successBlock).toMatch(/navigator\.clipboard\.writeText\(bookedLink\)/);
  });
});

describe('виджет Кузьмича: ссылка без email явно помечена как единственная', () => {
  it('noOtherChannel считается по пустому email, не по угадыванию', () => {
    const fn = WIDGET.slice(WIDGET.indexOf('if (done && bookingId)'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toMatch(/noOtherChannel\s*=\s*email\.trim\(\)\s*===\s*''/);
  });

  it('предупреждение и копирование показываются только когда канала правда нет', () => {
    const fn = WIDGET.slice(WIDGET.indexOf('if (done && bookingId)'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toMatch(/noOtherChannel\s*&&\s*\(/);
    expect(body).toMatch(/Сохрани её сейчас/);
    expect(body).toMatch(/navigator\.clipboard\.writeText\(link\)/);
  });

  it('ссылка на оплату по-прежнему ведёт на booking-success с ключом', () => {
    const fn = WIDGET.slice(WIDGET.indexOf('if (done && bookingId)'));
    expect(fn.slice(0, 600)).toMatch(/booking-success\/\$\{bookingId\}\?t=\$\{encodeURIComponent\(accessToken\)\}/);
  });
});

/**
 * Партнёра можно завести — и нельзя завести недостижимым.
 *
 * ── Дыра, которую это закрывает ───────────────────────────────────────────
 *
 * До 11.09 партнёра нельзя было создать НИКАК, кроме как его собственной
 * регистрацией на сайте. Админка умела читать, править, проверять и удалять —
 * всё, кроме первого шага. Нашлось прозаично: владелец прислал логотип нового
 * партнёра, и класть его оказалось некуда.
 *
 * Дыра не косметическая: оператор, договорившийся по телефону, не попадал на
 * платформу вообще, а единственная дверь — саморегистрация — сама была сломана
 * полтора месяца (42P08 в INSERT профиля, разбор 24.08). Запасного входа не
 * существовало, поэтому поломку никто и не заметил.
 *
 * ── Почему контакт обязателен ─────────────────────────────────────────────
 *
 * Замер 11.09 (`GET /api/cron/operator-reach`, прогон маркера prod-check 51):
 * у ОБОИХ операторов с живыми турами достижимых каналов ноль, за ними стоят
 * двенадцать туров, и заявка не дойдёт ни по одному. Завести тринадцатого с
 * пустым контактом значило бы повторить ту же ошибку осознанно.
 *
 * Колонка `contact` и так NOT NULL — но пустой `{}` проходит проверку типа и
 * проваливает дело. Это §4.0 наоборот: поле, которое нельзя оставить честно
 * пустым, заполняется пустышкой. Поэтому требуется хотя бы ОДИН непустой
 * канал, и сторож держит именно это.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CreatePartnerSchema } from '@/app/api/admin/content/partners/route';
import { slugify } from '@/lib/text/slugify';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');

const base = {
  name: 'Камчатка Семейный Рафтинг',
  category: 'operator' as const,
};

describe('заведение партнёра: контакт — не формальность', () => {
  it('без единого канала связи партнёр не заводится', () => {
    const r = CreatePartnerSchema.safeParse({ ...base, contact: {} });
    expect(r.success, 'партнёр без контактов прошёл — заявка ему не дойдёт').toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/хотя бы один способ связи/i);
  });

  it('пробелы вместо телефона — это тоже отсутствие канала', () => {
    const r = CreatePartnerSchema.safeParse({ ...base, contact: { phone: '   ' } });
    expect(r.success).toBe(false);
  });

  it('одного канала достаточно — любого из трёх', () => {
    for (const contact of [{ phone: '+7 900 000-00-00' }, { email: 'a@b.ru' }, { website: 'https://b.ru' }]) {
      expect(CreatePartnerSchema.safeParse({ ...base, contact }).success).toBe(true);
    }
  });

  it('адрес каналом не считается: по нему заявку не пришлёшь', () => {
    const r = CreatePartnerSchema.safeParse({ ...base, contact: { address: 'Петропавловск, Ленина 1' } });
    expect(r.success).toBe(false);
  });
});

describe('обязательные поля соответствуют NOT NULL в схеме', () => {
  it('категория обязательна и ограничена списком', () => {
    const contact = { phone: '+7 900 000-00-00' };
    expect(CreatePartnerSchema.safeParse({ name: base.name, contact }).success).toBe(false);
    expect(CreatePartnerSchema.safeParse({ ...base, category: 'вулканолог', contact }).success).toBe(false);
    expect(CreatePartnerSchema.safeParse({ ...base, contact }).success).toBe(true);
  });

  it('название не пустое', () => {
    const contact = { phone: '+7 900 000-00-00' };
    expect(CreatePartnerSchema.safeParse({ ...base, name: ' ', contact }).success).toBe(false);
  });
});

describe('адрес карточки не выдумывается молча', () => {
  it('slug считается тем же slugify, что у маршрутов и мест', () => {
    const route = read('app/api/admin/content/partners/route.ts');
    expect(route).toContain("from '@/lib/text/slugify'");
    expect(route).toMatch(/slugify\(name\)/);
    // Тот самый случай, ради которого дверь и понадобилась.
    expect(slugify('RIVER TOURS KAMCHATKA')).toBe('river-tours-kamchatka');
  });

  it('занятый адрес — 409 с названием, а не тихое приписывание номера', () => {
    const route = read('app/api/admin/content/partners/route.ts');
    expect(route, 'уникальный индекс partners_slug_key есть — ответ обязан его назвать')
      .toMatch(/23505/);
    expect(route).toMatch(/уже занят/);
    expect(route, 'молчаливое «-2» выбрало бы адрес за человека').not.toMatch(/slug\s*\+\s*['"`]-\$\{/);
  });

  it('ставка комиссии здесь не задаётся — её назначает владелец', () => {
    // Разбор денежного пути 11.09: partners.commission_current меняет только
    // человек. Заводящий партнёра не должен вписывать ставку мимоходом.
    const route = read('app/api/admin/content/partners/route.ts');
    const post = route.slice(route.indexOf('export async function POST'));
    expect(post).not.toMatch(/commission_current|commission_rate/);
  });
});

describe('кнопка в админке имеет производителя (правило 10.09)', () => {
  const page = read('app/hub/admin/content/partners/page.tsx');

  it('кнопка «Завести партнёра» есть и зовёт POST', () => {
    expect(page).toMatch(/Завести партнёра/);
    expect(page).toMatch(/creating \? 'POST' : 'PUT'/);
    expect(page).toMatch(/creating \? '\/api\/admin\/content\/partners'/);
  });

  it('загрузка логотипа закрыта, пока строки нет', () => {
    // Адрес загрузки содержит id партнёра; до сохранения его не существует,
    // и открытая кнопка выглядела бы сломанной.
    expect(page).toMatch(/uploadingType !== null \|\| editId === NEW_PARTNER/);
    expect(page).toMatch(/Сначала «Завести»/);
  });

  it('форма одна на оба режима — второй копии не заведено', () => {
    // Две формы одного смысла расходятся: это уже было с карточкой тура.
    expect(page).toMatch(/const NEW_PARTNER = 'new'/);
    expect(page.match(/interface EditFormData/g)?.length ?? 0).toBe(1);
  });
});

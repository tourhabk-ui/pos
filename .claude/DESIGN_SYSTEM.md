# Дизайн-система TourHab / Ведар — справочник для агентов

> Единый источник для AI-агентов (code-change-executor, генератор страниц, любой кодер).
> Цель — НЕ галлюцинировать API компонентов: использовать только то, что реально есть в `app/globals.css`.
> Все значения сверены с `app/globals.css` (не выдуманы). Стек: Next.js 15 + Tailwind + CSS-токены. Без StyleX, без UI-библиотек.

---

## 1. Токены (CSS-переменные) — единственный источник цвета/радиуса/тени

Использовать ТОЛЬКО через `var(--token)`. Хардкод hex запрещён. Значения автоматически меняются для light/dark.

### Цвета
| Токен | Назначение | dark | light |
|-------|-----------|------|-------|
| `--bg-primary` | фон страницы | #0D1117 | #FAFAF9 |
| `--bg-secondary` | фон секций | #161B22 | #EDE9E3 |
| `--bg-card` | карточки | #21262D | #FFFFFF |
| `--bg-hover` | hover | #30363D | #F0ECE7 |
| `--text-primary` | заголовки | #F0F6FC | #1A1714 |
| `--text-secondary` | подписи | #8B949E | #6B6560 |
| `--text-muted` | плейсхолдеры | #484F58 | #9A9590 |
| `--accent` | CTA, лава | #E8734A | #D44A0C |
| `--accent-hover` | hover CTA | #d4623c | #B83E0A |
| `--accent-muted` | фон-акцент | rgba(232,115,74,.1) | rgba(212,74,12,.1) |
| `--ocean` | ссылки, иконки | #00A8CC | #2568B0 |
| `--success` | эко, успех | #3FB950 | #3FB950 |
| `--warning` | предупреждение | #D29922 | #D29922 |
| `--danger` | SOS, опасность | #F85149 | #DC2626 |
| `--border` | границы | rgba(255,255,255,.08) | rgba(0,0,0,.07) |
| `--border-strong` | границы hover | rgba(255,255,255,.16) | rgba(0,0,0,.12) |

### Радиусы и тени
| Токен | Значение |
|-------|----------|
| `--radius-sm` | 8px |
| `--radius-md` | 12px |
| `--radius-lg` | 20px |
| `--radius-xl` | 28px |
| `--shadow-sm` / `--shadow-md` / `--shadow-lg` | мягкие тени (dark/light авто) |

### Шрифты
- Заголовки: `var(--font-playfair)` (Playfair Display, serif) — крупно, `text-4xl`/`text-5xl`
- Текст: `var(--font-outfit)` (Outfit, sans). Никаких импортов Google Fonts в компонентах.

---

## 2. Готовые DS-утилиты (классы из globals.css) — использовать вместо самопальной вёрстки

| Класс | Что делает | Где применять |
|-------|-----------|---------------|
| `ds-page` | фон страницы + отступ под фикс-хедер (64px + safe-area) | корневой контейнер страницы |
| `ds-card` | bg-card + border + radius-lg + shadow-sm, hover-эффект | карточки |
| `ds-section` | bg-card + border + radius-lg + padding 1.5rem | блок-секция |
| `ds-input` | поле ввода: min-height 44px, focus = accent-рамка | все input/textarea |
| `ds-btn` | база кнопки: flex, min-height 44px, radius-md, scale на :active | все кнопки (+ модификатор) |
| `ds-btn-primary` | accent-фон, тёмный текст | главный CTA |
| `ds-btn-secondary` | прозрачная, border-strong | вторичное действие |
| `ds-btn-danger` | danger-фон, белый текст | SOS, удаление |
| `ds-badge` | пилюля-статус (radius 9999px, 0.75rem) | бейджи статусов |
| `ds-h1` | Playfair 2.25rem/700, balance | главный заголовок |
| `ds-h2` | Playfair 1.5rem/600 | подзаголовок |
| `ds-label` | uppercase, 0.75rem, muted | подписи к полям |
| `ds-skeleton` | пульсирующий плейсхолдер загрузки | скелетоны |

Кнопка = `ds-btn` + модификатор: `<button className="ds-btn ds-btn-primary">`.

---

## 3. ЗАПРЕЩЕНО (нарушение = провал ревью/аудита)

| Нельзя | Надо |
|--------|------|
| Хардкод hex (`#fff`, `#000`, `#E8734A`) | `var(--accent)` и др. токены |
| `bg-white`, `text-white`, `bg-white/10` | `bg-[var(--bg-card)]`, `text-[var(--text-primary)]` |
| `backdrop-blur-*`, glassmorphism | удалить |
| `rounded-2xl` | `rounded-lg` (или `var(--radius-lg)`) |
| `font-black` | `font-bold` |
| Эмодзи в коде/UI | иконки `lucide-react` |
| `@keyframes` в компоненте | Tailwind `transition-*` (`transition-all duration-200`) |
| Внешние/unsplash картинки | только `public/images/` |
| Google Fonts import | `var(--font-playfair)` / `var(--font-outfit)` |
| Свои UI-библиотеки, StyleX | наш DS (`ds-*` + токены + Tailwind) |

---

## 4. Композиция (как собирать) — три сущности не смешивать

Точка (`places`) ≠ Маршрут (`kamchatka_routes`) ≠ Тур (`operator_tours`). Подробные блоки карточек — в `CLAUDE.md` §9 (точка) и §10 (маршрут).

### Скелет страницы
```tsx
export default function Page() {
  return (
    <div className="ds-page">
      <main style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px' }}>
        <h1 className="ds-h1">Заголовок</h1>
        <section className="ds-card" style={{ padding: 16 }}>…</section>
      </main>
    </div>
  );
}
```

### Карточка (пример)
```tsx
<div className="ds-card" style={{ padding: 16 }}>
  <h2 className="ds-h2">Вулкан Авачинский</h2>
  <span className="ds-badge" style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>Вулкан</span>
  <p style={{ color: 'var(--text-secondary)' }}>…описание…</p>
  <button className="ds-btn ds-btn-primary">Подробнее</button>
</div>
```

### Правила композиции
- На карточке ТОЧКИ — никакой коммерции (цены, «забронировать», авиабилеты/отели). Это про тур (CLAUDE.md §9).
- Цвет статуса: `--success` (норма) / `--warning` (внимание) / `--accent` (высокий) / `--danger` (опасность).
- Иконки — `lucide-react`, размер 13–16 в чипах, цвет через `var(--ocean)`/`var(--text-muted)`.
- Минимальная высота интерактивных элементов — 44px (уже в `ds-btn`/`ds-input`).

---

## 5. Для агентов: правило использования
Перед генерацией UI — свериться с этим файлом. Если нужного компонента нет среди `ds-*` — собрать из токенов и Tailwind, НЕ выдумывать несуществующие классы/библиотеки. Если сомнение в значении токена — открыть `app/globals.css`, не угадывать.

> Источник истины: `app/globals.css` (токены и `ds-*`), `CLAUDE.md` §2/§9/§10. Обновлено: июнь 2026.

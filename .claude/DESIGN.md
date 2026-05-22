# Дизайн-философия Ведар
> Обновлено: 19 мая 2026

---

## Одна метафора

**Лёгкий швейцарский нож — не тяжёлый чемодан с рекламными проспектами.**

Нож: лёгкий, каждый инструмент нужен, ничего лишнего.
Чемодан: тяжёлый, везде цены, реклама операторов, кнопка "Забронировать" на каждой странице.

---

## Эстетика

Суровая природа Камчатки + доверие + профессионализм.

**Не:**
- Минималистично-белый tech-стиль
- Cyberpunk, startup-purple, neon
- Generic travel (пальмы, радость, "Book now!")
- Glassmorphism (абсолютный запрет)

**Да:**
- Тёплая, земная, природная палитра (лавовый камень, вулканы, тайга)
- Editorial — как высококлассный travel-журнал
- Суровая красота без сентиментальности

---

## "Легкие линии" — визуальный язык

Ключевое дизайн-решение сезона 2026: **тонкие линии как ритм**.

### Словарь

| Элемент | Применение | CSS |
|---------|-----------|-----|
| **Акцентная черта** | Открывает секцию. Перед overline или заголовком. | `w-8 h-px bg-[var(--accent)]` |
| **Разделитель** | Между элементами списка. Горизонтальный ритм. | `border-t border-[var(--border)]` |
| **Вертикальный разделитель** | Между колонками в stats-сетке. | `divide-x divide-[var(--border)]` |
| **Граница секции** | Начало/конец полноширинной секции. | `border-y border-[var(--border)]` |

### Курсивный Playfair

Акцентные слова в заголовках — **курсивом**. Не для красоты, а для смысла.

```tsx
// Правильно — курсив несёт смысл
<h2>Штурман,{' '}
  <em className="italic text-[var(--accent)]">а не тур-агент</em>
</h2>

// Неправильно — весь заголовок курсивом
<h2 className="italic">Штурман, а не тур-агент</h2>
```

### Паттерн секции

Каждая значимая секция открывается так:
```tsx
<div className="w-8 h-px bg-[var(--accent)] mb-6" />          {/* акцентная черта */}
<p className="text-[10px] uppercase tracking-[0.3em] text-[var(--text-muted)] font-semibold mb-3">
  overline — контекст секции
</p>
<h2 className="font-playfair font-bold ...">
  Заголовок с <em className="italic text-[var(--accent)]">акцентом</em>
</h2>
```

### Списки с разделителями

Вместо карточек для списка фактов/возможностей:
```tsx
<ul>
  {ITEMS.map((item, i) => (
    <li key={i} className="border-t border-[var(--border)] py-5 flex items-start gap-4">
      {/* содержимое */}
    </li>
  ))}
  <li className="border-t border-[var(--border)]" /> {/* закрывающая черта */}
</ul>
```

---

## Воздух — это дизайн

Секции дышат. Плотность = недоверие.

| Контекст | Паддинг |
|---------|---------|
| Секция страницы | `py-16 md:py-24` |
| Контент внутри | `py-6` между элементами списка |
| Карточка | `p-5 md:p-6` |

---

## Типографика

| Роль | Шрифт | Класс | Размер |
|------|-------|-------|--------|
| Заголовок секции | Playfair Display | `font-playfair font-bold` | `clamp(1.8rem, 3vw, 2.75rem)` |
| Hero | Playfair Display | `font-playfair font-bold` | `clamp(2.6rem, 6.5vw, 5.5rem)` |
| Overline | Outfit | `text-[10px] uppercase tracking-[0.3em] font-semibold` | фикс |
| Тело | Outfit | `text-sm leading-relaxed` | — |
| Факт-число | Playfair Display | `font-playfair font-bold text-[var(--accent)]` | `clamp(1.3rem, 2vw, 1.8rem)` |

Никаких Google Fonts import. Шрифты грузятся через `app/layout.tsx`.

---

## Радиусы и геометрия

| Контекст | Радиус |
|---------|--------|
| Фото-ячейки (bento, карточки мест) | `rounded-sm` — чуть острее, editoral |
| Кнопки (ds-btn) | наследует из дизайн-системы |
| Иконки в abilities-списках | квадрат без радиуса (`border`, без `rounded`) |
| Стандартные карточки (ds-card) | `rounded-lg` |

---

## Анимации

Медленные, тихие. Не flashy.

| Тип | Класс |
|-----|-------|
| Hover переход цвета | `transition-colors duration-300` |
| Появление элемента | `transition-all duration-700` |
| Slideshow fade | `transition-opacity duration-[1200ms]` |
| Масштаб фото при hover | `group-hover:scale-105 transition-transform duration-700` |

Запрещено: `@keyframes` в компонентах, flashy CSS animations, `animate-spin` без необходимости.

---

## Коммерческие элементы в UI

Если коммерческий элемент попадает на страницу места или маршрута — он должен быть **невидимым почти**.

```
✗ Кнопка "Забронировать" → замени на ChevronRight + ссылку на marketplace
✗ "от 15 000 ₽" → убери цену
✗ Sticky bar с ценой → убери
✗ OfferCard с onClick(openModal) → замени на Link href="/marketplace/tours/[id]"
✓ "Туры по маршруту →" — ссылка в конце страницы, тихая
✓ ChevronRight вместо кнопки бронирования
✓ LeadModal как "Оставьте заявку" — мягко, в самом конце
```

---

## Запрещённые паттерны

```
glassmorphism (backdrop-blur-*)     → абсолютный запрет
bg-white/10                         → bg-[var(--bg-card)]
text-white, text-white/70           → CSS токены
border-white/20                     → border-[var(--border)]
хардкод hex (#D44A0C)               → var(--accent)
font-black                          → font-bold
rounded-2xl                         → rounded-lg или rounded-sm
emoji в UI                          → иконки lucide-react
```

---

## Проверка нового UI-компонента

Перед коммитом задай себе три вопроса:

1. **Это инструмент или витрина?** Каждый элемент отвечает на вопрос туриста?
2. **Есть ли воздух?** Не давит ли плотность контента?
3. **Где коммерция?** Если на странице места/маршрута — убери на marketplace.

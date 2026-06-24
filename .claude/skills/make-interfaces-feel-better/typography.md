# Typography

Text wrapping, font smoothing, and tabular numbers.

## Text Wrapping

```css
/* Headings and short text (≤6 lines Chromium, ≤10 Firefox) */
h1, h2, h3 { text-wrap: balance; }

/* Paragraphs, descriptions, captions, list items, card text (any length) */
p, li, .description { text-wrap: pretty; }

/* Very long text (10+ lines) — skip both to avoid layout cost */
```

```tsx
// Tailwind
<h1 className="text-balance">Заголовок страницы</h1>
<p className="text-pretty">Описание места или маршрута.</p>
```

`text-wrap: balance` — distributes text evenly across lines, great for headings.
`text-wrap: pretty` — prevents orphaned words at end of paragraphs. Recommended as default for body text.

## Font Smoothing (macOS)

```css
html {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

Apply at root level. Makes text crisper and thinner on macOS. Other platforms ignore it safely.
Already applied in globals.css? Verify — if not, add to `:root` or `html` selector.

## Tabular Numbers

```css
font-variant-numeric: tabular-nums;
```

```tsx
// Tailwind
<span className="tabular-nums">4,290 ₽</span>
<span className="tabular-nums">03:41</span>
```

**Use for:** counters, prices, timers, table columns, any number that changes dynamically.
**Skip for:** static display numbers, phone numbers, decorative numerals.

Makes all digits equal width — prevents layout shifts when numbers update (e.g., countdown, live prices).

# Performance

Transition specificity and GPU compositing.

## Never Use `transition: all`

`transition: all` forces the browser to watch every property for changes. Causes unexpected transitions on properties you didn't intend to animate, and is slower.

```css
/* Bad */
.button { transition: all 200ms ease-out; }

/* Good */
.button { transition: transform 150ms ease-out, background-color 200ms ease-out; }
```

```tsx
// Bad Tailwind
<button className="transition hover:bg-accent">

// Good Tailwind
<button className="transition-[background-color] duration-200 hover:bg-accent">
// or for multiple:
<button className="transition-[transform,background-color] duration-200">
```

Always name exactly which properties should animate.

## will-change: Use Sparingly

`will-change` pre-promotes elements to GPU compositing layers. Helps prevent first-frame stutter. But each extra compositing layer costs memory.

### GPU-compositable (benefit from will-change)
- `transform`
- `opacity`
- `filter`
- `clip-path`

### NOT GPU-compositable (don't use will-change)
- `background-color`
- `padding`
- `width`, `height`
- `top`, `left`
- `color`

```css
/* Good */
.modal { will-change: transform, opacity; }

/* Bad — these don't benefit from GPU */
.button { will-change: background-color; }
.card { will-change: all; }
```

**Rule:** Only add `will-change` when you observe actual performance issues (especially in Safari). Modern browsers handle most cases without it. Remove it after fixing the issue — leaving it permanently wastes memory.

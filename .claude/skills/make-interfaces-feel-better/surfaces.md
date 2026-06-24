# Surfaces

Border radius, optical alignment, shadows, and image outlines.

## Concentric Border Radius

```
outerRadius = innerRadius + padding
```

If padding > 24px, treat as separate surfaces.

```css
/* Good */
.card { border-radius: 20px; padding: 8px; }
.card-inner { border-radius: 12px; }  /* 20 - 8 = 12 ✓ */

/* Bad */
.card { border-radius: 12px; padding: 8px; }
.card-inner { border-radius: 12px; }  /* same radius, looks off */
```

```tsx
// Tailwind
<div className="rounded-2xl p-2">       {/* 16px radius, 8px padding */}
  <div className="rounded-lg">          {/* 8px radius = 16 - 8 ✓ */}
```

## Optical Alignment

### Buttons with Text + Icon
`icon-side padding = text-side padding - 2px`

```tsx
// Tailwind
<button className="pl-4 pr-3.5 flex items-center gap-2">
  <span>Continue</span>
  <ArrowRightIcon />
</button>
```

### Play Button Triangles
```css
.play-button svg { margin-left: 2px; }
```

### Asymmetric Icons
Fix in SVG directly, or use `margin-left: 1px` as fallback.

## Shadows Instead of Borders

For cards, buttons, containers — replace border with box-shadow. Shadows adapt to any background.
**Do NOT apply to dividers or layout separators.**

```css
:root {
  --shadow-border:
    0px 0px 0px 1px rgba(0, 0, 0, 0.06),
    0px 1px 2px -1px rgba(0, 0, 0, 0.06),
    0px 2px 4px 0px rgba(0, 0, 0, 0.04);
  --shadow-border-hover:
    0px 0px 0px 1px rgba(0, 0, 0, 0.08),
    0px 1px 2px -1px rgba(0, 0, 0, 0.08),
    0px 2px 4px 0px rgba(0, 0, 0, 0.06);
}

/* Dark mode */
--shadow-border: 0 0 0 1px rgba(255, 255, 255, 0.08);
--shadow-border-hover: 0 0 0 1px rgba(255, 255, 255, 0.13);
```

```css
.card {
  box-shadow: var(--shadow-border);
  transition-property: box-shadow;
  transition-duration: 150ms;
  transition-timing-function: ease-out;
}
.card:hover { box-shadow: var(--shadow-border-hover); }
```

| Use shadows | Use borders |
| --- | --- |
| Cards, buttons, containers | Dividers between list items |
| Elevated elements (dropdowns, modals) | Form input outlines (accessibility) |
| Elements on varied backgrounds | Hairline separators in dense UI |

## Image Outlines

```css
/* Light mode */
img { outline: 1px solid rgba(0, 0, 0, 0.1); outline-offset: -1px; }

/* Dark mode */
img { outline: 1px solid rgba(255, 255, 255, 0.1); outline-offset: -1px; }
```

```tsx
// Tailwind
<img className="outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10" />
```

**NEVER** use tinted palette colors (slate-900, zinc-900, #111827). They pick up the surface color and read as dirt.
Use ONLY pure black/white: R=0/G=0/B=0 or R=255/G=255/B=255.

## Minimum Hit Area

40×40px minimum for all interactive elements.

```css
.small-button {
  position: relative;
  width: 20px;
  height: 20px;
}
.small-button::after {
  content: "";
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: 40px; height: 40px;
}
```

```tsx
// Tailwind
<button className="relative size-5 after:absolute after:top-1/2 after:left-1/2 after:size-10 after:-translate-1/2">
```

If extended hit areas overlap, shrink the pseudo-element — but never let two interactive hit areas overlap.

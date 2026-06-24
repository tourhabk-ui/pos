# Animations

Interruptible animations, enter/exit transitions, and contextual icon animations.

## Interruptible Animations

Users change intent mid-interaction. If animations aren't interruptible, the interface feels broken.

### CSS Transitions vs. Keyframes

| | CSS Transitions | CSS Keyframe Animations |
| --- | --- | --- |
| **Behavior** | Interpolate toward latest state | Run on a fixed timeline |
| **Interruptible** | Yes — retargets mid-animation | No — restarts from beginning |
| **Use for** | Interactive state changes (hover, toggle, open/close) | Staged sequences that run once (enter animations, loading) |
| **Duration** | Adapts to remaining distance | Fixed regardless of state |

```css
/* Good — interruptible transition for a toggle */
.drawer {
  transform: translateX(-100%);
  transition: transform 200ms ease-out;
}
.drawer.open {
  transform: translateX(0);
}
```

```css
/* Bad — keyframe animation for interactive element */
.drawer.open {
  animation: slideIn 200ms ease-out forwards;
}
/* Closing mid-animation snaps or restarts — feels broken */
```

**Rule:** Always prefer CSS transitions for interactive elements. Reserve keyframes for one-shot sequences.

## Enter Animations: Split and Stagger

Don't animate a single large container. Break content into semantic chunks and animate each individually.

1. **Split** into logical groups (title, description, buttons)
2. **Stagger** with ~100ms delay between groups
3. **For titles**, consider splitting into individual words with ~80ms stagger
4. **Combine** `opacity`, `blur`, and `translateY` for the enter effect

```tsx
// Motion (Framer Motion) — staggered enter
function PageHeader() {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{
        visible: { transition: { staggerChildren: 0.1 } },
      }}
    >
      <motion.h1
        variants={{
          hidden: { opacity: 0, y: 12, filter: "blur(4px)" },
          visible: { opacity: 1, y: 0, filter: "blur(0px)" },
        }}
      >
        Welcome
      </motion.h1>

      <motion.p
        variants={{
          hidden: { opacity: 0, y: 12, filter: "blur(4px)" },
          visible: { opacity: 1, y: 0, filter: "blur(0px)" },
        }}
      >
        A description of the page.
      </motion.p>
    </motion.div>
  );
}
```

```css
/* CSS-Only Stagger */
.stagger-item {
  opacity: 0;
  transform: translateY(12px);
  filter: blur(4px);
  animation: fadeInUp 400ms ease-out forwards;
}

.stagger-item:nth-child(1) { animation-delay: 0ms; }
.stagger-item:nth-child(2) { animation-delay: 100ms; }
.stagger-item:nth-child(3) { animation-delay: 200ms; }

@keyframes fadeInUp {
  to { opacity: 1; transform: translateY(0); filter: blur(0); }
}
```

## Exit Animations

Exit animations should be softer and less attention-grabbing than enter animations.

```tsx
// Good — subtle exit
<motion.div
  exit={{
    opacity: 0,
    y: -12,
    filter: "blur(4px)",
    transition: { duration: 0.15, ease: "easeIn" },
  }}
>
```

```css
/* Good — subtle exit */
.item-exit {
  opacity: 0;
  transform: translateY(-12px);
  transition: opacity 150ms ease-in, transform 150ms ease-in;
}

/* Bad — dramatic exit that steals focus */
.item-exit {
  opacity: 0;
  transform: translateY(-100%) scale(0.5);
  transition: all 400ms ease-in;
}
```

**Key points:**
- Small fixed `translateY` (-12px) instead of full container height
- Exit duration shorter than enter (150ms vs 300ms)
- Keep some directional movement — never just `display: none`

## Contextual Icon Animations

EXACT values — do not deviate:
- `scale`: `0.25` → `1`
- `opacity`: `0` → `1`
- `filter`: `"blur(4px)"` → `"blur(0px)"`
- `transition`: `{ type: "spring", duration: 0.3, bounce: 0 }` — bounce must be `0`

```tsx
// With Framer Motion
function IconButton({ isActive, icon: Icon }) {
  return (
    <button>
      <AnimatePresence mode="popLayout">
        <motion.span
          key={isActive ? "active" : "inactive"}
          initial={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          transition={{ type: "spring", duration: 0.3, bounce: 0 }}
        >
          <Icon />
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
```

```tsx
// CSS cross-fade (no motion dependency)
function IconButton({ isActive, ActiveIcon, InactiveIcon }) {
  return (
    <button>
      <div className="relative">
        <div className={cn(
          "absolute inset-0 flex items-center justify-center",
          "transition-[opacity,filter,scale] duration-300",
          isActive ? "scale-100 opacity-100 blur-0" : "scale-[0.25] opacity-0 blur-[4px]"
        )}>
          <ActiveIcon />
        </div>
        <div className={cn(
          "transition-[opacity,filter,scale] duration-300",
          isActive ? "scale-[0.25] opacity-0 blur-[4px]" : "scale-100 opacity-100 blur-0"
        )}>
          <InactiveIcon />
        </div>
      </div>
    </button>
  );
}
```

**Rule:** Check `package.json` for `motion`/`framer-motion`. If present, use Motion. If not, use CSS cross-fade — don't add a dependency just for icon transitions.

## Scale on Press

Always `scale(0.96)`. Never below `0.95`. Use CSS transitions.

```tsx
// Tailwind
<button className="transition-transform duration-150 ease-out active:scale-[0.96]">

// Motion
<motion.button whileTap={{ scale: 0.96 }}>

// With static prop (disable when distracting)
function Button({ static: isStatic, ...props }) {
  return <button className={cn(!isStatic && "active:scale-[0.96]")} {...props} />;
}
```

## Skip Animation on Page Load

```tsx
// Good — icon doesn't animate in on mount
<AnimatePresence initial={false} mode="popLayout">
  <motion.span key={isActive ? "active" : "inactive"} ...>
    <Icon />
  </motion.span>
</AnimatePresence>
```

Use for: icon swaps, toggles, tabs, segmented controls.
Do NOT use for: staggered page heroes, loading states — it skips the entrance.

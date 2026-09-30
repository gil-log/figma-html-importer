# Figma HTML Importer

![img.png](img.png)

Paste any HTML into Figma and get a pixel-accurate layer tree. The plugin renders your markup in a
real browser engine, extracts every computed style, and rebuilds the result as native Figma frames,
text nodes, and vectors.

## Features

### Rendering

- **Full HTML documents or fragments** — works with a complete `<!DOCTYPE html>` page or a bare
  `<div>` snippet. A single element (a button, a card) is imported as a tightly cropped frame; a
  page with several top-level elements or a page background is imported whole.
- **Isolated rendering** — the HTML is rendered in its own sandboxed iframe sized to the chosen
  viewport, so `<head>` styles and `<script>` tags run in document order just like a normal page,
  and nothing leaks between imports. Scripts that throw or call `alert()` cannot break the plugin.
- **Tailwind CSS support** — the Tailwind Play CDN script in your HTML works as-is, including
  `tailwind.config = {...}` and `<style type="text/tailwindcss">` with `@apply`.
- **Responsive viewport** — choose from 6 presets (375×812 Mobile through 3840×2160 Extra Wide).
  Media queries, Tailwind breakpoints (`md:`, `lg:`), and `vw`/`vh` units are evaluated against that
  viewport.
- **Page background** — `html`/`body` backgrounds (including `<body class="bg-...">`) fill the
  imported frame, following the CSS canvas background rules. Pages without a background get white,
  as in the browser.

### Styles

- **Backgrounds** — solid colors and stacked linear gradients, drawn in the same direction as the
  browser (angles, side/corner keywords, non-square boxes) with percentage or px color stops.
- **Borders** — per-side widths, colors, and styles with inside stroke alignment.
- **Corner radius** — uniform or per-corner values.
- **Box shadows** — every layer of a multi-layer shadow (Tailwind `shadow-*` included) becomes a Figma
  drop or inner shadow with offset, blur, spread, and color. Spread-only rings on transparent
  elements (Tailwind `ring-*`) become strokes.
- **Opacity & overflow** — element opacity and `overflow: hidden` mapped to `clipsContent`.

### Typography

- **28+ font families mapped** including Inter, Roboto, Poppins, Pretendard, Noto Sans KR, and all
  common system fonts.
- **Korean font fallback chain** — Pretendard > Noto Sans KR > Inter, so Korean text always renders.
- **Font weight 100–900** — mapped to the correct Figma style name with `SemiBold` / `Semi Bold`
  variant handling to avoid silent fallback to Regular.
- **Italic, line-height, letter-spacing, text-align, and text-transform** all preserved
  (`uppercase` / `lowercase` / `capitalize` become Figma text case).
- **Styled inline runs** — inline `<strong>`, `<em>`, `<a>`, `<span>`, … inside a paragraph become
  character-range overrides for weight, italic, font family, size, color, underline/strike-through,
  text case, and letter spacing.
- **Measured text placement** — every text layer is placed on the glyph area the browser actually
  drew (measured with the Range API), so padding, flex/grid alignment, and `text-align` (including
  `start`/`end`) land exactly. Text that wraps in the browser keeps the element's content width and
  wraps at the same place; single-line text uses auto-width so it never wraps unexpectedly.
- **Whitespace** — source indentation and line breaks collapse like the browser does, while `pre`,
  `pre-wrap`, and `pre-line` keep theirs.
- **Truncation** — `text-overflow: ellipsis` and `-webkit-line-clamp` become Figma ending
  truncation with the same max lines.

### SVG & Images

- **SVG vector import** — `<svg>` elements are passed to `createNodeFromSvg` for native Figma
  vectors.
- **`<use>` inlining** — symbol references are resolved, viewBox scaling is applied, and
  `currentColor` is replaced with the actual computed color.
- **Image placeholders** — `<img>` tags become light-gray rounded rectangles preserving the original
  dimensions.

### Advanced DOM Handling

- **Pseudo-elements** — `::before` and `::after` with backgrounds, gradients, or border-radius (
  e.g., radio-button dots) are extracted as virtual child nodes.
- **Mixed content** — `<p>text <strong>bold</strong><br>text</p>` becomes a single Figma text node
  with styled ranges and line breaks. Inline pieces that draw their own box — badges with a
  background, icons, `inline-block` or `display: block` children — stay separate layers at their
  measured positions. Children hidden with `display: none` are left out.
- **Zero-size wrappers and `display: contents`** — children of zero-size absolutely positioned
  wrappers and of `display: contents` elements are kept at their real positions. Positions and sizes
  keep two decimal places, so 0.5px hairlines survive.
- **CSS color normalization** — oklch, `color(srgb ...)`, space-separated `rgb()`, and any other
  format are converted to legacy `rgb()` via a Canvas 2D round-trip.

## How It Works

1. **Paste HTML** — paste your markup into the text area.
2. **Pick a render width** — select the viewport breakpoint.
3. **Click "Import"** — the plugin renders the HTML off-screen, walks the DOM tree, serializes every
   element's bounding rect and computed style, then sends the data to the Figma sandbox which builds
   the layer tree.
4. **Edit in Figma** — the result is a normal Figma frame you can move, resize, and style.

## Limitations

- External images are shown as placeholder rectangles (Figma plugin sandbox cannot fetch
  cross-origin images).
- Fonts not installed in your Figma account fall back through the chain above.
- `position: fixed` elements are placed relative to the whole page, so a fixed bottom bar ends up at
  the bottom of the imported frame.
- CSS animations, transitions, and interactive states are not captured.

## Development

```bash
# Install dependencies
npm install

# Development (watch mode)
npm run dev

# Production build
npm run build
```

The build outputs `dist/code.js` (Figma sandbox) and `dist/ui.html` (plugin UI).

### Regression tests

```bash
# Build, then run every case in test/cases.mjs
npm test

# Run a subset, or run the cases against another build output
node test/run.mjs --grep shadow
node test/run.mjs --dist path/to/other/dist
```

The runner loads the built `dist/ui.html` in a 400×580 frame (the real plugin size) and executes
`dist/code.js` on top of a Figma API mock (`test/figma-mock.js`). The mock rejects the same calls the
real sandbox rejects — editing text with an unloaded font, resizing below 0.01, unsupported image
formats, invalid SVG — so runtime errors surface in the test run. Each case in `test/cases.mjs`
imports a small HTML snippet and asserts on the resulting node tree with numbers (positions, sizes,
fills, effects, font styles). It uses the installed Google Chrome, or a Playwright Chromium if Chrome
is missing (`npx playwright install chromium`).

## Feedback and Support

If you have questions, run into issues, or want to suggest improvements, please reach out via email
at [swgil007@naver.com](mailto:swgil007@naver.com).

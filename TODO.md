# TODO

## SSR robustness
- x-text rendering only handles `item.property` — no expressions, no nested access, no conditionals.
- x-for doesn't support destructuring or index.

## Routing
- No nested routes or dynamic params (`/posts/:id`)
- No 404 handling

## Head/meta management
- Pages can't set their own `<title>`, meta descriptions, or Open Graph tags. Essential for SEO, which is the main reason people want SSR.

## Static asset handling
- No asset hashing or cache busting headers.

## Components
- No props/attributes — `<game-tile>` can't receive data, it relies on the parent Alpine scope leaking `game` into it
- No slots or composition
- No nested components

## Developer experience
- No HMR or live reload — `--watch` restarts the server but the browser doesn't refresh
- No error overlay when a page has issues
- No TypeScript support in pages

## Hydration
- The data-ssr cleanup means Alpine re-renders everything the server already rendered — true hydration would reuse the existing DOM.

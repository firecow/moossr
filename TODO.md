# TODO

## Routing
- No nested routes or dynamic params (`/posts/:id`)

## Head/meta management
- Pages can't set their own `<title>`, meta descriptions, or Open Graph tags. Essential for SEO, which is the main reason people want SSR.

## Static asset handling
- No asset hashing or cache busting headers.

## Components
- No props/attributes — `<game-tile>` can't receive data, it relies on the parent Alpine scope leaking `game` into it
- No slots or composition
- No nested components

## Hydration
- The data-ssr cleanup means Alpine re-renders everything the server already rendered — true hydration would reuse the existing DOM.

# TODO

## Release blockers
- No README — needs to explain what MooSSR is, why it exists, and show a quick start example
- Not published on npm
- No license
- No error handling — if a page script's fetch fails during SSR, the server crashes
- 404 page — verify the notfound route works end-to-end
- No tests

## Routing
- ~~No dynamic params (`/albums/:id`) — needed for detail pages where a list item links to its own page~~

## Components
- No props — components rely on parent Alpine scope bleeding in, which is implicit coupling with no contract
- No slots — components can't accept children content
- No nested components — a component can't reference another component
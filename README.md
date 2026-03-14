# moossr

Server-side rendered Alpine.js with Bun.

## Install

```sh
bun add moossr
```

## Usage

Create a `server.ts`:

```ts
import { createServer } from "moossr";

const server = await createServer({ port: 3000 });
console.log(`http://localhost:${String(server.port)}`);
```

Run it:

```sh
bun run server.ts
```

### Project structure

```
├── layout.html
├── pages/
│   ├── index.html
│   ├── about.html
│   └── 404.html
├── components/
│   └── my-component.html
├── public/
│   └── logo.svg
└── server.ts
```

### Layout

`layout.html` is the shell for all pages. Use `<moo-route-outlet></moo-route-outlet>` to mark where page content is injected.

### Pages

Each `.html` file in `pages/` becomes a route:
- `index.html` → `/`
- `about.html` → `/about`
- `404.html` → fallback for unknown routes

Pages can include `<moo-head>` for per-page head/meta and `<script>` for server-side data fetching.

### Components

HTML files in `components/` are reusable fragments. A file named `game-tile.html` can be used as `<game-tile></game-tile>` in pages.

### Public

Files in `public/` are served statically. Asset paths are automatically hashed for cache busting.

## Options

```ts
createServer({
  port: 3000,                  // required
  layoutFile: "layout.html",   // default
  pagesDir: "pages",           // default
  componentsDir: "components", // default
  publicDir: "public",         // default
});
```

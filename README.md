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

const server = await createServer();
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
│   └── game-tile.html
├── public/
│   └── logo.svg
└── server.ts
```

### Layout

`layout.html` is the shell for all pages. Include [Alpine.js](https://alpinejs.dev/) and [Pinecone Router](https://github.com/pinecone-router/router), then use `<moo-route-outlet>` to mark where page content is injected.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>My App</title>
  <script src="https://cdn.jsdelivr.net/npm/pinecone-router@7.5.0/dist/router.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js"></script>
</head>
<body>
  <div x-data>
    <nav>
      <a href="/" x-link>Home</a>
      <a href="/about" x-link>About</a>
    </nav>
    <moo-route-outlet></moo-route-outlet>
  </div>
</body>
</html>
```

Use `x-link` on anchors for client-side navigation via Pinecone Router.

### Pages

Each `.html` file in `pages/` becomes a route:
- `index.html` → `/`
- `about.html` → `/about`
- `404.html` → fallback for unknown routes

#### Per-page head/meta

Use `<moo-head>` to set per-page `<title>` and `<meta>` tags. These merge into the layout's `<head>` at render time and update on client-side navigation.

```html
<moo-head>
  <title>About - My App</title>
  <meta name="description" content="About page description">
</moo-head>

<div>
  <h1>About</h1>
  <p>Hello world.</p>
</div>
```

#### Server-side data fetching

Add a `<script>` block to fetch data on the server. All declared variables become available as Alpine.js data in the page.

```html
<script>
const albums = await fetch("https://jsonplaceholder.typicode.com/albums").then(r => r.json());
</script>

<div>
  <template x-for="album in albums" :key="album.id">
    <p x-text="album.title"></p>
  </template>
</div>
```

The script runs server-side with `fetch` available. Declared variables are serialized into `x-data` on the root element, and `x-for` loops are pre-rendered for SSR.

### Components

HTML files in `components/` become reusable fragments. A file named `game-tile.html` is used as `<game-tile></game-tile>` in pages.

Components inherit data from their parent Alpine.js scope:

`components/game-tile.html`:
```html
<div class="game-tile">
  <h3 x-text="game.title"></h3>
  <p x-text="'#' + game.id"></p>
</div>
```

Used in a page:
```html
<template x-for="game in games" :key="game.id">
  <game-tile></game-tile>
</template>
```

### Public

Files in `public/` are served statically. Asset paths are automatically hashed for cache busting (e.g. `/logo.svg` → `/logo.a1b2c3d4.svg`).

## Options

```ts
createServer({
  port: 3000,                  // default
  layoutFile: "layout.html",   // default
  pagesDir: "pages",           // default
  componentsDir: "components", // default
  publicDir: "public",         // default
});
```

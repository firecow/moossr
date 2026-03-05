import { parseHTML } from "linkedom";
import { readdir } from "node:fs/promises";

const PORT = 3000;
const ORIGIN = `http://localhost:${PORT}`;

// Load components from components/ directory
async function loadComponents(): Promise<Map<string, string>> {
  const components = new Map<string, string>();
  for (const file of await readdir("components")) {
    if (!file.endsWith(".html")) continue;
    const tag = file.replace(".html", "");
    components.set(tag, await Bun.file(`components/${file}`).text());
  }
  return components;
}

// Build route table from pages/ directory
async function loadRoutes(): Promise<Map<string, string>> {
  const routes = new Map<string, string>();
  for (const file of await readdir("pages")) {
    if (!file.endsWith(".html")) continue;
    const route = file === "index.html" ? "/" : `/${file.replace(".html", "")}`;
    routes.set(route, await Bun.file(`pages/${file}`).text());
  }
  return routes;
}

// Replace <component-name> tags with component HTML
function resolveComponents(html: string, components: Map<string, string>): string {
  for (const [tag, content] of components) {
    html = html.replaceAll(`<${tag}></${tag}>`, content.trim());
    html = html.replaceAll(`<${tag} />`, content.trim());
    html = html.replaceAll(`<${tag}/>`, content.trim());
  }
  return html;
}

let routes = await loadRoutes();
let components = await loadComponents();

const server = Bun.serve({
  port: PORT,

  async fetch(req) {
    const url = new URL(req.url);

    // Reload in dev so you don't have to restart
    routes = await loadRoutes();
    components = await loadComponents();

    const layout = await Bun.file("layout.html").text();
    const html = await ssr(layout, url.pathname);
    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  },
});

async function ssr(layout: string, pathname: string): Promise<string> {
  // Generate <template x-route> for each page, with components resolved
  let routeTemplates = "";
  for (const [route, content] of routes) {
    const resolved = resolveComponents(content, components);
    routeTemplates += `<template x-route="${route}" x-template>\n${resolved}\n</template>\n`;
  }

  // Inject routes into layout
  let html = layout.replace("<!-- routes -->", routeTemplates);

  const { document } = parseHTML(html);

  // Find the route matching the current path
  const activeRoute = document.querySelector(
    `template[x-route="${pathname}"]`
  );
  if (!activeRoute) return document.toString();

  // Parse the route content for SSR processing
  const routeContent = activeRoute.innerHTML.trim();
  const { document: routeDoc } = parseHTML(routeContent);

  // Process x-init fetch calls
  for (const el of routeDoc.querySelectorAll("[x-init]")) {
    const xInit = el.getAttribute("x-init") ?? "";

    const fetchMatch = xInit.match(
      /(\w+)\s*=\s*await\s*\(await\s*fetch\(['"]([^'"]+)['"]\)\)\.json\(\)/
    );
    if (!fetchMatch) continue;

    const [, collectionVar, fetchUrl] = fetchMatch;

    const response = await fetch(
      fetchUrl.startsWith("http") ? fetchUrl : `${ORIGIN}${fetchUrl}`
    );
    const data = await response.json();

    // Inject data into x-data
    const xData = el.getAttribute("x-data") ?? "{}";
    el.setAttribute(
      "x-data",
      xData.replace(
        new RegExp(`${collectionVar}:\\s*\\[\\]`),
        `${collectionVar}: ${JSON.stringify(data)}`
      )
    );

    // Clean up SSR nodes when Alpine inits
    el.setAttribute(
      "x-init",
      `$el.querySelectorAll('[data-ssr]').forEach(e => e.remove())`
    );

    // Pre-render x-for templates
    const template = el.querySelector(
      `template[x-for*=" in ${collectionVar}"]`
    );
    if (!template) continue;

    const itemVar =
      template.getAttribute("x-for")?.match(/(\w+)\s+in\s+/)?.[1] ?? "";
    const templateContent = template.innerHTML.trim();

    for (const item of data as Record<string, unknown>[]) {
      // Parse within the same document to avoid stray <head>/<body> tags
      const wrapper = routeDoc.createElement("div");
      wrapper.innerHTML = templateContent;
      const root = wrapper.firstElementChild;
      if (!root) continue;

      root.setAttribute("data-ssr", "");

      for (const node of [root, ...root.querySelectorAll("[x-text]")]) {
        const xText = node.getAttribute("x-text");
        if (!xText) continue;
        const propMatch = xText.match(new RegExp(`${itemVar}\\.(\\w+)`));
        if (!propMatch) continue;
        node.textContent = String(item[propMatch[1]] ?? "");
        node.removeAttribute("x-text");
      }

      template.parentNode!.insertBefore(root, template);
    }
  }

  // Insert pre-rendered content before the route template
  const ssrContainer = document.createElement("div");
  ssrContainer.setAttribute("x-show", "false");
  ssrContainer.innerHTML = routeDoc.toString();
  activeRoute.before(ssrContainer);

  return document.toString();
}

console.log(`http://localhost:${server.port}`);

import { parseHTML } from "linkedom";

const PORT = 3000;
const ORIGIN = `http://localhost:${PORT}`;

const server = Bun.serve({
  port: PORT,

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/users") {
      return Response.json([
        { id: 1, name: "Alice", role: "Engineer" },
        { id: 2, name: "Bob", role: "Designer" },
        { id: 3, name: "Charlie", role: "Product" },
      ]);
    }

    // All routes serve the same index.html (SPA with client-side routing)
    let html = await Bun.file("index.html").text();
    html = await ssr(html, url.pathname);
    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  },
});

async function ssr(html: string, pathname: string): Promise<string> {
  const { document } = parseHTML(html);

  // Find the route template matching the current path
  for (const route of document.querySelectorAll("template[x-route]")) {
    const pattern = route.getAttribute("x-route") ?? "";
    if (pattern !== pathname) continue;

    // Pre-render route content for crawlers
    const routeContent = route.innerHTML.trim();
    const { document: routeDoc } = parseHTML(routeContent);

    // Process x-init fetch calls within this route
    for (const el of routeDoc.querySelectorAll("[x-init]")) {
      const xInit = el.getAttribute("x-init") ?? "";

      const fetchMatch = xInit.match(
        /(\w+)\s*=\s*await\s*\(await\s*fetch\(['"](\/[^'"]+)['"]\)\)\.json\(\)/
      );
      if (!fetchMatch) continue;

      const [, collectionVar, apiPath] = fetchMatch;

      const response = await fetch(`${ORIGIN}${apiPath}`);
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

      // Clean up SSR pre-rendered nodes when Alpine inits
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
        const { document: itemDoc } = parseHTML(templateContent);
        const root = itemDoc.querySelector("*");
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

        const imported = el.ownerDocument.importNode(root, true);
        template.parentNode!.insertBefore(imported, template);
      }
    }

    // Insert pre-rendered route content before the template (visible to crawlers)
    const ssrContainer = document.createElement("div");
    ssrContainer.setAttribute("data-ssr-route", "");
    ssrContainer.innerHTML = routeDoc.toString();
    route.before(ssrContainer);
  }

  return document.toString();
}

console.log(`http://localhost:${server.port}`);

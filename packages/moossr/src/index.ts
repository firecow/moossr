import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { extname } from "node:path";
import { parseHTML } from "linkedom";
import { runInNewContext } from "node:vm";

export interface MoossrOptions {
  port?: number;
  layoutFile?: string;
  pagesDir?: string;
  componentsDir?: string;
  publicDir?: string;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".eot": "application/vnd.ms-fontobject",
  ".gif": "image/gif",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function getMimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
}

async function isFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

function serializeDocument(doc: { toString(): string }): string {
  return doc.toString();
}

async function loadComponents(dir: string): Promise<Map<string, string>> {
  const components = new Map<string, string>();
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".html")) continue;
    const tag = file.replace(".html", "");
    components.set(tag, await readFile(`${dir}/${file}`, "utf-8"));
  }
  return components;
}

async function loadRoutes(dir: string): Promise<Map<string, string>> {
  const routes = new Map<string, string>();
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".html")) continue;
    const name = file.replace(".html", "");
    const route = name === "index" ? "/" : name === "404" ? "notfound" : `/${name}`;
    routes.set(route, await readFile(`${dir}/${file}`, "utf-8"));
  }
  return routes;
}

async function buildAssetManifest(dir: string): Promise<{ pathMap: Map<string, string>; fileMap: Map<string, string> }> {
  const pathMap = new Map<string, string>();
  const fileMap = new Map<string, string>();
  for (const file of await readdir(dir)) {
    if (!file.includes(".")) continue;
    const content = await readFile(`${dir}/${file}`);
    const hash = createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 8);
    const dotIndex = file.lastIndexOf(".");
    const hashedName = `${file.slice(0, dotIndex)}.${hash}${file.slice(dotIndex)}`;
    pathMap.set(`/${file}`, `/${hashedName}`);
    fileMap.set(`/${hashedName}`, `${dir}/${file}`);
  }
  return { pathMap, fileMap };
}

function rewriteAssetPaths(html: string, pathMap: Map<string, string>): string {
  for (const [original, hashed] of pathMap) {
    html = html.replaceAll(original, hashed);
  }
  return html;
}

function resolveComponents(html: string, components: Map<string, string>): string {
  for (const [tag, content] of components) {
    html = html.replaceAll(`<${tag}></${tag}>`, content.trim());
    html = html.replaceAll(`<${tag} />`, content.trim());
    html = html.replaceAll(`<${tag}/>`, content.trim());
  }
  return html;
}

function extractPageHead(html: string): { head: string; template: string } {
  const headRegex = /<moo-head>([\s\S]*?)<\/moo-head>/;
  const match = headRegex.exec(html);
  if (!match) return { head: "", template: html };
  return {
    head: match[1]?.trim() ?? "",
    template: html.replace(match[0], "").trim(),
  };
}

function extractPageScript(html: string): { script: string; template: string } {
  const scriptRegex = /<script>([\s\S]*?)<\/script>/;
  const match = scriptRegex.exec(html);
  if (!match) return { script: "", template: html };
  return {
    script: match[1]?.trim() ?? "",
    template: html.replace(match[0], "").trim(),
  };
}

function extractVariableNames(script: string): string[] {
  const names: string[] = [];
  const regex = /\b(?:const|let|var)\s+(\w+)\s*=/g;
  let match;
  while ((match = regex.exec(script)) !== null) {
    const name = match[1];
    if (name) names.push(name);
  }
  return names;
}

async function executeScript(script: string, variables: string[]): Promise<Record<string, unknown>> {
  const code = `(async () => { ${script}\nreturn { ${variables.join(", ")} }; })()`;
  return runInNewContext(code, { fetch }) as Promise<Record<string, unknown>>;
}

function scriptToXInit(script: string): string {
  return script.replace(/\b(const|let|var)\s+/g, "");
}

const CLIENT_SCRIPT = `<script>
(function() {
  function updateHead() {
    var path = location.pathname;
    var t = Array.from(document.querySelectorAll('template[x-route]'))
      .find(function(el) { return el.getAttribute('x-route') === path; })
      || document.querySelector('template[x-route="notfound"]');
    if (!t) return;
    if (t.dataset.title) document.title = t.dataset.title;
    var meta = document.querySelector('meta[name="description"]');
    if (t.dataset.description) {
      if (!meta) { meta = document.createElement('meta'); meta.setAttribute('name', 'description'); document.head.appendChild(meta); }
      meta.setAttribute('content', t.dataset.description);
    } else if (meta) {
      meta.remove();
    }
  }
  var _push = history.pushState;
  var _replace = history.replaceState;
  history.pushState = function() { _push.apply(history, arguments); updateHead(); };
  history.replaceState = function() { _replace.apply(history, arguments); updateHead(); };
  window.addEventListener('popstate', updateHead);
})();
</script>`;

async function ssr(
  layout: string,
  pathname: string,
  routes: Map<string, string>,
  components: Map<string, string>,
): Promise<string> {
  let routeTemplates = "";
  let activeData: Record<string, unknown> = {};
  let activeHead = "";

  for (const [route, content] of routes) {
    const resolved = resolveComponents(content, components);
    const { script, template: templateWithHead } = extractPageScript(resolved);
    const { head, template } = extractPageHead(templateWithHead);

    const isActive = route === pathname || (route === "notfound" && !routes.has(pathname));
    if (isActive) {
      activeHead = head;
    }

    let processedTemplate = template;

    if (script) {
      const variables = extractVariableNames(script);
      const data = await executeScript(script, variables);
      const xInit = scriptToXInit(script);

      if (isActive) {
        activeData = data;
      }

      const { document: tempDoc } = parseHTML(template);
      const root = tempDoc.firstElementChild;
      if (root) {
        const xDataEntries = variables
          .map((v) => `${v}: ${JSON.stringify(data[v])}`)
          .join(", ");
        root.setAttribute("x-data", `{ ${xDataEntries} }`);
        root.setAttribute("x-init", xInit);
        processedTemplate = root.outerHTML;
      }
    }

    const titleMatch = (/<title>([\s\S]*?)<\/title>/).exec(head);
    const pageTitle = titleMatch?.[1]?.trim() ?? "";
    const titleAttr = pageTitle ? ` data-title="${pageTitle.replaceAll('"', "&quot;")}"` : "";
    const descMatch = (/<meta\s+name="description"\s+content="([^"]*)"/).exec(head);
    const descAttr = descMatch?.[1] ? ` data-description="${descMatch[1].replaceAll('"', "&quot;")}"` : "";
    routeTemplates += `<template x-route="${route}"${titleAttr}${descAttr} x-template>\n${processedTemplate}\n</template>\n`;
  }

  let html = layout.replace("<moo-route-outlet></moo-route-outlet>", routeTemplates);

  if (activeHead) {
    const titleRegex = /<title>[\s\S]*?<\/title>/;
    const pageTitleMatch = titleRegex.exec(activeHead);
    if (pageTitleMatch) {
      html = html.replace(titleRegex, pageTitleMatch[0]);
      activeHead = activeHead.replace(pageTitleMatch[0], "").trim();
    }
    if (activeHead) {
      html = html.replace("</head>", `  ${activeHead}\n</head>`);
    }
  }

  html = html.replace("</body>", `${CLIENT_SCRIPT}\n</body>`);

  const { document } = parseHTML(html);

  const activeRoute = document.querySelector(
    `template[x-route="${pathname}"]`
  );
  if (!activeRoute) return serializeDocument(document);

  if (Object.keys(activeData).length === 0) return serializeDocument(document);

  const routeContent = activeRoute.innerHTML.trim();
  const { document: routeDoc } = parseHTML(routeContent);

  const xForRegex = /\(?\s*(\w+)(?:\s*,\s*(\w+))?\s*\)?\s+in\s+(\w+)/;
  for (const forTemplate of routeDoc.querySelectorAll("template[x-for]")) {
    const xFor = forTemplate.getAttribute("x-for") ?? "";
    const match = xForRegex.exec(xFor);
    if (!match) continue;

    const itemVar = match[1];
    const indexVar = match[2];
    const collectionVar = match[3];
    if (!itemVar || !collectionVar) continue;

    const collection = activeData[collectionVar];
    if (!Array.isArray(collection)) continue;
    const items = collection as unknown[];

    const templateContent = forTemplate.innerHTML.trim();

    for (let i = 0; i < items.length; i++) {
      const item: unknown = items[i];
      const wrapper = routeDoc.createElement("div");
      wrapper.innerHTML = templateContent;
      const root = wrapper.firstElementChild;
      if (!root) continue;

      root.setAttribute("data-ssr", "");

      const context: Record<string, unknown> = { [itemVar]: item };
      if (indexVar) context[indexVar] = i;

      for (const node of [root, ...root.querySelectorAll("[x-text]")]) {
        const xText = node.getAttribute("x-text");
        if (!xText) continue;
        try {
          const result = runInNewContext(xText, context) as unknown;
          node.textContent = typeof result === "string" || typeof result === "number"
            ? String(result)
            : JSON.stringify(result);
        } catch {
          continue;
        }
        node.removeAttribute("x-text");
      }

      forTemplate.parentNode?.insertBefore(root, forTemplate);
    }
  }

  const ssrRoot = routeDoc.querySelector("[x-init]");
  if (ssrRoot) {
    ssrRoot.setAttribute(
      "x-init",
      `$el.querySelectorAll('[data-ssr]').forEach(e => e.remove())`
    );
  }

  const ssrContainer = document.createElement("div");
  ssrContainer.setAttribute("x-show", "false");
  ssrContainer.innerHTML = serializeDocument(routeDoc);
  activeRoute.before(ssrContainer);

  return serializeDocument(document);
}

export async function createServer(options: MoossrOptions) {
  const {
    port = 3000,
    layoutFile = "layout.html",
    pagesDir = "pages",
    componentsDir = "components",
    publicDir = "public",
  } = options;

  let routes = await loadRoutes(pagesDir);
  let components = await loadComponents(componentsDir);
  let assets = await buildAssetManifest(publicDir);

  const server = createHttpServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const url = new URL(req.url ?? "/", `http://localhost:${String(port)}`);

    const hashedFile = assets.fileMap.get(url.pathname);
    if (hashedFile) {
      res.writeHead(200, {
        "Content-Type": getMimeType(hashedFile),
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(await readFile(hashedFile));
      return;
    }

    const staticPath = `${publicDir}${url.pathname}`;
    if (await isFile(staticPath)) {
      res.writeHead(200, { "Content-Type": getMimeType(staticPath) });
      res.end(await readFile(staticPath));
      return;
    }

    routes = await loadRoutes(pagesDir);
    components = await loadComponents(componentsDir);
    assets = await buildAssetManifest(publicDir);

    const layout = await readFile(layoutFile, "utf-8");
    const isKnownRoute = routes.has(url.pathname);
    const html = await ssr(layout, url.pathname, routes, components);
    res.writeHead(isKnownRoute ? 200 : 404, { "Content-Type": "text/html" });
    res.end(rewriteAssetPaths(html, assets.pathMap));
  }

  return new Promise<{ port: number }>((resolve) => {
    server.listen(port, () => {
      resolve({ port });
    });
  });
}

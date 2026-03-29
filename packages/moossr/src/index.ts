import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { extname, join, relative, sep } from "node:path";
import { parseHTML } from "linkedom";
import { runInNewContext } from "node:vm";

export interface MoossrOptions {
  port?: number;
  layoutFile?: string;
  pagesDir?: string;
  componentsDir?: string;
  publicDir?: string;
}

interface Route {
  pattern: string;
  paramNames: string[];
  regex: RegExp;
  content: string;
}

interface RouteMatch {
  route: Route;
  params: Record<string, string>;
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

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function filePathToRoute(relPath: string): Omit<Route, "content"> {
  const normalized = relPath.replaceAll(sep, "/").replace(/\.html$/, "");

  if (normalized === "index" || normalized === "404") {
    const pattern = normalized === "index" ? "/" : "notfound";
    return { pattern, paramNames: [], regex: normalized === "index" ? /^\/$/ : /(?!)/ };
  }

  const cleanPath = normalized.replace(/\/index$/, "");
  const paramNames: string[] = [];
  const regexParts: string[] = [];
  const patternParts: string[] = [];

  for (const segment of cleanPath.split("/")) {
    const bracketMatch = /^\[(\w+)\]$/.exec(segment);
    const paramName = bracketMatch?.[1];
    if (paramName) {
      paramNames.push(paramName);
      regexParts.push("([^/]+)");
      patternParts.push(`:${paramName}`);
    } else {
      regexParts.push(escapeRegex(segment));
      patternParts.push(segment);
    }
  }

  return {
    pattern: "/" + patternParts.join("/"),
    paramNames,
    regex: new RegExp(`^/${regexParts.join("/")}$`),
  };
}

async function walkPages(baseDir: string, currentDir: string, routes: Route[]): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkPages(baseDir, fullPath, routes);
    } else if (entry.name.endsWith(".html")) {
      const relPath = relative(baseDir, fullPath);
      const meta = filePathToRoute(relPath);
      routes.push({ ...meta, content: await readFile(fullPath, "utf-8") });
    }
  }
}

async function loadRoutes(dir: string): Promise<Route[]> {
  const routes: Route[] = [];
  await walkPages(dir, dir, routes);
  routes.sort((a, b) => {
    if (a.pattern === "notfound") return 1;
    if (b.pattern === "notfound") return -1;
    const aDynamic = a.paramNames.length > 0;
    const bDynamic = b.paramNames.length > 0;
    if (aDynamic !== bDynamic) return aDynamic ? 1 : -1;
    return 0;
  });
  return routes;
}

function matchRoute(pathname: string, routes: Route[]): RouteMatch | undefined {
  for (const route of routes) {
    if (route.pattern === "notfound") continue;
    const match = route.regex.exec(pathname);
    if (match) {
      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        const name = route.paramNames[i];
        const value = match[i + 1];
        if (name && value) params[name] = decodeURIComponent(value);
      }
      return { route, params };
    }
  }
  return undefined;
}

async function buildAssetManifest(dir: string): Promise<{ pathMap: Map<string, string>; fileMap: Map<string, string> }> {
  const pathMap = new Map<string, string>();
  const fileMap = new Map<string, string>();
  for (const file of await readdir(dir)) {
    if (!file.includes(".")) continue;
    const content = await readFile(`${dir}/${file}`);
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
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

async function executeScript(script: string, variables: string[], params: Record<string, string>): Promise<Record<string, unknown>> {
  const code = `(async () => { ${script}\nreturn { ${variables.join(", ")} }; })()`;
  return runInNewContext(code, { fetch, params }) as Promise<Record<string, unknown>>;
}

const ROUTER_BODY =
`const originalPush = history.pushState;
const originalReplace = history.replaceState;

function matchClientRoute(path) {
  for (const tpl of document.querySelectorAll('template[data-route]')) {
    const pattern = tpl.dataset.route;
    if (pattern === 'notfound') continue;
    const paramNames = [];
    const regexStr = pattern.replace(/:(\\w+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    const match = new RegExp('^' + regexStr + '$').exec(path);
    if (match) {
      const params = {};
      paramNames.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
      return { template: tpl, params };
    }
  }
  const notfound = document.querySelector('template[data-route="notfound"]');
  return notfound ? { template: notfound, params: {} } : null;
}

function navigate(path) {
  const outlet = document.getElementById('moo-outlet');
  const matched = matchClientRoute(path);
  if (!outlet || !matched) return;

  if (matched.template.dataset.title) {
    document.title = matched.template.dataset.title;
  }

  let meta = document.querySelector('meta[name="description"]');
  if (matched.template.dataset.description) {
    if (!meta) {
      meta = Object.assign(document.createElement('meta'), { name: 'description' });
      document.head.appendChild(meta);
    }
    meta.content = matched.template.dataset.description;
  } else {
    meta?.remove();
  }

  document.querySelector('[data-moo-ssr]')?.remove();
  window.__mooParams = matched.params;
  outlet.replaceChildren(matched.template.content.cloneNode(true));
  Alpine.initTree(outlet);
}

document.addEventListener('click', (e) => {
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const link = e.target.closest('[data-link]');
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute('href');
  if (href !== location.pathname) {
    history.pushState({}, '', href);
  }
});

history.pushState = (...args) => { originalPush.apply(history, args); navigate(location.pathname); };
history.replaceState = (...args) => { originalReplace.apply(history, args); navigate(location.pathname); };
window.addEventListener('popstate', () => navigate(location.pathname));`;

function routeComponentName(route: string): string {
  if (route === "/") return "mooIndex";
  const name = route.slice(1).replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase());
  return "moo" + name.charAt(0).toUpperCase() + name.slice(1);
}

function buildComponentScript(name: string, variables: string[], script: string, hydration: boolean): string {
  const defaults = variables.map((v) => `    ${v}: [],`).join("\n");
  const assigns = variables.map((v) => `      this.${v} = ${v};`).join("\n");
  const fetchBlock =
    `      const params = window.__mooParams || {};\n` +
    `      ${script}\n` +
    assigns;

  let initBody: string;
  if (hydration) {
    const hydrateAssigns = variables.map((v) => `        this.${v} = data.${v};`).join("\n");
    initBody =
      `      const el = document.getElementById('moo-ssr-data');\n` +
      `      if (el) {\n` +
      `        const data = JSON.parse(el.textContent);\n` +
      `${hydrateAssigns}\n` +
      `        el.remove();\n` +
      `        document.querySelector('[data-moo-ssr]')?.remove();\n` +
      `      } else {\n` +
      `  ${fetchBlock}\n` +
      `      }`;
  } else {
    initBody = fetchBlock;
  }

  return (
    `  Alpine.data('${name}', () => ({\n` +
    `${defaults}\n` +
    `    async init() {\n` +
    `${initBody}\n` +
    `    }\n` +
    `  }));`
  );
}

async function ssr(
  layout: string,
  pathname: string,
  routes: Route[],
  components: Map<string, string>,
  activeMatch: RouteMatch | undefined,
): Promise<string> {
  let routeTemplates = "";
  let activeData: Record<string, unknown> = {};
  let activeHead = "";
  const componentDefs: string[] = [];

  for (const route of routes) {
    const resolved = resolveComponents(route.content, components);
    const { script, template: templateWithHead } = extractPageScript(resolved);
    const { head, template } = extractPageHead(templateWithHead);

    const isActive = activeMatch ? route === activeMatch.route : route.pattern === "notfound";
    if (isActive) {
      activeHead = head;
    }

    let processedTemplate = template;

    if (script) {
      const variables = extractVariableNames(script);

      if (isActive) {
        activeData = await executeScript(script, variables, activeMatch?.params ?? {});
      }

      const componentName = routeComponentName(route.pattern);
      componentDefs.push(buildComponentScript(componentName, variables, script, isActive));

      const { document: tempDoc } = parseHTML(template);
      const root = tempDoc.firstElementChild;
      if (root) {
        root.setAttribute("x-data", `${componentName}()`);
        processedTemplate = root.outerHTML;
      }
    }

    const titleMatch = (/<title>([\s\S]*?)<\/title>/).exec(head);
    const pageTitle = titleMatch?.[1]?.trim() ?? "";
    const titleAttr = pageTitle ? ` data-title="${pageTitle.replaceAll('"', "&quot;")}"` : "";
    const descMatch = (/<meta\s+name="description"\s+content="([^"]*)"/).exec(head);
    const descAttr = descMatch?.[1] ? ` data-description="${descMatch[1].replaceAll('"', "&quot;")}"` : "";
    routeTemplates += `<template data-route="${route.pattern}"${titleAttr}${descAttr}>\n${processedTemplate}\n</template>\n`;
  }

  let html = layout.replace("<moo-route-outlet></moo-route-outlet>", `<div id="moo-outlet"></div>\n${routeTemplates}`);

  if (activeHead) {
    const titleRegex = /<title>[\s\S]*?<\/title>/;
    const pageTitleMatch = titleRegex.exec(activeHead);
    if (pageTitleMatch) {
      html = html.replace(titleRegex, pageTitleMatch[0]);
      activeHead = activeHead.replace(pageTitleMatch[0], "").trim();
    }
    if (activeHead) {
      html = html.replace("</title>", `</title>\n  ${activeHead}`);
    }
  }

  const initRoute =
    `  const outlet = document.getElementById('moo-outlet');\n` +
    `  const matched = matchClientRoute(location.pathname);\n` +
    `  if (outlet && matched) {\n` +
    `    window.__mooParams = matched.params;\n` +
    `    outlet.replaceChildren(matched.template.content.cloneNode(true));\n` +
    `  }`;
  const initParts = [...componentDefs, initRoute];
  const mooScript =
    `<script>\n` +
    `document.addEventListener('alpine:init', () => {\n` +
    initParts.join("\n") +
    `\n});\n\n` +
    ROUTER_BODY +
    `\n</script>`;
  const { document } = parseHTML(html);

  const activePattern = activeMatch?.route.pattern ?? pathname;
  const activeRoute = document.querySelector(`template[data-route="${activePattern}"]`);
  const headSuffix = `${mooScript}\n</head>`;
  function finalize(): string {
    return serializeDocument(document).replace("</head>", () => headSuffix);
  }

  if (!activeRoute) return finalize();

  if (Object.keys(activeData).length === 0) return finalize();

  const dataScript = document.createElement("script");
  dataScript.setAttribute("id", "moo-ssr-data");
  dataScript.setAttribute("type", "application/json");
  dataScript.textContent = JSON.stringify(activeData);
  document.querySelector("head")?.appendChild(dataScript);

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

      const context: Record<string, unknown> = { [itemVar]: item };
      if (indexVar) context[indexVar] = i;

      for (const node of [root, ...root.querySelectorAll("*")]) {
        for (const attr of [...node.attributes]) {
          if (attr.name === "x-text") {
            try {
              const result = runInNewContext(attr.value, context) as unknown;
              node.textContent = typeof result === "string" || typeof result === "number" ? String(result) : JSON.stringify(result);
            } catch {
              continue;
            }
            node.removeAttribute("x-text");
          } else if (attr.name.startsWith(":")) {
            try {
              const result = runInNewContext(attr.value, context) as unknown;
              node.setAttribute(attr.name.slice(1), String(result));
            } catch {
              continue;
            }
            node.removeAttribute(attr.name);
          }
        }
      }

      forTemplate.parentNode?.insertBefore(root, forTemplate);
    }

    forTemplate.remove();
  }

  const ssrRoot = routeDoc.firstElementChild;
  if (ssrRoot) {
    ssrRoot.removeAttribute("x-data");
    ssrRoot.removeAttribute("x-init");
  }

  const ssrContainer = document.createElement("div");
  ssrContainer.setAttribute("data-moo-ssr", "");
  ssrContainer.setAttribute("x-ignore", "");
  ssrContainer.innerHTML = serializeDocument(routeDoc);
  const outlet = document.querySelector("#moo-outlet");
  if (outlet) {
    outlet.before(ssrContainer);
  }

  return finalize();
}

export async function createServer(options: MoossrOptions = {}) {
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
    const activeMatch = matchRoute(url.pathname, routes);
    const html = await ssr(layout, url.pathname, routes, components, activeMatch);
    res.writeHead(activeMatch ? 200 : 404, { "Content-Type": "text/html" });
    res.end(rewriteAssetPaths(html, assets.pathMap));
  }

  return new Promise<{ port: number }>((resolve) => {
    server.listen(port, () => {
      resolve({ port });
    });
  });
}

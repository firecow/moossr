import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { readdir } from "node:fs/promises";

const PORT = 3000;

async function loadComponents(): Promise<Map<string, string>> {
  const components = new Map<string, string>();
  for (const file of await readdir("components")) {
    if (!file.endsWith(".html")) continue;
    const tag = file.replace(".html", "");
    components.set(tag, await Bun.file(`components/${file}`).text());
  }
  return components;
}

async function loadRoutes(): Promise<Map<string, string>> {
  const routes = new Map<string, string>();
  for (const file of await readdir("pages")) {
    if (!file.endsWith(".html")) continue;
    const name = file.replace(".html", "");
    const route = name === "index" ? "/" : name === "404" ? "notfound" : `/${name}`;
    routes.set(route, await Bun.file(`pages/${file}`).text());
  }
  return routes;
}

async function buildAssetManifest(): Promise<{ pathMap: Map<string, string>; fileMap: Map<string, string> }> {
  const pathMap = new Map<string, string>();
  const fileMap = new Map<string, string>();
  for (const file of await readdir("public")) {
    if (!file.includes(".")) continue;
    const content = await Bun.file(`public/${file}`).arrayBuffer();
    const hash = createHash("sha256")
      .update(new Uint8Array(content))
      .digest("hex")
      .slice(0, 8);
    const dotIndex = file.lastIndexOf(".");
    const hashedName = `${file.slice(0, dotIndex)}.${hash}${file.slice(dotIndex)}`;
    pathMap.set(`/${file}`, `/${hashedName}`);
    fileMap.set(`/${hashedName}`, `public/${file}`);
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

function extractPageScript(html: string): { script: string; template: string } {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) return { script: "", template: html };
  return {
    script: match[1].trim(),
    template: html.replace(match[0], "").trim(),
  };
}

function extractVariableNames(script: string): string[] {
  const names: string[] = [];
  const regex = /\b(?:const|let|var)\s+(\w+)\s*=/g;
  let match;
  while ((match = regex.exec(script)) !== null) {
    names.push(match[1]);
  }
  return names;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function executeScript(script: string, variables: string[]): Promise<Record<string, unknown>> {
  const fn = new AsyncFunction(`${script}\nreturn { ${variables.join(", ")} };`);
  return await fn();
}

function scriptToXInit(script: string): string {
  return script.replace(/\b(const|let|var)\s+/g, "");
}

let routes = await loadRoutes();
let components = await loadComponents();
let assets = await buildAssetManifest();

const server = Bun.serve({
  port: PORT,

  async fetch(req) {
    const url = new URL(req.url);

    // Serve hashed static assets with immutable cache
    const hashedFile = assets.fileMap.get(url.pathname);
    if (hashedFile) {
      return new Response(Bun.file(hashedFile), {
        headers: { "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }

    // Serve static files from public/
    const staticFile = Bun.file(`public${url.pathname}`);
    if (await staticFile.exists()) {
      return new Response(staticFile);
    }

    // Reload in dev so you don't have to restart
    routes = await loadRoutes();
    components = await loadComponents();
    assets = await buildAssetManifest();

    const layout = await Bun.file("layout.html").text();
    const isKnownRoute = routes.has(url.pathname);
    const html = await ssr(layout, url.pathname);
    return new Response(rewriteAssetPaths(html, assets.pathMap), {
      status: isKnownRoute ? 200 : 404,
      headers: { "Content-Type": "text/html" },
    });
  },
});

async function ssr(layout: string, pathname: string): Promise<string> {
  let routeTemplates = "";
  let activeData: Record<string, unknown> = {};

  for (const [route, content] of routes) {
    const resolved = resolveComponents(content, components);
    const { script, template } = extractPageScript(resolved);

    let processedTemplate = template;

    if (script) {
      const variables = extractVariableNames(script);
      const data = await executeScript(script, variables);
      const xInit = scriptToXInit(script);

      if (route === pathname) {
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

    routeTemplates += `<template x-route="${route}" x-template>\n${processedTemplate}\n</template>\n`;
  }

  let html = layout.replace("<!-- routes -->", routeTemplates);
  const { document } = parseHTML(html);

  const activeRoute = document.querySelector(
    `template[x-route="${pathname}"]`
  );
  if (!activeRoute) return document.toString();

  if (Object.keys(activeData).length === 0) return document.toString();

  // Pre-render x-for templates for active route
  const routeContent = activeRoute.innerHTML.trim();
  const { document: routeDoc } = parseHTML(routeContent);

  for (const forTemplate of routeDoc.querySelectorAll("template[x-for]")) {
    const xFor = forTemplate.getAttribute("x-for") ?? "";
    const match = xFor.match(/\(?\s*(\w+)(?:\s*,\s*(\w+))?\s*\)?\s+in\s+(\w+)/);
    if (!match) continue;

    const [, itemVar, indexVar, collectionVar] = match;
    const collection = activeData[collectionVar];
    if (!Array.isArray(collection)) continue;

    const templateContent = forTemplate.innerHTML.trim();

    for (let i = 0; i < collection.length; i++) {
      const item = collection[i];
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
          const keys = Object.keys(context);
          const fn = new Function(...keys, `return ${xText}`);
          node.textContent = String(fn(...keys.map((k) => context[k])) ?? "");
        } catch {
          continue;
        }
        node.removeAttribute("x-text");
      }

      forTemplate.parentNode!.insertBefore(root, forTemplate);
    }
  }

  // SSR container only needs cleanup, not re-fetch
  const ssrRoot = routeDoc.querySelector("[x-init]");
  if (ssrRoot) {
    ssrRoot.setAttribute(
      "x-init",
      `$el.querySelectorAll('[data-ssr]').forEach(e => e.remove())`
    );
  }

  const ssrContainer = document.createElement("div");
  ssrContainer.setAttribute("x-show", "false");
  ssrContainer.innerHTML = routeDoc.toString();
  activeRoute.before(ssrContainer);

  return document.toString();
}

console.log(`http://localhost:${server.port}`);

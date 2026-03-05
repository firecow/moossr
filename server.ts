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
    const route = file === "index.html" ? "/" : `/${file.replace(".html", "")}`;
    routes.set(route, await Bun.file(`pages/${file}`).text());
  }
  return routes;
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

const server = Bun.serve({
  port: PORT,

  async fetch(req) {
    const url = new URL(req.url);

    // Serve static files from public/
    const staticFile = Bun.file(`public${url.pathname}`);
    if (await staticFile.exists()) {
      return new Response(staticFile);
    }

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
    const match = xFor.match(/(\w+)\s+in\s+(\w+)/);
    if (!match) continue;

    const [, itemVar, collectionVar] = match;
    const collection = activeData[collectionVar];
    if (!Array.isArray(collection)) continue;

    const templateContent = forTemplate.innerHTML.trim();

    for (const item of collection as Record<string, unknown>[]) {
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
        node.textContent = String(
          (item as Record<string, unknown>)[propMatch[1]] ?? ""
        );
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

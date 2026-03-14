import { join } from "node:path";
import { createServer } from "moossr";

const dir = import.meta.dirname;

const server = await createServer({
  layoutFile: join(dir, "layout.html"),
  pagesDir: join(dir, "pages"),
  componentsDir: join(dir, "components"),
  publicDir: join(dir, "public"),
});
console.log(`http://localhost:${String(server.port)}`);

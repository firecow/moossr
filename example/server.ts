import { join } from "node:path";
import { createServer } from "moossr";

const dir = import.meta.dir;

const server = await createServer({
  port: 3000,
  layoutFile: join(dir, "layout.html"),
  pagesDir: join(dir, "pages"),
  componentsDir: join(dir, "components"),
  publicDir: join(dir, "public"),
});
console.log(`http://localhost:${String(server.port)}`);

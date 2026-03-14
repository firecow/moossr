import { createServer } from "moossr";

const server = await createServer({ port: 3000 });
console.log(`http://localhost:${String(server.port)}`);

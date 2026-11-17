import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

export async function serveDemo(port = 4173) {
  const server = createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405).end();
        return;
      }
      const url = new URL(request.url, "http://localhost");
      const pathname = url.pathname === "/" ? "/examples/browser/index.html" : decodeURIComponent(url.pathname);
      const path = resolve(root, `.${pathname}`);
      const permitted = [resolve(root, "dist"), resolve(root, "examples/browser")];
      if (!permitted.some((directory) => path.startsWith(`${directory}${sep}`)) || !contentTypes[extname(path)]) {
        response.writeHead(404).end();
        return;
      }
      const body = await readFile(path);
      response.writeHead(200, { "Content-Type": contentTypes[extname(path)], "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const { port: actualPort } = server.address();
  return { server, url: `http://127.0.0.1:${actualPort}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, url } = await serveDemo(Number(process.env.HUDDLE_DEMO_PORT ?? 4173));
  console.log(`Huddle audio demo: ${url}`);
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};

export async function serveDemoFile(request, response) {
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405).end();
        return;
      }
      const url = new URL(request.url, "http://localhost");
      const pathname = url.pathname === "/" ? "/examples/browser/index.html" : decodeURIComponent(url.pathname);
      const vendor = pathname.startsWith("/vendor/@noble/curves/") || pathname.startsWith("/vendor/@noble/hashes/");
      const path = resolve(root, vendor ? `node_modules/${pathname.slice("/vendor/".length)}` : `.${pathname}`);
      const permitted = [resolve(root, "dist"), resolve(root, "examples/browser"),
        ...(vendor ? [resolve(root, "node_modules/@noble/curves"), resolve(root, "node_modules/@noble/hashes")] : [])];
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
}

export async function serveDemo(port = 4173, entry = "/examples/browser/index.html") {
  const server = createServer((request, response) => {
    if (new URL(request.url, "http://localhost").pathname === "/") request.url = entry;
    return serveDemoFile(request, response);
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

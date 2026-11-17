import { serveDemo } from "./serve-demo.mjs";

const { server, url } = await serveDemo(Number(process.env.HUDDLE_AGENT_PORT ?? 4181), "/examples/browser/agent.html");
console.log(`AI Huddle connection test: ${url}`);
console.log("Test provider only; no AI model, speech recognition or external API is connected.");
const stop = () => { server.close(); server.closeAllConnections(); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8000);
const openaiModel = process.env.OPENAI_MODEL || "gpt-5.4-mini";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store"
  });
  res.end(body);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

function messagesToPrompt(messages) {
  return (messages || [])
    .map(message => `${message.role || "user"}: ${message.content || ""}`)
    .join("\n\n");
}

function extractOutputText(data) {
  if (data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

async function handleLlm(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    send(res, 500, JSON.stringify({
      error: "OPENAI_API_KEY is not set on the server. Run: $env:OPENAI_API_KEY='your_key'; node server.mjs"
    }));
    return;
  }

  const payload = await readJson(req);
  const model = payload.model || openaiModel;
  const system = (payload.messages || [])
    .filter(message => message.role === "system")
    .map(message => message.content)
    .join("\n\n");

  const input = messagesToPrompt((payload.messages || []).filter(message => message.role !== "system"));

  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      instructions: system,
      input,
      temperature: payload.temperature ?? 0.85
    })
  });

  const data = await upstream.json();
  if (!upstream.ok) {
    send(res, upstream.status, JSON.stringify({ error: data.error?.message || "OpenAI request failed" }));
    return;
  }

  const content = extractOutputText(data);
  send(res, 200, JSON.stringify({
    choices: [{ message: { content } }],
    output_text: content
  }));
}

async function handleStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);
  if (!filePath.startsWith(root)) {
    send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  try {
    const body = await readFile(filePath);
    send(res, 200, body, types[extname(filePath)] || "application/octet-stream");
  } catch {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/llm") {
      await handleLlm(req, res);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      await handleStatic(req, res);
      return;
    }
    send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
  } catch (error) {
    send(res, 500, JSON.stringify({ error: error.message || "Server error" }));
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`Argue game server listening on http://127.0.0.1:${port}`);
});

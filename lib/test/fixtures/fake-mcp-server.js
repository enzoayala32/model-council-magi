/**
 * Servidor MCP falso reusable (para tests). Habla JSON-RPC 2.0 por stdio.
 *
 * Herramientas:
 *   - list_files / leer        -> solo lectura
 *   - get_updates              -> el servidor la declara readOnlyHint=false
 *   - search_created_issues    -> solo lectura
 *   - borrar / ejecutar        -> escritura real
 *
 * Variables de entorno que lee (para verificar el aislamiento):
 *   - si ve APP_ACCESS_TOKEN/NVIDIA_API_KEY, los incluye en la respuesta de
 *     `envcheck`, y el test comprueba que NO están.
 *
 * Uso: node fake-mcp-server.js [--puerto HTTP]
 */
const args = process.argv.slice(2);
const httpMode = args.includes("--http");
const httpPort = Number((args.find((a) => a.startsWith("--port=")) ?? "").split("=")[1] ?? 8799);

function toolsCatalog() {
  return [
    { name: "list_files", description: "lista archivos de un directorio" },
    { name: "leer", description: "lee un dato de prueba" },
    { name: "get_updates", description: "devuelve novedades", readOnlyHint: false },
    { name: "search_created_issues", description: "busca issues creadas" },
    { name: "borrar", description: "borra un archivo (escritura real)" },
    { name: "ejecutar", description: "ejecuta un comando" },
    { name: "envcheck", description: "devuelve el entorno del proceso" },
    { name: "gigante", description: "devuelve una respuesta enorme" },
  ];
}

let ejecutadas = {};

function handle(msg) {
  const id = msg.id;
  if (msg.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "falso", version: "1.0.0" },
      },
    };
  }
  if (msg.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (msg.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: toolsCatalog() } };
  if (msg.method === "tools/call") {
    const name = msg.params && msg.params.name;
    const toolArgs = (msg.params && msg.params.arguments) || {};
    if (name === "envcheck") {
      const visto = {};
      for (const key of ["APP_ACCESS_TOKEN", "NVIDIA_API_KEY", "MAGI_TOTP_KEY", "GITHUB_TOKEN", "MI_TOKEN_MCP"]) {
        if (process.env[key] !== undefined) visto[key] = process.env[key];
      }
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(visto) }] } };
    }
    if (name === "gigante") {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "X".repeat(12 * 1024 * 1024) }] } };
    }
    if (!toolsCatalog().some((t) => t.name === name)) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "herramienta desconocida: " + name } };
    }
    ejecutadas[name] = (ejecutadas[name] ?? 0) + 1;
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: "EJECUTO:" + name + ":" + JSON.stringify(toolArgs) }] },
    };
  }
  if (msg.method === "notificacion/ejecutadas") return { jsonrpc: "2.0", id, result: ejecutadas };
  // A proposito: nunca responde. Sirve para probar el timeout del cliente.
  if (msg.method === "cuelga") return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "metodo desconocido" } };
}

function arrancarHttp(http) {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "solo POST" } }));
      return;
    }
    // A proposito: no responde nunca. Sirve para probar el timeout.
    if (req.url === "/cuelga") return;
    // Redireccion a pedido: para probar que el cliente no la sigue.
    if (req.url === "/redirige") {
      res.writeHead(307, { location: "http://127.0.0.1:1/privado" });
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk.toString()));
    req.on("end", () => {
      let msg = null;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON invalido" } }));
        return;
      }
      const out = handle(msg);
      if (out === null) return; // no responder (timeout de prueba)
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  server.listen(httpPort, "127.0.0.1", () => {
    process.stdout.write("listo http " + httpPort + "\n");
  });
}

function arrancarStdio() {
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch {
          msg = null;
        }
        if (msg && typeof msg.id === "number") {
          const out = handle(msg);
          // `null` = no responder (timeout de prueba): no se escribe nada.
          if (out !== null) process.stdout.write(JSON.stringify(out) + "\n");
        }
      }
      index = buffer.indexOf("\n");
    }
  });
}

if (httpMode) {
  import("node:http").then((modulo) => arrancarHttp(modulo.default ?? modulo));
} else {
  arrancarStdio();
}

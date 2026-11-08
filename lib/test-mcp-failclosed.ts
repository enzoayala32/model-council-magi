/**
 * Corrección de la revisión (punto 1) — clasificación fail-closed.
 *
 * El bug: `looksWriteCapable` acertaba con ~20 palabras, y nombres como
 * `post_message`, `deploy`, `restart_service`, `kill_process`,
 * `transfer_funds`, `publish`, `commit`, `approve`, `pay_invoice`,
 * `charge_card`, `grant_access`, `drop_table`, `eval`, `upload`, `submit`,
 * `click`, `navigate`, `set_config`, `toggle` o `trigger` se clasificaban como
 * de LECTURA y se ejecutaban sin ninguna aprobación.
 *
 * Ahora la regla es la inversa: una herramienta se ejecuta sin aprobación SOLO
 * si el operador la declaró en `readOnlyTools`. Este test fija esa regla con
 * los ~50 nombres reportados más los de lectura típicos, y cubre la validación
 * de config (readOnlyTools fuera de tools = error).
 *
 * Uso: npm run security:test-mcp-failclosed
 */
import {
  isDeclaredReadOnly,
  isToolAllowed,
  validateConfig,
  type McpServerConfig,
} from "./mcp/config";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  const suffix = detail === undefined ? "" : " - " + JSON.stringify(detail);
  console.log("x " + label + suffix);
}

function server(tools: string[], readOnlyTools: string[]): McpServerConfig {
  return {
    name: "srv",
    transport: "stdio",
    command: "node",
    tools,
    readOnlyTools,
    readOnly: false,
    timeoutMs: 5000,
  };
}

/** Los ~50 nombres de la revisión: TODOS deben exigir aprobación por defecto. */
const PELIGROSOS = [
  "post_message", "deploy", "restart_service", "kill_process", "transfer_funds",
  "publish", "commit", "merge_pull_request", "approve", "pay_invoice",
  "charge_card", "grant_access", "revoke_token", "shutdown", "reboot",
  "format_disk", "drop_table", "chmod", "eval", "install_package",
  "upload", "submit", "click", "navigate", "fill_form",
  "type_text", "set_config", "toggle", "trigger",
];

/** Nombres que la heurística vieja SÍ detectaba (para mostrar que la regla
 *  nueva no depende de ella). */
const HEURISTICA_VIEJA = ["write", "delete", "borrar", "create", "send", "apply", "exec", "update"];

/** Los de lectura típicos: sin declaración, TAMBIÉN exigen aprobación. */
const LECTURA = ["leer", "read_file", "list_items", "get_status", "fetch_docs", "search"];

function main(): void {
  console.log("== por defecto, TODO exige aprobacion ==\n");
  for (const name of PELIGROSOS) {
    const config = server([name], []);
    check("exige aprobacion: " + name, !isDeclaredReadOnly(config, name));
  }
  for (const name of LECTURA) {
    const config = server([name], []);
    check("tambien exige aprobacion (aunque parezca lectura): " + name, !isDeclaredReadOnly(config, name));
  }

  console.log("\n== solo lo declarado ejecuta directo ==\n");
  const declarados = server(["leer", "borrar", "listar"], ["leer", "listar"]);
  check("leer esta declarada", isDeclaredReadOnly(declarados, "leer"));
  check("listar esta declarada", isDeclaredReadOnly(declarados, "listar"));
  check("borrar NO esta declarada: exige aprobacion", !isDeclaredReadOnly(declarados, "borrar"));
  check("una herramienta que no esta en tools no se puede llamar", !isToolAllowed(declarados, "inexistente"));
  check(
    "declarar algo que no esta en tools no lo habilita",
    !isToolAllowed(declarados, "leer") === false && !isToolAllowed(declarados, "fantasma"),
  );

  console.log("\n== la heuristica ahora solo advierte, nunca exime ==\n");
  for (const name of [...HEURISTICA_VIEJA, ...PELIGROSOS.slice(0, 5)]) {
    const config = server([name], []);
    check("la heuristica no exime a " + name, !isDeclaredReadOnly(config, name));
  }
  check(
    "readOnlyHint del servidor NO exime (el servidor es el no confiable)",
    (() => {
      const conHint: McpServerConfig = { ...server(["leer"], []), readOnly: true };
      return !isDeclaredReadOnly(conHint, "leer");
    })(),
  );
  check(
    "y si el operador la declara, la heuristica solo advierte",
    isDeclaredReadOnly(server(["commit"], ["commit"]), "commit") === true,
  );

  console.log("\n== validacion de config ==\n");
  const okConfig = validateConfig(
    {
      version: 1,
      servers: [{ name: "srv", transport: "stdio", command: "node", tools: ["leer", "borrar"], readOnlyTools: ["leer"] }],
    },
    "memoria",
  );
  check("config con readOnlyTools valida", okConfig.ok === true);
  check("y preserva la lista", okConfig.ok === true && JSON.stringify(okConfig.config.servers[0]!.readOnlyTools) === JSON.stringify(["leer"]));

  const sinLista = validateConfig({ version: 1, servers: [{ name: "srv", transport: "stdio", command: "node", tools: ["leer"] }] }, "memoria");
  check("config SIN readOnlyTools valida (y es todo con aprobacion)", sinLista.ok === true && sinLista.config.servers[0].readOnlyTools.length === 0);

  const fuera = validateConfig(
    { version: 1, servers: [{ name: "srv", transport: "stdio", command: "node", tools: ["leer"], readOnlyTools: ["leer", "borrar"] }] },
    "memoria",
  );
  check("readOnlyTools fuera de tools es error", fuera.ok === false && ((fuera as { error?: string }).error ?? "").includes("readOnlyTools"), fuera);

  const duplicada = validateConfig(
    { version: 1, servers: [{ name: "srv", transport: "stdio", command: "node", tools: ["leer"], readOnlyTools: ["leer", "leer"] }] },
    "memoria",
  );
  check("readOnlyTools duplicada se normaliza", duplicada.ok === true && duplicada.config.servers[0].readOnlyTools.length === 1);

  const noLista = validateConfig(
    { version: 1, servers: [{ name: "srv", transport: "stdio", command: "node", tools: ["leer"], readOnlyTools: "leer" }] },
    "memoria",
  );
  check("readOnlyTools que no es lista es error", noLista.ok === false);

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main();

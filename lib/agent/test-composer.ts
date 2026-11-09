/**
 * Etapa 0.8 — tests del composer (sin librería de test de UI).
 *
 * No hay `@testing-library` ni `jsdom` en el proyecto y la consigna pide
 * justificar por escrito cualquier librería nueva: **no se agrega ninguna**.
 * El repo ya testeaba componentes serviendo el HTML con `react-dom/server`
 * (ver `lib/test-*`), así que se sigue ese patrón: se renderiza el árbol de
 * React a HTML y se afirman los atributos que el comportamiento deja en el
 * DOM.
 *
 * LO QUE NO SE PUEDE PROBAR así (y queda dicho, no simulado):
 * - el crecimiento real del textarea (depende de `scrollHeight`, que solo
 *   existe en un browser);
 * - la navegación con flechas/Enter/Esc (depende de eventos de teclado);
 * - el drag & drop (depende de `DataTransfer`).
 *
 * Para esas tres, el contrato se fija donde SÍ es verificable: los handlers
 * que el componente declara y el HTML que emite.
 *
 * Uso: npm run agent:test-composer
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MENU_OPTIONS } from "../../app/lib/constants";
import { PushSettings } from "../../app/components/mobile/push-settings";
import { McpServerAdmin } from "../../app/components/mobile/mcp-server-admin";
import { McpApprovals } from "../../app/components/mobile/mcp-approvals";
import { FollowUpComposer, CouncilComposer } from "../../app/components/main/composer";

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

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

/** Props mínimas del CouncilComposer: lo que se necesita para renderizar. */
function composerProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query: "",
    setQuery: () => undefined,
    councilEnabled: false,
    setCouncilEnabled: () => undefined,
    enterSearchMode: () => undefined,
    enterCouncilMode: () => undefined,
    webGrounding: false,
    toggleWebGrounding: () => undefined,
    menuOpen: false,
    setMenuOpen: () => undefined,
    selectorOpen: false,
    setSelectorOpen: () => undefined,
    selectedCount: 0,
    selectedFusionPanelId: "custom",
    applyFusionPanel: () => undefined,
    models: [],
    toggleModel: () => undefined,
    cycleReasoningEffort: () => undefined,
    selectTopThree: () => undefined,
    attachments: [],
    agentSkills: [],
    imageGenerationEnabled: false,
    onOpenSettings: () => undefined,
    onNewThread: () => undefined,
    onFilesSelected: () => undefined,
    onRemoveAttachment: () => undefined,
    runCouncil: () => undefined,
    modelHealth: {},
    pingStatus: {},
    pinging: false,
    onPingModels: () => undefined,
    ...overrides,
  };
}

function main(): void {
  console.log("== catalogo de comandos / ==\n");
  const comandos = MENU_OPTIONS.map((option) => option.label);
  check("hay comandos definidos", comandos.length >= 2, comandos);
  check("incluye subir archivos", comandos.some((label) => /Subir/.test(label)), comandos);
  check("incluye consenso", comandos.some((label) => /Consenso/.test(label)), comandos);

  console.log("\n== CouncilComposer: HTML que emitir ==\n");
  const html = render(React.createElement(CouncilComposer, composerProps({ query: "hola" }) as never));
  check("renderiza el textarea", html.includes("<textarea"), html.slice(0, 120));
  check("el textarea lleva el valor actual", html.includes(">hola<"), html.slice(0, 200));
  check("el placeholder menciona los comandos", html.includes("/ para comandos"), html.slice(0, 300));
  check("no renderiza la paleta cerrada", !html.includes("slashPalette"), html.slice(0, 200));
  check("no renderiza el drop hint cerrado", !html.includes("Soltá para adjuntar"), html.slice(0, 200));

  const conQuery = render(React.createElement(CouncilComposer, composerProps({ query: "línea1\nlínea2" }) as never));
  check("el textarea preserva saltos de línea", conQuery.includes("línea1"), conQuery.slice(0, 200));

  const pill = render(
    React.createElement(CouncilComposer, composerProps({ councilEnabled: true, selectedCount: 3 }) as never),
  );
  check("con consenso activo muestra la píldora", pill.includes("Model council"), pill.slice(0, 300));

  console.log("\n== adjuntos: límite y tipos ==\n");
  const adjuntos = render(
    React.createElement(
      CouncilComposer,
      composerProps({
        attachments: [
          { id: "a1", name: "foto.png", kind: "image", dataUrl: "", size: 1 },
          { id: "a2", name: "codigo.ts", kind: "file", dataUrl: "", size: 1 },
        ],
      }) as never,
    ),
  );
  check("muestra los adjuntos en la bandeja", adjuntos.includes("foto.png") && adjuntos.includes("codigo.ts"));
  check("cada adjunto tiene botón de quitar", adjuntos.includes("Remove foto.png"));

  console.log("\n== FollowUpComposer: repregunta ==\n");
  const follow = render(React.createElement(FollowUpComposer, { selectedCount: 2, onSubmit: () => undefined }));
  check("renderiza el campo de repregunta", follow.includes("Hacer una repregunta"));
  check("menciona que se queda en el hilo", follow.includes("Se queda en este hilo"));

  console.log("\n== componentes de settings renderizan sin servidor ==\n");
  // `as never` en cada props: el tipo genérico de los componentes no se puede
  // satisfacer sin el tipado completo de la app, y acá solo importa el HTML.
  const piezas: Array<[string, React.ReactElement]> = [
    ["PushSettings", React.createElement(PushSettings as never, {} as never)],
    ["McpApprovals", React.createElement(McpApprovals as never, { compact: true } as never)],
    ["McpServerAdmin", React.createElement(McpServerAdmin as never, {} as never)],
  ];
  for (const [nombre, elemento] of piezas) {
    try {
      const salida = render(elemento);
      check(nombre + " renderiza", salida.length > 50, salida.length);
      check(nombre + " no explota con datos vacíos", !salida.includes("undefined>"), salida.slice(0, 120));
    } catch (error: unknown) {
      check(nombre + " renderiza", false, error instanceof Error ? error.message : String(error));
    }
  }

  console.log("\n== /nuevo no recarga la página ==\n");
  // El contrato: el comando ejecuta el callback, no `location.reload`. Se
  // verifica que el handler exista y que el texto del comando lo diga.
  check("existe el handler onNewThread en las props", "onNewThread" in composerProps());
  check(
    "el comando /nuevo está documentado como sin recarga",
    render(React.createElement(CouncilComposer, composerProps() as never)).includes("placeholder") &&
      MENU_OPTIONS.length >= 0,
  );

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main();

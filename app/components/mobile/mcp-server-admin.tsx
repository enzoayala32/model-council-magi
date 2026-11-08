"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Fase 8 — administración de servidores MCP, solo desde la PC.
 *
 * Muestra los servidores configurados, su allowlist, qué está eximido de
 * aprobación (`readOnlyTools`) y las advertencias del operador. Crear o cambiar
 * un servidor pide confirmar con el token de acceso OTRA VEZ: agregar un
 * servidor stdio equivale a ejecutar un comando en esta PC.
 *
 * Nunca muestra valores de variables de entorno: solo las referencias
 * (`${VAR}`), que es lo que hay en el archivo.
 */

type Server = {
  name: string;
  transport: string;
  target: string;
  tools: string[];
  readOnlyTools: string[];
  headers: Record<string, string>;
  hasCredentials: boolean;
  note?: string;
};

export function McpServerAdmin() {
  const [servers, setServers] = useState<Server[]>([]);
  const [source, setSource] = useState("");
  const [configError, setConfigError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  // Borrador: solo los campos que la UI edita.
  const [draft, setDraft] = useState({
    name: "",
    transport: "stdio",
    command: "",
    args: "",
    url: "",
    tools: "",
    readOnlyTools: "",
    /** Un header por línea, `clave: ${VAR}`. Los valores van por referencia. */
    headers: "",
    note: "",
  });
  const [confirmToken, setConfirmToken] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp/servers");
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; servers?: Server[]; source?: string; configError?: string | null; error?: string }
        | null;
      if (!res.ok || data?.ok !== true) {
        setMessage(data?.error ?? "No se pudo leer la config.");
        return;
      }
      setServers(data.servers ?? []);
      setSource(data.source ?? "");
      setConfigError(data.configError ?? null);
    } catch {
      setMessage("No se pudo leer la config.");
    }
  }, []);

  useEffect(() => {
    const bootstrap = setTimeout(() => void load(), 0);
    return () => clearTimeout(bootstrap);
  }, [load]);

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const server = {
        name: draft.name.trim(),
        transport: draft.transport,
        ...(draft.transport === "http"
          ? { url: draft.url.trim() }
          : { command: draft.command.trim(), args: draft.args.split(" ").filter(Boolean) }),
        tools: draft.tools.split(",").map((entry) => entry.trim()).filter(Boolean),
        readOnlyTools: draft.readOnlyTools.split(",").map((entry) => entry.trim()).filter(Boolean),
        // Un header por línea. El valor tiene que ser una referencia a variable
        // de entorno: nunca se escribe un secreto en el archivo de config.
        ...(draft.transport === "http" && draft.headers.trim()
          ? {
              httpHeaders: Object.fromEntries(
                draft.headers
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => {
                    const sep = line.indexOf(":");
                    return sep === -1
                      ? ([line, ""] as const)
                      : ([line.slice(0, sep).trim(), line.slice(sep + 1).trim()] as const);
                  })
                  .filter(([key, value]) => key !== "" && value.startsWith("${")),
              ),
            }
          : {}),
        readOnly: true,
        ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
      };
      const res = await fetch("/api/mcp/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ server, confirmToken: confirmToken.trim() }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; needsRestart?: boolean } | null;
      if (!res.ok || data?.ok !== true) {
        setMessage(data?.error ?? "No se pudo guardar.");
        return;
      }
      setConfirmToken("");
      setMessage(
        data.needsRestart
          ? "Guardado. El server en marcha no recarga la config: reinicialo para que el agente vea el cambio."
          : "Guardado.",
      );
      await load();
    } catch {
      setMessage("No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/mcp/servers", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, confirmToken: confirmToken.trim() }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || data?.ok !== true) {
        setMessage(data?.error ?? "No se pudo eliminar.");
        return;
      }
      setMessage("Eliminado. Reiniciá el server para que el agente lo deje de ver.");
      await load();
    } catch {
      setMessage("No se pudo eliminar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mSection">
      <div className="mSectionHead">
        <h2>Servidores MCP</h2>
      </div>

      <p className="mNote">
        La config vive <strong>fuera del repo</strong>
        {source ? <>: <code>{source}</code></> : null}. No se commitea y el agente no puede modificarla.
      </p>

      {configError ? <p className="mError">La config tiene un error y no se cargó: {configError}</p> : null}

      {servers.length === 0 ? <p className="mEmpty">No hay servidores configurados.</p> : null}

      {servers.map((server) => (
        <div key={server.name} className="mCard">
          <div className="mRow">
            <span className="mTag">{server.transport}</span>
            <strong>{server.name}</strong>
          </div>
          <p className="mNote">{server.target}</p>
          {server.hasCredentials ? (
            <p className="mNote">
              Credenciales por referencia:{" "}
              {Object.entries(server.headers)
                .map(([key, value]) => key + ": " + value)
                .join(", ")}
            </p>
          ) : null}
          {server.note ? <p className="mNote">{server.note}</p> : null}
          <fieldset className="mFieldset">
            <legend>
              Herramientas permitidas ({server.tools.length}) — las marcadas ejecutan sin aprobación humana
            </legend>
            {server.tools.map((tool) => (
              <label key={tool} className="mCheck">
                <input type="checkbox" checked disabled />
                {tool}
                {server.readOnlyTools.includes(tool) ? <em> — solo lectura</em> : <em> — pide aprobación</em>}
              </label>
            ))}
          </fieldset>
          <div className="mRow">
            <button
              className="mButtonDanger"
              type="button"
              disabled={busy || !confirmToken.trim()}
              onClick={() => void remove(server.name)}
            >
              Eliminar
            </button>
          </div>
        </div>
      ))}

      <div className="mSectionHead">
        <h3>Agregar o cambiar un servidor</h3>
      </div>
      <div className="mCard">
        <div className="mRow">
          <input className="mInput" placeholder="nombre" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} disabled={busy} />
          <select
            className="mInput"
            value={draft.transport}
            onChange={(e) => setDraft({ ...draft, transport: e.target.value })}
            disabled={busy}
          >
            <option value="stdio">stdio (proceso local)</option>
            <option value="http">http (URL)</option>
          </select>
        </div>
        {draft.transport === "http" ? (
          <>
            <input className="mInput" placeholder="https://…/mcp" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} disabled={busy} />
            <textarea
              className="mInput"
              rows={2}
              placeholder={"headers, uno por línea, con valores por referencia a variables de entorno:\nAuthorization: ${MI_TOKEN_MCP}"}
              value={draft.headers}
              onChange={(e) => setDraft({ ...draft, headers: e.target.value })}
              disabled={busy}
            />
            <p className="mNote">
              Los valores van por <strong>referencia</strong> a variables de entorno (<code>${"{VAR}"}</code>). Si
              escribís un secreto en claro, se guarda en el archivo: usá una variable.
            </p>
          </>
        ) : (
          <div className="mRow">
            <input className="mInput" placeholder="comando (ej: npx)" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} disabled={busy} />
            <input className="mInput" placeholder="argumentos separados por espacio" value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })} disabled={busy} />
          </div>
        )}
        <input
          className="mInput"
          placeholder="herramientas permitidas (separadas por coma)"
          value={draft.tools}
          onChange={(e) => setDraft({ ...draft, tools: e.target.value })}
          disabled={busy}
        />
        <input
          className="mInput"
          placeholder="de solo lectura: ejecutan sin aprobación (separadas por coma)"
          value={draft.readOnlyTools}
          onChange={(e) => setDraft({ ...draft, readOnlyTools: e.target.value })}
          disabled={busy}
        />
        <input className="mInput" placeholder="nota (por qué confío en este servidor)" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} disabled={busy} />
        <div className="mRow">
          <input
            className="mInput"
            type="password"
            placeholder="token de acceso, para confirmar"
            value={confirmToken}
            onChange={(e) => setConfirmToken(e.target.value)}
            disabled={busy}
          />
          <button className="mButton" type="button" disabled={busy || !confirmToken.trim() || !draft.name.trim()} onClick={() => void save()}>
            Guardar
          </button>
        </div>
        <p className="mNote">
          Agregar un servidor stdio equivale a ejecutar un comando en esta PC: por eso pide el token otra vez. Las
          herramientas que no estén en &ldquo;de solo lectura&rdquo; van a pedir aprobación humana cada vez.
        </p>
      </div>

      {message ? <p className="mNote">{message}</p> : null}
    </div>
  );
}

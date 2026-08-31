import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Lista subcarpetas de un directorio del filesystem donde corre el server
 * — pensado para el selector de "Ruta local" al crear un `Project` (en vez
 * de tener que tipear la ruta a mano). No es un problema de seguridad
 * nuevo: esta app ya es de un solo usuario, self-hosted, y el Coding Agent
 * ya puede leer/escribir cualquier ruta que el usuario le indique como
 * `localPath` — este endpoint no habilita nada que el usuario no pudiera
 * hacer ya escribiendo la ruta directamente. No listamos nada fuera de
 * carpetas (ni archivos, ni tampoco carpetas ocultas/dotfiles, para no
 * ensuciar la navegación con `.git`, `node_modules` no se filtra a
 * propósito — puede ser justo la carpeta que alguien quiere elegir).
 *
 * Sin `?path=`, arranca en la carpeta del usuario (`os.homedir()`) — así
 * lo pidió el usuario, en vez de mostrar primero las unidades de disco.
 * Las unidades (Windows) solo aparecen como atajo cuando la navegación
 * llega a la raíz de una unidad y no hay ".." al que subir.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = url.searchParams.get("path");
  const targetPath = requested && requested.trim() ? requested : os.homedir();

  const resolved = path.resolve(targetPath);

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(resolved, { withFileTypes: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: `No se pudo abrir "${resolved}": ${error instanceof Error ? error.message : String(error)}` },
      { status: 400 },
    );
  }

  const entries = dirents
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));

  const parentPath = path.dirname(resolved);
  // En la raíz de una unidad (ej. "C:\\" en Windows, o "/" en POSIX),
  // dirname devuelve la misma ruta — ahí no hay ".." real al que subir.
  const parent = parentPath !== resolved ? parentPath : null;

  const drives = parent === null ? await listWindowsDrives() : [];

  return NextResponse.json({ ok: true, path: resolved, parent, entries, drives });
}

async function listWindowsDrives(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const results = await Promise.all(
    letters.map(async (letter) => {
      const drivePath = `${letter}:\\`;
      try {
        await fs.stat(drivePath);
        return drivePath;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((drive): drive is string => drive !== null);
}

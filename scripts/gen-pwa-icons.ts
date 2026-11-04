/**
 * Fase 3.2 — generar los iconos de la PWA.
 *
 * El manifest de una PWA instalable necesita PNG (Android no acepta SVG
 * en `<icon>` para la pantalla de inicio). En vez de commitear binarios
 * generados a mano, se derivan de `app/icon.svg` — la misma fuente que
 * ya usa el favicon — con `sharp`, que el repo ya trae como dependencia
 * de producción.
 *
 * Los PNG se commitean: el manifest tiene que servirlos sin build steps
 * raros, y regenerarlos es idempotente.
 *
 * Uso: npm run gen:pwa-icons
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.join(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "app", "icon.svg");
const OUT_DIR = path.join(ROOT, "public", "icons");

/** 192 y 512 son los tamaños que Android pide como mínimo; 512 es el que
 *  se usa para la splash screen. `maskable` lleva padding extra para que
 *  el sistema pueda recortarlo a la forma de ícono del launcher. */
const SIZES = [
  { size: 192, name: "icon-192.png" },
  { size: 512, name: "icon-512.png" },
] as const;

const MASKABLE_SIZES = [
  { size: 192, name: "icon-maskable-192.png" },
  { size: 512, name: "icon-maskable-512.png" },
] as const;

async function main(): Promise<void> {
  if (!fs.existsSync(SOURCE)) {
    console.error(`No encuentro ${SOURCE}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const { size, name } of SIZES) {
    await sharp(SOURCE, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(OUT_DIR, name));
    console.log(`✅ ${name}`);
  }

  // Maskable: el contenido se reduce al 80% central sobre el mismo fondo,
  // así el recorte circular/redondeado del launcher no corta el glifo.
  for (const { size, name } of MASKABLE_SIZES) {
    const inner = Math.round(size * 0.8);
    const glyph = await sharp(SOURCE, { density: 384 }).resize(inner, inner, { fit: "contain" }).png().toBuffer();
    await sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: { r: 23, g: 23, b: 23, alpha: 1 },
      },
    })
      .composite([{ input: glyph, top: Math.round((size - inner) / 2), left: Math.round((size - inner) / 2) }])
      .png()
      .toFile(path.join(OUT_DIR, name));
    console.log(`✅ ${name} (maskable)`);
  }

  console.log(`\nIconos en ${OUT_DIR}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

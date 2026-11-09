import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Los `any` explícitos viven casi todos en harness de tests que castean
      // el ToolSet para llamar `.execute()`. Se auditan en la Fase 3; acá se
      // dejan como warning para que el lint mida sin bloquear la Fase 2.
      "@typescript-eslint/no-explicit-any": "warn",
      // Regla nueva de eslint-plugin-react-hooks 7 (incluida por Next 16).
      // Marca inicializaciones legítimas desde localStorage/SSE. No se cambia
      // comportamiento en Fase 2; la Fase 5 refactoriza page.tsx y hooks.
      "react-hooks/set-state-in-effect": "warn",
      // Convención del repo: `_nombre` en una desestructuración es "lo descarto
      // a propósito" (quitar un campo de un objeto, ignorar un parámetro que
      // exige la firma). Sin este ignore, cada uno de esos casos contaba como
      // warning y el tope medía ruido en lugar de deuda real.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  globalIgnores([
    // Preloads de test: JS plano a propósito, cargado con --require antes de
    // cualquier test. No se les exige el estilo de TS.
    "lib/test/fixtures/*.js",
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "node_modules/**",
    "data/**",
    "salidas/**",
    "docs/**",
    "public/**",
    "next-env.d.ts",
    "tsconfig.tsbuildinfo",
  ]),
]);

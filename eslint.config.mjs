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
    },
  },
  globalIgnores([
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

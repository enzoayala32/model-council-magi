/**
 * Prueba de aceptación de la Fase 7B (parte pura): `analyzeSourceText` —
 * imports, exports, símbolos, ScriptKinds, errores de parseo, topes y
 * determinismo. Trabaja solo con strings: sin disco, sin Git, sin modelo.
 *
 * Incluye el test CANARIO de `parseDiagnostics`: es API interna de
 * TypeScript (no está en el `.d.ts` público); si un upgrade la quita, el
 * análisis dejaría de detectar errores de sintaxis EN SILENCIO — este test
 * lo hace fallar a propósito.
 *
 * Uso: npm run agent:test-repo-symbols
 */
import ts from "typescript";
import {
  analyzeSourceText,
  failedAnalysis,
  isParseableLanguage,
  MAX_EXPORTS_PER_FILE,
  MAX_IMPORTS_PER_FILE,
  MAX_MEMBERS_PER_CLASS,
  MAX_SYMBOLS_PER_FILE,
  type FileAnalysis,
  type ParseableLanguage,
} from "./repo-symbols";

function canon(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}
function eq(a: unknown, b: unknown): boolean {
  return canon(a) === canon(b);
}

const results: boolean[] = [];
function check(ok: boolean, message: string, failDetail: () => string) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}\n   Falló. ${failDetail()}`);
  results.push(ok);
}
/** check de igualdad estructural con detalle automático. */
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(eq(actual, expected), message, () => `esperado=${canon(expected)}\n   actual  =${canon(actual)}`);
}

function A(text: string, language: ParseableLanguage = "typescript", file?: string): FileAnalysis {
  const ext = { typescript: "ts", tsx: "tsx", javascript: "js", jsx: "jsx" }[language];
  return analyzeSourceText(file ?? `x.${ext}`, language, text);
}
const imp = (text: string, language?: ParseableLanguage) => A(text, language).imports;
const exp = (text: string, language?: ParseableLanguage) => A(text, language).exports;
const sym = (text: string, language?: ParseableLanguage) => A(text, language).symbols;
const N = (name: string, isTypeOnly = false, alias?: string) => (alias ? { name, alias, isTypeOnly } : { name, isTypeOnly });

function main() {
  console.log("== Fase 7B — prueba de aceptación (parser puro: símbolos, imports, exports) ==\n");

  // ---------------- Imports ----------------
  console.log("--- Imports ---");
  checkEq(imp(`import { foo } from "./foo";`), [{ source: "./foo", kind: "static", isTypeOnly: false, named: [N("foo")], line: 1 }], "named import");
  checkEq(imp(`import Foo from "./foo";`), [{ source: "./foo", kind: "static", isTypeOnly: false, default: "Foo", named: [], line: 1 }], "default import");
  checkEq(imp(`import * as Foo from "./foo";`), [{ source: "./foo", kind: "static", isTypeOnly: false, namespace: "Foo", named: [], line: 1 }], "namespace import");
  checkEq(imp(`import "./side-effect";`), [{ source: "./side-effect", kind: "side-effect", isTypeOnly: false, named: [], line: 1 }], "side-effect import");
  checkEq(imp(`import type { Foo } from "./foo";`), [{ source: "./foo", kind: "static", isTypeOnly: true, named: [N("Foo")], line: 1 }], "import type (a nivel de declaración)");
  checkEq(imp(`import { type Foo, bar } from "./foo";`), [{ source: "./foo", kind: "static", isTypeOnly: false, named: [N("Foo", true), N("bar")], line: 1 }], "type por elemento ({ type Foo, bar })");
  checkEq(
    imp(`import Foo, { bar } from "./foo";\nimport Baz, * as NS from "./baz";`),
    [
      { source: "./foo", kind: "static", isTypeOnly: false, default: "Foo", named: [N("bar")], line: 1 },
      { source: "./baz", kind: "static", isTypeOnly: false, default: "Baz", namespace: "NS", named: [], line: 2 },
    ],
    "combinaciones: default + named, default + namespace",
  );
  checkEq(imp(`import { a as b, default as c } from "m";`)[0].named, [N("a", false, "b"), N("default", false, "c")], "aliases ({ a as b })");
  checkEq(
    imp(`import a from "./a";\n\nimport b from "../b";\nimport c from "@/lib/c";\nimport d from "react";\nimport e from "node:fs";`).map((i) => [i.source, i.line]),
    [["./a", 1], ["../b", 3], ["@/lib/c", 4], ["react", 5], ["node:fs", 6]],
    "múltiples imports: specifiers CRUDOS (sin normalizar ni resolver), en orden, con su línea",
  );
  checkEq(
    imp(`import foo = require("./foo");\nimport type bar = require("bar");`),
    [
      { source: "./foo", kind: "import-equals", isTypeOnly: false, namespace: "foo", named: [], line: 1 },
      { source: "bar", kind: "import-equals", isTypeOnly: true, namespace: "bar", named: [], line: 2 },
    ],
    "import equals (require)",
  );
  checkEq(
    imp("const m = await import(\"./foo\");\nconst t = await import(`./tpl`);"),
    [
      { source: "./foo", kind: "dynamic", isTypeOnly: false, named: [], line: 1 },
      { source: "./tpl", kind: "dynamic", isTypeOnly: false, named: [], line: 2 },
    ],
    "import() dinámico con literal (string y template sin sustituciones)",
  );
  checkEq(imp(`const a = require("./foo");`, "javascript"), [{ source: "./foo", kind: "require", isTypeOnly: false, named: [], line: 1 }], "require() con literal");
  {
    const r = A("const a = import(x);\nconst b = require(y);\nconst c = import(`a${b}`);\nconst d = require(\"ok\");");
    check(r.dynamicNonLiteral === 3 && r.imports.length === 1 && r.imports[0].source === "ok", "import()/require() NO literales: se cuentan en dynamicNonLiteral y no generan entrada", () => canon(r));
  }
  checkEq(imp(`const a = require("./a");\nimport b from "./b";\nfunction f() { return import("./c"); }`).map((i) => i.source), ["./a", "./b", "./c"], "los imports (estáticos y dinámicos) salen en orden de aparición en el fuente");
  checkEq(imp(`const x = require.resolve("./nope"); const y = foo.require("./nope"); const z = module.require("./nope");`), [], "require.resolve / obj.require / module.require NO son require()");
  check(A("export {};\n").dynamicNonLiteral === undefined && A("export {};\n").truncated === undefined, "sin dinámicos no literales ni topes: los campos opcionales se omiten", () => canon(A("export {};\n")));

  // ---------------- Exports ----------------
  console.log("\n--- Exports ---");
  checkEq(
    exp(`export function f() {}\nexport class C {}\nexport const c = 1;\nexport let l = 1;\nexport var v = 1;\nexport interface I {}\nexport type T = string;\nexport enum E { A }\nexport namespace NS {}`).map((e) => [e.name, e.kind, e.line]),
    [["f", "function", 1], ["C", "class", 2], ["c", "const", 3], ["l", "let", 4], ["v", "var", 5], ["I", "interface", 6], ["T", "type", 7], ["E", "enum", 8], ["NS", "namespace", 9]],
    "exports de declaración: function, class, const, let, var, interface, type, enum, namespace",
  );
  checkEq(exp(`export const f = () => 1;\nexport const g = function () {};`).map((e) => [e.name, e.kind]), [["f", "function"], ["g", "function"]], "export const con arrow / function expression → kind function");
  checkEq(
    exp(`export abstract class AC {}\nexport const enum CE { A }\nexport declare function dd(): void;\nexport declare namespace DN {}`).map((e) => [e.name, e.kind]),
    [["AC", "class"], ["CE", "enum"], ["dd", "function"], ["DN", "namespace"]],
    "abstract class, const enum, declare function, declare namespace",
  );
  checkEq(
    exp(`export default function foo() {}`),
    [{ name: "default", kind: "function", isTypeOnly: false, localName: "foo", line: 1 }],
    "export default function con nombre",
  );
  checkEq(exp(`export default class Foo {}`), [{ name: "default", kind: "class", isTypeOnly: false, localName: "Foo", line: 1 }], "export default class con nombre");
  checkEq(
    [exp(`export default function () {}`)[0], exp(`export default class {}`)[0], exp(`export default () => 1;`)[0], exp(`export default 1 + 1;`)[0]].map((e) => [e.name, e.kind, e.localName ?? null]),
    [["default", "function", null], ["default", "class", null], ["default", "function", null], ["default", "expression", null]],
    "export default anónimo: función, clase, arrow y expresión",
  );
  checkEq(exp(`function Foo() {}\nexport default Foo;`)[0], { name: "default", kind: "function", isTypeOnly: false, localName: "Foo", line: 2 }, "export default Foo (símbolo local → toma su kind)");
  checkEq(exp(`import Foo from "./foo";\nexport default Foo;`)[0], { name: "default", kind: "reexport", isTypeOnly: false, localName: "Foo", line: 2 }, "export default de un binding IMPORTADO → kind reexport (7C lo enlaza con imports)");
  checkEq(
    exp(`const foo = 1;\nconst baz = 2;\nexport { foo };\nexport { baz as bar };`),
    [
      { name: "foo", kind: "const", isTypeOnly: false, localName: "foo", line: 3 },
      { name: "bar", kind: "const", isTypeOnly: false, localName: "baz", line: 4 },
    ],
    "export { foo } y export { baz as bar } (kind tomado del símbolo local)",
  );
  checkEq(exp(`import { x } from "./x";\nexport { x };`)[0], { name: "x", kind: "reexport", isTypeOnly: false, localName: "x", line: 2 }, "export { x } de un binding importado → reexport sin source");
  checkEq(
    exp(`export const { GET, POST: P2, ...rest } = handlers;\nexport const [a1, [b1]] = arr;`).map((e) => e.name),
    ["GET", "P2", "rest", "a1", "b1"],
    "destructuring de objeto y arreglo (nombres aplanados, incluido rest y anidados)",
  );
  checkEq(exp(`export = Foo;`)[0], { name: "export=", kind: "export-equals", isTypeOnly: false, localName: "Foo", line: 1 }, "export =");
  checkEq(
    exp(`export { foo } from "./foo";\nexport { foo as bar } from "./foo";\nexport { default } from "./foo";\nexport { default as Foo } from "./foo";`),
    [
      { name: "foo", kind: "reexport", isTypeOnly: false, source: "./foo", importedName: "foo", line: 1 },
      { name: "bar", kind: "reexport", isTypeOnly: false, source: "./foo", importedName: "foo", line: 2 },
      { name: "default", kind: "reexport", isTypeOnly: false, source: "./foo", importedName: "default", line: 3 },
      { name: "Foo", kind: "reexport", isTypeOnly: false, source: "./foo", importedName: "default", line: 4 },
    ],
    "re-exports con source: named, alias, default, default as X (con importedName para 7C)",
  );
  checkEq(
    exp(`export * from "./a";\nexport * as ns from "./b";\nexport type * from "./c";\nexport type * as T from "./d";`),
    [
      { name: "*", kind: "star", isTypeOnly: false, source: "./a", line: 1 },
      { name: "ns", kind: "namespace-reexport", isTypeOnly: false, source: "./b", importedName: "*", line: 2 },
      { name: "*", kind: "star", isTypeOnly: true, source: "./c", line: 3 },
      { name: "T", kind: "namespace-reexport", isTypeOnly: true, source: "./d", importedName: "*", line: 4 },
    ],
    "export *, export * as ns, export type *, export type * as T",
  );
  checkEq(
    exp(`export type { T } from "./t";\nexport { type U, v } from "./u";\nexport type { W };`).map((e) => [e.name, e.isTypeOnly]),
    [["T", true], ["U", true], ["v", false], ["W", true]],
    "isTypeOnly solo por sintaxis explícita (export type {…} y { type X })",
  );
  checkEq(exp(`export { x as "a b" } from "./e";`)[0].name, "a b", "nombre de export como string literal ('export { x as \"a b\" }')");
  checkEq(exp(`export const x = 1;\nexport {};\nexport { };`).map((e) => e.name), ["x"], "export {} vacío no produce entradas");

  // ---------------- Símbolos ----------------
  console.log("\n--- Símbolos ---");
  checkEq(
    sym(`function f() {}\nclass C {}\ninterface I {}\ntype T = 1;\nconst c = 1;\nlet l = 1;\nvar v = 1;\nenum E { A }\nnamespace NS {}`).map((s) => [s.name, s.kind, s.line, s.exported]),
    [["f", "function", 1, false], ["C", "class", 2, false], ["I", "interface", 3, false], ["T", "type", 4, false], ["c", "const", 5, false], ["l", "let", 6, false], ["v", "var", 7, false], ["E", "enum", 8, false], ["NS", "namespace", 9, false]],
    "símbolos: function, class, interface, type, const, let, var, enum, namespace (no exportados)",
  );
  checkEq(
    sym(`const a = () => {};\nconst b = function () {};\nlet c = async () => 1;\nconst d = (() => 1) as unknown;\nconst e = 5;\nconst f = class {};`).map((s) => [s.name, s.kind]),
    [["a", "function"], ["b", "function"], ["c", "function"], ["d", "function"], ["e", "const"], ["f", "const"]],
    "arrow / function expression asignadas a const|let → kind function; el resto conserva su kind",
  );
  checkEq(
    sym(`const foo = 1;\nfunction bar() {}\nclass Baz {}\nconst hidden = 2;\nexport { foo, bar as renamed };\nexport default Baz;`).map((s) => [s.name, s.exported]),
    [["foo", true], ["bar", true], ["Baz", true], ["hidden", false]],
    "exported también por `export { a }`, `export { a as b }` y `export default a`",
  );
  checkEq(sym(`export function f() {}\nexport class C {}\nexport const c = 1;\nexport default function () {}`).map((s) => [s.name, s.exported]), [["f", true], ["C", true], ["c", true], ["default", true]], "exported por modificador export (y default anónimo se llama 'default')");
  checkEq(
    sym(`function foo(x: string): string;\nfunction foo(x: number): number;\nfunction foo(x: string | number) { return x; }\ndeclare function solo(): void;`),
    [
      { name: "foo", kind: "function", line: 1, exported: false, overloads: 2 },
      { name: "solo", kind: "function", line: 4, exported: false },
    ],
    "overloads: una sola entrada con overloads=N (solo si hay ≥2 firmas); una firma suelta no es overload",
  );
  {
    const r = A(`export function foo(x: string): string;\nexport function foo(x: number): number;\nexport function foo(x: any) { return x; }`);
    check(r.symbols.length === 1 && r.symbols[0].overloads === 2 && r.exports.length === 1 && r.exports[0].name === "foo", "overloads exportados: un símbolo y UN export", () => canon(r));
  }
  {
    const r = A(`export class K {
  static s() {}
  private p() {}
  protected q() {}
  get g() { return 1; }
  set g(v: number) {}
  h = () => 1;
  plain = 5;
  #hidden() {}
  ['computed']() {}
  'lit'() {}
  m(a: string): void;
  m(a: number): void;
  m(a: any) {}
  constructor() {}
}`);
    checkEq(
      r.symbols[0].members,
      [
        { name: "s", kind: "method", line: 2, isStatic: true },
        { name: "p", kind: "method", line: 3, visibility: "private" },
        { name: "q", kind: "method", line: 4, visibility: "protected" },
        { name: "g", kind: "get", line: 5 },
        { name: "g", kind: "set", line: 6 },
        { name: "h", kind: "method", line: 7 },
        { name: "lit", kind: "method", line: 11 },
        { name: "m", kind: "method", line: 12 },
        { name: "constructor", kind: "constructor", line: 15 },
      ],
      "miembros de clase: methods, get/set, static, private/protected, propiedad con función, constructor; sin propiedades planas, #privados ni computados; overloads de método deduplicados",
    );
  }
  checkEq(sym(`interface I { a: string; m(): void }\nenum E { A, B }\nnamespace NS { export const x = 1; }`).map((s) => [s.name, "members" in s]), [["I", false], ["E", false], ["NS", false]], "interfaces, enums y namespaces NO registran miembros ni contenido interno");
  checkEq(sym(`namespace A.B { export const x = 1; }\ndeclare module "ambient" { export const y: number; }\ndeclare global { interface Window { z: 1 } }`).map((s) => [s.name, s.kind]), [["A", "namespace"]], "namespace A.B → 'A'; declare module \"x\" y declare global quedan fuera");
  checkEq(sym(`function outer() {\n  function inner() {}\n  const local = 1;\n}\nconst top = 1;`).map((s) => s.name), ["outer", "top"], "solo símbolos de nivel superior (nada dentro de cuerpos)");
  {
    const r = A(`@Injectable()\n@Other()\nexport class Svc {\n  @Input()\n  @Other()\n  method() {}\n}`);
    check(r.parse.status === "ok" && r.symbols[0].line === 3 && r.symbols[0].members?.[0].line === 6 && r.exports[0].line === 3, "decorators sin diagnostics; la línea del símbolo y del miembro es la del NOMBRE, no la del decorator", () => canon(r));
  }
  checkEq(
    exp(`export const a = 1;\nexport {\n  b,\n  c as d,\n};\nconst b = 1, c = 2;`).map((e) => [e.name, e.line]),
    [["a", 1], ["b", 3], ["d", 4]],
    "líneas: cada specifier de `export { … }` multilínea lleva su propia línea",
  );
  checkEq(imp(`import {\n  a,\n  b,\n} from "./x";`)[0].line, 1, "línea de un import multilínea = la del inicio de la declaración");

  // ---------------- ScriptKinds ----------------
  console.log("\n--- ScriptKinds (JS vs TS) ---");
  const JSX = `export default function A() { return <div>{1}</div>; }\n`;
  check(A(`export const a: number = 1;`, "typescript").parse.status === "ok", ".ts válido → ok", () => canon(A(`export const a: number = 1;`)));
  check(A(JSX, "tsx").parse.status === "ok", ".tsx con JSX → ok", () => canon(A(JSX, "tsx")));
  check(A(JSX, "jsx").parse.status === "ok", ".jsx con JSX → ok", () => canon(A(JSX, "jsx")));
  check(A(JSX, "javascript").parse.status === "ok", "JSX dentro de .js → ok (el parser de JS acepta JSX)", () => canon(A(JSX, "javascript")));
  {
    const r = A(JSX, "typescript");
    check(r.parse.status === "diagnostics", "JSX inválido en .ts → diagnostics", () => canon(r));
  }
  check(A(`const f = <T,>(x: T) => x;\nexport { f };`, "tsx").parse.status === "ok", "genérico <T,> en .tsx → ok", () => canon(A(`const f = <T,>(x: T) => x;`, "tsx")));
  check(A(`export function f(x: number): string { return ""; }\ninterface X {}`, "javascript").parse.status === "ok", "anotaciones TS en .js NO dan diagnostics (límite documentado: 'ok' = sin errores de gramática)", () => canon(A(`export function f(x: number) {}`, "javascript")));
  check(A(`export const a = 1;`, "javascript", "lib/x.mjs").exports[0].name === "a" && A(`export const a: number = 1;`, "typescript", "lib/x.mts").parse.status === "ok", ".mjs (javascript) y .mts (typescript) se analizan según el language de 7A, no el nombre", () => "mjs/mts falló");
  check(A(`export const a: number = 1;`, "typescript", "weird.name.js").parse.status === "ok", "el ScriptKind sale del language, NO de la extensión del nombre (TS con nombre .js)", () => canon(A(`export const a: number = 1;`, "typescript", "weird.name.js")));

  // ---------------- Errores de parseo y bordes ----------------
  console.log("\n--- Errores y casos borde ---");
  {
    const r = A(`import a from "./a";\nexport function ( {\n  const = ;\n`);
    const items = r.parse.status === "diagnostics" ? r.parse.items : [];
    check(
      r.parse.status === "diagnostics" && r.parse.count >= 3 && items.length <= 5 && items.every((i) => i.message.length <= 200 && i.line >= 1 && !/[\\/]/.test(i.message)) && r.imports.length === 1,
      "sintaxis inválida → status diagnostics (con líneas y mensajes cortos, sin rutas) y la extracción recuperable sigue (el import válido se captura)",
      () => canon(r),
    );
  }
  {
    const r = A("const = ;\n".repeat(30));
    check(r.parse.status === "diagnostics" && r.parse.count > 5 && r.parse.items.length === 5, "más de 5 diagnostics → count total pero solo 5 items", () => canon(r.parse));
  }
  {
    const r = A("");
    checkEq([r.parse, r.imports, r.exports, r.symbols], [{ status: "ok" }, [], [], []], "archivo vacío → ok y listas vacías");
    const c = A("// solo un comentario\n/* y otro */\n");
    checkEq([c.parse, c.imports.length, c.exports.length, c.symbols.length], [{ status: "ok" }, 0, 0, 0], "solo comentarios → ok y listas vacías");
  }
  {
    const bom = A("\uFEFFimport a from './a';\r\nexport const b = 1;\r\n");
    check(bom.parse.status === "ok" && bom.imports[0].source === "./a" && bom.exports[0].line === 2, "BOM + CRLF: se parsea y las líneas son correctas", () => canon(bom));
    const sb = A("#!/usr/bin/env node\nconst x = require('y');\nexport const z = 1;\n", "javascript");
    check(sb.parse.status === "ok" && sb.imports[0]?.source === "y" && sb.exports[0].line === 3, "shebang (#!) se tolera", () => canon(sb));
  }
  {
    const text = `import a from "./a";\nexport const x = 1;\nclass K { m() {} }\nexport default K;\nconst l = import("./l");\n`;
    check(canon(A(text)) === canon(A(text)) && JSON.stringify(A(text)) === JSON.stringify(A(text)), "determinismo: dos corridas sobre el mismo texto → JSON idéntico (incluso el orden de claves)", () => "difieren");
  }
  check(A(`export const a = 1;`).next === undefined, "el parser puro nunca asigna `next` (Next.js vive en next-roles.ts)", () => "next presente");

  // ---------------- Topes ----------------
  console.log("\n--- Topes por archivo ---");
  {
    const r = A(Array.from({ length: MAX_EXPORTS_PER_FILE + 100 }, (_, i) => `export const c${i} = ${i};`).join("\n"));
    check(r.exports.length === MAX_EXPORTS_PER_FILE && r.symbols.length === MAX_SYMBOLS_PER_FILE && r.truncated?.exports === true && r.truncated?.symbols === true && r.exports[MAX_EXPORTS_PER_FILE - 1].name === `c${MAX_EXPORTS_PER_FILE - 1}`, `más de ${MAX_EXPORTS_PER_FILE} exports / ${MAX_SYMBOLS_PER_FILE} símbolos → recorte determinista + truncated`, () => canon({ e: r.exports.length, s: r.symbols.length, t: r.truncated }));
  }
  {
    const r = A(Array.from({ length: MAX_IMPORTS_PER_FILE + 50 }, (_, i) => `import i${i} from "./m${i}";`).join("\n"));
    check(r.imports.length === MAX_IMPORTS_PER_FILE && r.truncated?.imports === true && r.imports[MAX_IMPORTS_PER_FILE - 1].source === `./m${MAX_IMPORTS_PER_FILE - 1}`, `más de ${MAX_IMPORTS_PER_FILE} imports → recorte + truncated.imports`, () => canon({ i: r.imports.length, t: r.truncated }));
  }
  {
    const r = A(`class Big {\n${Array.from({ length: MAX_MEMBERS_PER_CLASS + 20 }, (_, i) => `  m${i}() {}`).join("\n")}\n}`);
    check(r.symbols[0].members?.length === MAX_MEMBERS_PER_CLASS && r.truncated?.symbols === true, `más de ${MAX_MEMBERS_PER_CLASS} miembros por clase → recorte + truncated.symbols`, () => canon({ m: r.symbols[0].members?.length, t: r.truncated }));
  }
  {
    // Un AST anidado muy profundo puede reventar el stack del recorrido: tiene que ser un resultado controlado, nunca una excepción.
    let threw = false;
    let r: FileAnalysis | null = null;
    try {
      r = A(`export const x = ${"1 + ".repeat(60_000)}1;\n`);
    } catch {
      threw = true;
    }
    check(!threw && r !== null && (r.parse.status === "ok" || (r.parse.status === "failed" && r.parse.code === "parser_threw" && !/[\\/]/.test(r.parse.detail ?? ""))), "AST profundísimo → resultado controlado (ok o failed:parser_threw con solo el nombre del error), nunca excepción", () => `threw=${threw}, parse=${canon(r?.parse)}`);
  }

  // ---------------- Utilidades y canario ----------------
  console.log("\n--- Utilidades y canario ---");
  checkEq(failedAnalysis("a.ts", "typescript", "read_failed", "EIO"), { path: "a.ts", language: "typescript", parse: { status: "failed", code: "read_failed", detail: "EIO" }, imports: [], exports: [], symbols: [] }, "failedAnalysis: forma estable, listas vacías");
  checkEq(failedAnalysis("a.ts", "typescript", "not_regular_file").parse, { status: "failed", code: "not_regular_file" }, "failedAnalysis sin detail no agrega el campo");
  check(isParseableLanguage("typescript") && isParseableLanguage("tsx") && isParseableLanguage("javascript") && isParseableLanguage("jsx") && !isParseableLanguage("json") && !isParseableLanguage("other"), "isParseableLanguage: solo ts/tsx/js/jsx", () => "falló");
  {
    // CANARIO: sf.parseDiagnostics es API interna de TypeScript. Si esto falla tras un upgrade,
    // repo-symbols.ts dejó de detectar errores de sintaxis y hay que migrar a otra vía.
    const sf = ts.createSourceFile("canary.ts", "export function ( {\n const = ;\n", ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const diagnostics = (sf as unknown as { parseDiagnostics?: unknown }).parseDiagnostics;
    const valid = ts.createSourceFile("canary-ok.ts", "export const a = 1;\n", ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    check(
      Array.isArray(diagnostics) && diagnostics.length > 0 && Array.isArray((valid as unknown as { parseDiagnostics?: unknown }).parseDiagnostics) && ((valid as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length === 0) && A("export function ( {\n").parse.status === "diagnostics",
      `CANARIO: TypeScript ${ts.version} sigue exponiendo sf.parseDiagnostics (código inválido → >0, válido → 0)`,
      () => "parseDiagnostics ya no está disponible: el análisis dejaría de detectar errores de sintaxis EN SILENCIO — migrar antes de seguir",
    );
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main();

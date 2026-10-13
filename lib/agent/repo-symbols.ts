/**
 * Fase 7B — Repository Map, capa 2 (parte PURA): símbolos, imports y
 * exports de UN archivo TS/TSX/JS/JSX a partir de su texto.
 *
 * Sin filesystem, sin Git, sin workspace, sin tools, sin LLM, sin
 * `ts.Program`, sin type checker, sin `transpileModule`: solo
 * `ts.createSourceFile` (parseo sintáctico, error-tolerante) y un recorrido
 * del AST. El acceso seguro al disco vive en `repo-analysis.ts`.
 *
 * Lo que NO hace (queda para 7C/7D): resolver specifiers a archivos,
 * alias `@/*`, paquetes externos, `importedBy`, expandir `export *`,
 * cache, tool `repo_map`.
 *
 * Decisiones verificadas contra TypeScript 5.9.3 (ver diseño de 7B):
 * - `ScriptKind` explícito desde el `language` de 7A (no depende del nombre).
 * - `setParentNodes=false`: siempre se pasa el `SourceFile` a
 *   `getStart(sf)` / `getLineAndCharacterOfPosition`.
 * - `sf.parseDiagnostics` es API INTERNA (no está en el `.d.ts` público,
 *   pero existe en runtime). Se lee de forma defensiva y hay un test
 *   canario (`test-repo-symbols.ts`) que falla si un upgrade la quita.
 * - En `.js` el parser acepta anotaciones TS sin ningún diagnostic: "ok"
 *   significa solo "sin errores de gramática".
 */
import ts from "typescript";
import type { NextFileRole } from "./next-roles";

/** Topes por archivo — protegen contra archivos generados de hasta 1 MB. */
export const MAX_IMPORTS_PER_FILE = 300;
export const MAX_EXPORTS_PER_FILE = 500;
export const MAX_SYMBOLS_PER_FILE = 500;
export const MAX_MEMBERS_PER_CLASS = 100;
export const MAX_DIAGNOSTIC_ITEMS = 5;
export const MAX_DIAGNOSTIC_MESSAGE_CHARS = 200;

export type ParseableLanguage = "typescript" | "tsx" | "javascript" | "jsx";

export function isParseableLanguage(language: string): language is ParseableLanguage {
  return language === "typescript" || language === "tsx" || language === "javascript" || language === "jsx";
}

export type ParseStatus =
  | { status: "ok" }
  | { status: "diagnostics"; count: number; items: { line: number; message: string }[] }
  | {
      status: "failed";
      code: "unsafe_path" | "not_regular_file" | "read_failed" | "changed_since_inventory" | "parser_threw";
      detail?: string;
    };

export type ImportEntry = {
  /** Specifier crudo, sin normalizar ni resolver ("./foo", "../x", "@/lib/y", "react"). */
  source: string;
  kind: "static" | "side-effect" | "import-equals" | "dynamic" | "require";
  isTypeOnly: boolean;
  /** `import Foo from "x"` → "Foo". */
  default?: string;
  /** `import * as NS from "x"` → "NS"; `import x = require("y")` → "x". */
  namespace?: string;
  /** `import { a, b as c, type D }` → [{name:"a"},{name:"b",alias:"c"},{name:"D",isTypeOnly:true}]. */
  named: { name: string; alias?: string; isTypeOnly: boolean }[];
  line: number;
};

export type ExportKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "const"
  | "let"
  | "var"
  | "expression"
  | "reexport"
  | "star"
  | "namespace-reexport"
  | "export-equals";

export type ExportEntry = {
  /** Nombre público: "foo" | "default" | "*" (`export * from`) | "export=" (`export =`). */
  name: string;
  kind: ExportKind;
  /** Solo sintaxis explícita `export type {…}` / `export type *` / `{ type X }`. */
  isTypeOnly: boolean;
  /** Nombre local: `export { a as b }` → "a"; `export default Foo` → "Foo". */
  localName?: string;
  /** Specifier si es re-export (`… from "…"`). */
  source?: string;
  /** Nombre en el módulo de origen: "foo" | "default" | "*" (`export * as ns from`). */
  importedName?: string;
  line: number;
};

export type SymbolKind = "function" | "class" | "interface" | "type" | "enum" | "namespace" | "const" | "let" | "var";

export type ClassMemberInfo = {
  name: string;
  kind: "method" | "get" | "set" | "constructor";
  line: number;
  isStatic?: true;
  visibility?: "private" | "protected";
};

export type SymbolInfo = {
  name: string;
  kind: SymbolKind;
  /** Línea (1-based) donde empieza el NOMBRE del símbolo. */
  line: number;
  exported: boolean;
  /** Cantidad de firmas de overload (solo si hay 2 o más). */
  overloads?: number;
  /** Solo clases. */
  members?: ClassMemberInfo[];
};

export type FileAnalysis = {
  path: string;
  language: ParseableLanguage;
  parse: ParseStatus;
  imports: ImportEntry[];
  exports: ExportEntry[];
  symbols: SymbolInfo[];
  /** `import()` / `require()` con argumento NO literal: el grafo de 7C no los ve. */
  dynamicNonLiteral?: number;
  truncated?: { imports?: true; exports?: true; symbols?: true };
  next?: NextFileRole;
};

const SCRIPT_KIND: Record<ParseableLanguage, ts.ScriptKind> = {
  typescript: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  javascript: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
};

/** Resultado de un archivo que NO pudo analizarse (sin extracción). */
export function failedAnalysis(
  path: string,
  language: ParseableLanguage,
  code: Extract<ParseStatus, { status: "failed" }>["code"],
  detail?: string,
): FileAnalysis {
  return {
    path,
    language,
    parse: detail === undefined ? { status: "failed", code } : { status: "failed", code, detail },
    imports: [],
    exports: [],
    symbols: [],
  };
}

function lineAt(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
}

function isFunctionValue(expression: ts.Expression | undefined): boolean {
  if (!expression) return false;
  const inner = unwrapExpression(expression);
  return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner);
}

function variableKind(list: ts.VariableDeclarationList): "const" | "let" | "var" {
  if (list.flags & ts.NodeFlags.Const || list.flags & ts.NodeFlags.Using) return "const";
  if (list.flags & ts.NodeFlags.Let) return "let";
  return "var";
}

function collectBindingIdentifiers(name: ts.BindingName, out: ts.Identifier[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingIdentifiers(element.name, out);
  }
}

function memberName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined; // `#privado` y `[computado]`: fuera del contrato
}

function extractClassMembers(sf: ts.SourceFile, node: ts.ClassLikeDeclaration): { members: ClassMemberInfo[]; truncated: boolean } {
  const members: ClassMemberInfo[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const member of node.members) {
    let kind: ClassMemberInfo["kind"] | undefined;
    let name: string | undefined;
    let positionNode: ts.Node = member;
    if (ts.isConstructorDeclaration(member)) {
      kind = "constructor";
      name = "constructor";
    } else if (ts.isMethodDeclaration(member)) {
      kind = "method";
      name = memberName(member.name);
      positionNode = member.name;
    } else if (ts.isGetAccessorDeclaration(member)) {
      kind = "get";
      name = memberName(member.name);
      positionNode = member.name;
    } else if (ts.isSetAccessorDeclaration(member)) {
      kind = "set";
      name = memberName(member.name);
      positionNode = member.name;
    } else if (ts.isPropertyDeclaration(member) && isFunctionValue(member.initializer)) {
      kind = "method";
      name = memberName(member.name);
      positionNode = member.name;
    }
    if (kind === undefined || name === undefined) continue;
    const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
    // Los overloads de un método/constructor son varias declaraciones: una sola entrada.
    const key = `${isStatic ? "s" : "i"}:${kind}:${name}`;
    if (seen.has(key)) continue;
    if (members.length >= MAX_MEMBERS_PER_CLASS) {
      truncated = true;
      break;
    }
    seen.add(key);
    const info: ClassMemberInfo = { name, kind, line: lineAt(sf, positionNode.getStart(sf)) };
    if (isStatic) info.isStatic = true;
    if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) info.visibility = "private";
    else if (hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) info.visibility = "protected";
    members.push(info);
  }
  return { members, truncated };
}

/** `sf.parseDiagnostics` es interno: acceso defensivo (ver test canario). */
function readParseDiagnostics(sf: ts.SourceFile): { count: number; items: { line: number; message: string }[] } {
  const raw = (sf as unknown as { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  const items = raw.slice(0, MAX_DIAGNOSTIC_ITEMS).map((diagnostic) => {
    const flat = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").replace(/\s+/g, " ").trim();
    return { line: lineAt(sf, diagnostic.start), message: flat.length > MAX_DIAGNOSTIC_MESSAGE_CHARS ? flat.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS) : flat };
  });
  return { count: raw.length, items };
}

type FunctionSymbolState = { symbol: SymbolInfo; signatures: number };

function extract(sf: ts.SourceFile, path: string, language: ParseableLanguage): FileAnalysis {
  const importItems: { pos: number; entry: ImportEntry }[] = [];
  const symbols: SymbolInfo[] = [];
  const exportEntries: ExportEntry[] = [];
  const functionStates = new Map<string, FunctionSymbolState>();
  const exportedLocalNames = new Set<string>();
  /** Exports cuyo `kind` depende de un símbolo local (puede declararse DESPUÉS del export). */
  const pendingLocalKind: ExportEntry[] = [];
  let dynamicNonLiteral = 0;
  let membersTruncated = false;

  const SK = ts.SyntaxKind;

  function declareSymbol(node: ts.Node, nameNode: ts.Identifier | undefined, kind: SymbolKind): SymbolInfo {
    const isExported = hasModifier(node, SK.ExportKeyword);
    const isDefault = hasModifier(node, SK.DefaultKeyword);
    const localName = nameNode?.text;
    const name = localName ?? "default";
    const line = lineAt(sf, (nameNode ?? node).getStart(sf));
    const symbol: SymbolInfo = { name, kind, line, exported: isExported };
    symbols.push(symbol);
    if (isExported) {
      const entry: ExportEntry = { name: isDefault ? "default" : name, kind, isTypeOnly: false, line };
      if (isDefault && localName) entry.localName = localName;
      exportEntries.push(entry);
    }
    return symbol;
  }

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      const entry: ImportEntry = {
        source: statement.moduleSpecifier.text,
        kind: clause ? "static" : "side-effect",
        isTypeOnly: clause?.isTypeOnly ?? false,
        named: [],
        line: lineAt(sf, statement.getStart(sf)),
      };
      if (clause?.name) entry.default = clause.name.text;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) entry.namespace = bindings.name.text;
      else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName ?? element.name;
          const item: ImportEntry["named"][number] = { name: imported.text, isTypeOnly: element.isTypeOnly };
          if (element.propertyName) item.alias = element.name.text;
          entry.named.push(item);
        }
      }
      importItems.push({ pos: statement.getStart(sf), entry });
    } else if (ts.isImportEqualsDeclaration(statement)) {
      const reference = statement.moduleReference;
      if (ts.isExternalModuleReference(reference) && ts.isStringLiteral(reference.expression)) {
        importItems.push({
          pos: statement.getStart(sf),
          entry: { source: reference.expression.text, kind: "import-equals", isTypeOnly: statement.isTypeOnly, namespace: statement.name.text, named: [], line: lineAt(sf, statement.getStart(sf)) },
        });
      }
    } else if (ts.isExportDeclaration(statement)) {
      const source = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      const clause = statement.exportClause;
      if (!clause) {
        if (source !== undefined) exportEntries.push({ name: "*", kind: "star", isTypeOnly: statement.isTypeOnly, source, line: lineAt(sf, statement.getStart(sf)) });
      } else if (ts.isNamespaceExport(clause)) {
        if (source !== undefined) exportEntries.push({ name: clause.name.text, kind: "namespace-reexport", isTypeOnly: statement.isTypeOnly, source, importedName: "*", line: lineAt(sf, statement.getStart(sf)) });
      } else {
        for (const element of clause.elements) {
          const line = lineAt(sf, element.getStart(sf));
          const original = (element.propertyName ?? element.name).text;
          const isTypeOnly = statement.isTypeOnly || element.isTypeOnly;
          if (source !== undefined) {
            exportEntries.push({ name: element.name.text, kind: "reexport", isTypeOnly, source, importedName: original, line });
          } else {
            const entry: ExportEntry = { name: element.name.text, kind: "reexport", isTypeOnly, localName: original, line };
            exportEntries.push(entry);
            pendingLocalKind.push(entry);
            exportedLocalNames.add(original);
          }
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      const line = lineAt(sf, statement.getStart(sf));
      const expression = unwrapExpression(statement.expression);
      const identifier = ts.isIdentifier(expression) ? expression.text : undefined;
      if (statement.isExportEquals) {
        const entry: ExportEntry = { name: "export=", kind: "export-equals", isTypeOnly: false, line };
        if (identifier) {
          entry.localName = identifier;
          exportedLocalNames.add(identifier);
        }
        exportEntries.push(entry);
      } else if (identifier) {
        const entry: ExportEntry = { name: "default", kind: "reexport", isTypeOnly: false, localName: identifier, line };
        exportEntries.push(entry);
        pendingLocalKind.push(entry);
        exportedLocalNames.add(identifier);
      } else {
        const kind: ExportKind = ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) ? "function" : ts.isClassExpression(expression) ? "class" : "expression";
        exportEntries.push({ name: "default", kind, isTypeOnly: false, line });
      }
    } else if (ts.isFunctionDeclaration(statement)) {
      const localName = statement.name?.text;
      const existing = localName !== undefined ? functionStates.get(localName) : undefined;
      if (existing) {
        // Overloads / implementación de la misma función: UNA sola entrada.
        if (!statement.body) existing.signatures += 1;
        continue;
      }
      const symbol = declareSymbol(statement, statement.name, "function");
      if (localName !== undefined) functionStates.set(localName, { symbol, signatures: statement.body ? 0 : 1 });
    } else if (ts.isClassDeclaration(statement)) {
      const symbol = declareSymbol(statement, statement.name, "class");
      const { members, truncated } = extractClassMembers(sf, statement);
      if (members.length > 0) symbol.members = members;
      if (truncated) membersTruncated = true;
    } else if (ts.isInterfaceDeclaration(statement)) {
      declareSymbol(statement, statement.name, "interface");
    } else if (ts.isTypeAliasDeclaration(statement)) {
      declareSymbol(statement, statement.name, "type");
    } else if (ts.isEnumDeclaration(statement)) {
      declareSymbol(statement, statement.name, "enum");
    } else if (ts.isModuleDeclaration(statement)) {
      // `declare module "x"` (nombre string) y `declare global` quedan fuera.
      if (ts.isIdentifier(statement.name) && !(statement.flags & ts.NodeFlags.GlobalAugmentation)) declareSymbol(statement, statement.name, "namespace");
    } else if (ts.isVariableStatement(statement)) {
      const isExported = hasModifier(statement, SK.ExportKeyword);
      const declaredKind = variableKind(statement.declarationList);
      for (const declaration of statement.declarationList.declarations) {
        const identifiers: ts.Identifier[] = [];
        collectBindingIdentifiers(declaration.name, identifiers);
        const kind: SymbolKind = ts.isIdentifier(declaration.name) && isFunctionValue(declaration.initializer) ? "function" : declaredKind;
        for (const identifier of identifiers) {
          const line = lineAt(sf, identifier.getStart(sf));
          symbols.push({ name: identifier.text, kind, line, exported: isExported });
          if (isExported) exportEntries.push({ name: identifier.text, kind, isTypeOnly: false, line });
        }
      }
    }
  }

  // import() y require() en cualquier parte del archivo (el recorrido completo
  // es barato: ver diseño). Solo se capturan argumentos literales.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === SK.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if ((isDynamicImport || isRequire) && (isDynamicImport || node.arguments.length > 0)) {
        const first = node.arguments[0];
        if (first && ts.isStringLiteralLike(first) && (isDynamicImport || node.arguments.length === 1)) {
          importItems.push({
            pos: node.getStart(sf),
            entry: { source: first.text, kind: isDynamicImport ? "dynamic" : "require", isTypeOnly: false, named: [], line: lineAt(sf, node.getStart(sf)) },
          });
        } else {
          dynamicNonLiteral += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Post-proceso: overloads, `exported` por export-lists y `kind` de exports locales.
  for (const state of functionStates.values()) {
    if (state.signatures >= 2) state.symbol.overloads = state.signatures;
  }
  const firstSymbolByName = new Map<string, SymbolInfo>();
  for (const symbol of symbols) {
    if (!firstSymbolByName.has(symbol.name)) firstSymbolByName.set(symbol.name, symbol);
    if (exportedLocalNames.has(symbol.name)) symbol.exported = true;
  }
  for (const entry of pendingLocalKind) {
    const local = entry.localName !== undefined ? firstSymbolByName.get(entry.localName) : undefined;
    // Si no hay símbolo local, es un binding importado re-exportado: 7C lo enlaza con `imports`.
    if (local) entry.kind = local.kind;
  }

  importItems.sort((a, b) => a.pos - b.pos);
  const truncated: NonNullable<FileAnalysis["truncated"]> = {};
  if (importItems.length > MAX_IMPORTS_PER_FILE) truncated.imports = true;
  if (exportEntries.length > MAX_EXPORTS_PER_FILE) truncated.exports = true;
  if (symbols.length > MAX_SYMBOLS_PER_FILE || membersTruncated) truncated.symbols = true;

  const diagnostics = readParseDiagnostics(sf);
  const analysis: FileAnalysis = {
    path,
    language,
    parse: diagnostics.count > 0 ? { status: "diagnostics", count: diagnostics.count, items: diagnostics.items } : { status: "ok" },
    imports: importItems.slice(0, MAX_IMPORTS_PER_FILE).map((item) => item.entry),
    exports: exportEntries.slice(0, MAX_EXPORTS_PER_FILE),
    symbols: symbols.slice(0, MAX_SYMBOLS_PER_FILE),
  };
  if (dynamicNonLiteral > 0) analysis.dynamicNonLiteral = dynamicNonLiteral;
  if (Object.keys(truncated).length > 0) analysis.truncated = truncated;
  return analysis;
}

/**
 * Analiza el TEXTO de un archivo. Pura y determinista: mismo texto →
 * mismo resultado. Nunca lanza: si el parser o el recorrido fallan de forma
 * inesperada (ej. un AST anidado a una profundidad que revienta el stack),
 * devuelve `failed: parser_threw` solo con el nombre del error.
 */
export function analyzeSourceText(path: string, language: ParseableLanguage, sourceText: string): FileAnalysis {
  try {
    const sf = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, false, SCRIPT_KIND[language]);
    return extract(sf, path, language);
  } catch (error) {
    return failedAnalysis(path, language, "parser_threw", error instanceof Error ? error.name : "UNKNOWN");
  }
}

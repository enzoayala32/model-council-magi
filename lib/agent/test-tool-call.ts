/**
 * Helper exclusivo de tests (Fase 3): tipa el `execute()` de un tool sin
 * recurrir a `as any`. El set real que devuelve `createAgentTools` es un
 * union de tools con inputs/outputs distintos; los harness que llaman uno
 * puntual convierten el set a este contrato laxo y verifican el shape a mano.
 */
export type TestToolResult = {
  ok: boolean;
  error: string;
  code: string;
  content: string;
  output: string;
  success: boolean;
  files: string[];
  truncated: boolean;
  sizeBytes: number;
  hash: string | null;
  hashAlgorithm: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  nextStartLine: number | null;
  results: Array<{ title: string; url: string; snippet: string }>;
};

export type TestTool = {
  execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<TestToolResult>;
};

export function testTool(tools: unknown, name: string): TestTool {
  return (tools as Record<string, TestTool>)[name];
}

// Shared tool shape for every agent tool (dealroom, web, deck) + batch runner.
import type { Session } from './store.js';

export interface ToolCtx { session: Session; status(text: string): void }
export interface ToolDef {
  name: string; description: string; input_schema: object; // JSON Schema
  run(input: any, ctx: ToolCtx): Promise<unknown>; // returned value is JSON.stringified into tool_result
}

export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: any }
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

const MAX_RESULT_CHARS = 60_000;

export function toAnthropicTools(defs: ToolDef[]) {
  return defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.input_schema }));
}

function stringify(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + '...[truncated]' : s;
}

/** Run every tool_use of one assistant turn in PARALLEL; one tool_result per tool_use, in order. */
export async function runToolBatch(defs: ToolDef[], toolUses: ToolUseBlock[], ctx: ToolCtx): Promise<ToolResultBlock[]> {
  const byName = new Map(defs.map((d) => [d.name, d]));
  return Promise.all(toolUses.map(async (tu): Promise<ToolResultBlock> => {
    const def = byName.get(tu.name);
    if (!def) return { type: 'tool_result', tool_use_id: tu.id, content: `Unknown tool "${tu.name}"`, is_error: true };
    try {
      const out = await def.run(tu.input ?? {}, ctx);
      return { type: 'tool_result', tool_use_id: tu.id, content: stringify(out) };
    } catch (e: any) {
      return { type: 'tool_result', tool_use_id: tu.id, content: `Error: ${e?.message ?? String(e)}`, is_error: true };
    }
  }));
}

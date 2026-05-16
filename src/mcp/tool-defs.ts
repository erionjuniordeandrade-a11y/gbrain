import type { Operation } from '../core/operations.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export function buildToolDefs(ops: Operation[]): McpToolDef[] {
  return ops.map(op => ({
    name: op.name,
    description: op.description,
    inputSchema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries(op.params).map(([k, v]) => [k, {
          type: v.type === 'array' ? 'array' : v.type,
          ...(v.description ? { description: v.description } : {}),
          ...(v.enum ? { enum: v.enum } : {}),
          // OpenAI/Hermes reject array schemas without `items`. Keep explicit
          // operation item types when present and fail closed to string items
          // for legacy array params instead of emitting an invalid tool schema.
          ...(v.type === 'array' ? { items: { type: v.items?.type ?? 'string' } } : {}),
        }]),
      ),
      required: Object.entries(op.params)
        .filter(([, v]) => v.required)
        .map(([k]) => k),
    },
  }));
}

/**
 * Fetch interceptor for Anthropic API requests.
 *
 * Loaded via bunfig.toml preload to run BEFORE any modules are evaluated.
 * This ensures we patch globalThis.fetch before the SDK captures it.
 *
 * Features:
 * - Captures API errors for error handler (4xx/5xx responses)
 * - Adds _intent and _displayName metadata to MCP tool schemas
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Type alias for fetch's HeadersInit (not in ESNext lib, but available at runtime via Bun)
// Using string[][] instead of [string, string][] to match RequestInit.headers type
type HeadersInitType = Headers | Record<string, string> | string[][];

const DEBUG = process.argv.includes('--debug') || process.env.CRAFT_DEBUG === '1';

// Log file for debug output (avoids console spam)
const LOG_DIR = join(homedir(), '.craft-agent', 'logs');
const LOG_FILE = join(LOG_DIR, 'interceptor.log');

// Ensure log directory exists at module load
try {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
} catch {
  // Ignore - logging will silently fail if dir can't be created
}

/**
 * Store the last API error for the error handler to access.
 * This allows us to capture the actual HTTP status code (e.g., 402 Payment Required)
 * before the SDK wraps it in a generic error message.
 *
 * Uses file-based storage to reliably share across process boundaries
 * (the SDK may run in a subprocess with separate memory space).
 */
export interface LastApiError {
  status: number;
  statusText: string;
  message: string;
  timestamp: number;
}

// File-based storage for cross-process sharing
const ERROR_FILE = join(homedir(), '.craft-agent', 'api-error.json');
const MAX_ERROR_AGE_MS = 5 * 60 * 1000; // 5 minutes

function getStoredError(): LastApiError | null {
  try {
    if (!existsSync(ERROR_FILE)) return null;
    const content = readFileSync(ERROR_FILE, 'utf-8');
    const error = JSON.parse(content) as LastApiError;
    // Pop: delete after reading
    try {
      unlinkSync(ERROR_FILE);
      debugLog(`[getStoredError] Popped error file`);
    } catch {
      // Ignore delete errors
    }
    return error;
  } catch {
    return null;
  }
}

function setStoredError(error: LastApiError | null): void {
  try {
    if (error) {
      writeFileSync(ERROR_FILE, JSON.stringify(error));
      debugLog(`[setStoredError] Wrote error to file: ${error.status} ${error.message}`);
    } else {
      // Clear the file
      try {
        unlinkSync(ERROR_FILE);
      } catch {
        // File might not exist
      }
    }
  } catch (e) {
    debugLog(`[setStoredError] Failed to write: ${e}`);
  }
}

export function getLastApiError(): LastApiError | null {
  const error = getStoredError();
  if (error) {
    const age = Date.now() - error.timestamp;
    if (age < MAX_ERROR_AGE_MS) {
      debugLog(`[getLastApiError] Found error (age ${age}ms): ${error.status}`);
      return error;
    }
    debugLog(`[getLastApiError] Error too old (${age}ms > ${MAX_ERROR_AGE_MS}ms)`);
  }
  return null;
}

export function clearLastApiError(): void {
  setStoredError(null);
}


function debugLog(...args: unknown[]) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString();
  const message = `${timestamp} [interceptor] ${args.map((a) => {
    if (typeof a === 'object') {
      try {
        return JSON.stringify(a);
      } catch (e) {
        const keys = a && typeof a === 'object' ? Object.keys(a as object).join(', ') : 'unknown';
        return `[CYCLIC STRUCTURE, keys: ${keys}] (error: ${e})`;
      }
    }
    return String(a);
  }).join(' ')}`;
  // Write to log file instead of stderr to avoid console spam
  try {
    appendFileSync(LOG_FILE, message + '\n');
  } catch {
    // Silently fail if can't write to log file
  }
}


/**
 * Get the configured API base URL at request time.
 * Reads from env var (set by auth/sessions before SDK starts) with Anthropic default fallback.
 */
function getConfiguredBaseUrl(): string {
  return process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com';
}

/**
 * Check if URL is a messages endpoint for the configured API provider.
 * Works with Anthropic, OpenRouter, and any custom baseUrl.
 */
function isApiMessagesUrl(url: string): boolean {
  const baseUrl = getConfiguredBaseUrl();
  return url.startsWith(baseUrl) && url.includes('/messages');
}

function isGeminiBaseUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    if (u.hostname.toLowerCase() === 'generativelanguage.googleapis.com') return true;
    return u.pathname.split('/').includes('v1beta');
  } catch {
    return false;
  }
}

function normalizeGeminiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  try {
    const u = new URL(trimmed);
    const pathname = u.pathname.replace(/\/+$/, '');
    u.pathname = pathname.endsWith('/models') ? pathname.slice(0, -'/models'.length) : pathname;
    return u.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/models$/, '');
  }
}

function normalizeGeminiModelId(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return 'models/gemini-2.0-flash';
  if (trimmed.startsWith('models/')) return trimmed;
  return `models/${trimmed}`;
}

function extractSystemText(system: unknown): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    const chunks: string[] = [];
    for (const item of system) {
      if (!item) continue;
      if (typeof item === 'string') {
        chunks.push(item);
        continue;
      }
      if (typeof item === 'object' && 'type' in (item as any)) {
        const type = (item as any).type;
        if (type === 'text' && typeof (item as any).text === 'string') chunks.push((item as any).text);
      }
    }
    const joined = chunks.join('\n').trim();
    return joined || undefined;
  }
  return undefined;
}

type GeminiSchemaType = 'OBJECT' | 'ARRAY' | 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN';

type GeminiSchema = {
  type?: GeminiSchemaType;
  description?: string;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  enum?: Array<string | number | boolean | null>;
  items?: GeminiSchema;
  nullable?: boolean;
  format?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
};

function toGeminiType(type: unknown): GeminiSchemaType | undefined {
  if (typeof type !== 'string') return undefined;
  const t = type.toLowerCase();
  if (t === 'object') return 'OBJECT';
  if (t === 'array') return 'ARRAY';
  if (t === 'string') return 'STRING';
  if (t === 'number') return 'NUMBER';
  if (t === 'integer') return 'INTEGER';
  if (t === 'boolean') return 'BOOLEAN';
  return undefined;
}

function mergeGeminiSchemas(a: GeminiSchema, b: GeminiSchema): GeminiSchema {
  const merged: GeminiSchema = {
    ...a,
    ...b,
  };

  if (a.description && !b.description) merged.description = a.description;
  if (b.description && !a.description) merged.description = b.description;

  if (a.nullable || b.nullable) merged.nullable = true;

  if (a.required || b.required) {
    const set = new Set<string>();
    for (const r of a.required ?? []) set.add(r);
    for (const r of b.required ?? []) set.add(r);
    merged.required = Array.from(set);
  }

  if (a.properties || b.properties) {
    merged.properties = {
      ...(a.properties ?? {}),
      ...(b.properties ?? {}),
    };
  }

  if (a.items || b.items) merged.items = b.items ?? a.items;

  if (a.enum || b.enum) merged.enum = b.enum ?? a.enum;

  return merged;
}

function normalizeJsonSchemaForGemini(schema: unknown): GeminiSchema | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const s = schema as Record<string, unknown>;

  const allOf = Array.isArray(s.allOf) ? (s.allOf as unknown[]) : undefined;
  if (allOf && allOf.length > 0) {
    let merged: GeminiSchema | undefined;
    for (const part of allOf) {
      const converted = normalizeJsonSchemaForGemini(part);
      if (!converted) continue;
      merged = merged ? mergeGeminiSchemas(merged, converted) : converted;
    }
    return merged;
  }

  const anyOf = Array.isArray(s.anyOf) ? (s.anyOf as unknown[]) : undefined;
  const oneOf = Array.isArray(s.oneOf) ? (s.oneOf as unknown[]) : undefined;
  const union = anyOf ?? oneOf;
  if (union && union.length > 0) {
    let nullable = false;
    let chosen: GeminiSchema | undefined;
    for (const variant of union) {
      if (!variant || typeof variant !== 'object') continue;
      const vt = (variant as any).type;
      const vtArr = Array.isArray(vt) ? vt : typeof vt === 'string' ? [vt] : [];
      if (vtArr.some(x => typeof x === 'string' && x.toLowerCase() === 'null')) {
        nullable = true;
        const nonNullTypes = vtArr.filter(x => !(typeof x === 'string' && x.toLowerCase() === 'null')) as string[];
        if (nonNullTypes.length > 0) {
          const v2 = { ...(variant as any), type: nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes };
          const converted = normalizeJsonSchemaForGemini(v2);
          if (converted && !chosen) chosen = converted;
        }
        continue;
      }
      const converted = normalizeJsonSchemaForGemini(variant);
      if (converted && !chosen) chosen = converted;
    }
    if (!chosen) return undefined;
    return { ...chosen, ...(nullable ? { nullable: true } : {}) };
  }

  const typeRaw = s.type;
  const typeArr = Array.isArray(typeRaw) ? (typeRaw as unknown[]) : typeof typeRaw === 'string' ? [typeRaw] : undefined;
  let nullable = false;
  let baseType: GeminiSchemaType | undefined;
  if (typeArr) {
    const filtered = typeArr.filter(t => !(typeof t === 'string' && t.toLowerCase() === 'null'));
    nullable = filtered.length !== typeArr.length;
    baseType = filtered.length === 1 ? toGeminiType(filtered[0]) : undefined;
  } else {
    baseType = toGeminiType(typeRaw);
  }

  if (!baseType) {
    if (s.properties && typeof s.properties === 'object') baseType = 'OBJECT';
    else if (s.items && typeof s.items === 'object') baseType = 'ARRAY';
    else if (Array.isArray(s.enum) && s.enum.length > 0) {
      const sample = s.enum.find(v => v !== null && v !== undefined);
      if (typeof sample === 'string') baseType = 'STRING';
      else if (typeof sample === 'number') baseType = Number.isInteger(sample) ? 'INTEGER' : 'NUMBER';
      else if (typeof sample === 'boolean') baseType = 'BOOLEAN';
    }
  }

  const out: GeminiSchema = {};
  if (baseType) out.type = baseType;
  if (nullable) out.nullable = true;

  if (typeof s.description === 'string' && s.description.trim()) out.description = s.description;

  if (Array.isArray(s.enum)) {
    const enums: Array<string | number | boolean | null> = [];
    for (const v of s.enum) {
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') enums.push(v);
    }
    if (enums.length > 0) out.enum = enums;
  }

  const minimum = typeof s.minimum === 'number' ? s.minimum : undefined;
  const maximum = typeof s.maximum === 'number' ? s.maximum : undefined;
  const exclusiveMinimum = typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum : undefined;
  const exclusiveMaximum = typeof s.exclusiveMaximum === 'number' ? s.exclusiveMaximum : undefined;

  if (out.type === 'INTEGER') {
    if (typeof minimum === 'number') out.minimum = minimum;
    else if (typeof exclusiveMinimum === 'number') out.minimum = Math.floor(exclusiveMinimum) + 1;
    if (typeof maximum === 'number') out.maximum = maximum;
    else if (typeof exclusiveMaximum === 'number') out.maximum = Math.ceil(exclusiveMaximum) - 1;
  } else if (out.type === 'NUMBER') {
    if (typeof minimum === 'number') out.minimum = minimum;
    else if (typeof exclusiveMinimum === 'number') out.minimum = exclusiveMinimum;
    if (typeof maximum === 'number') out.maximum = maximum;
    else if (typeof exclusiveMaximum === 'number') out.maximum = exclusiveMaximum;
  }

  if (typeof s.minItems === 'number') out.minItems = s.minItems;
  if (typeof s.maxItems === 'number') out.maxItems = s.maxItems;
  if (typeof s.minLength === 'number') out.minLength = s.minLength;
  if (typeof s.maxLength === 'number') out.maxLength = s.maxLength;
  if (typeof s.format === 'string') out.format = s.format;

  if (out.type === 'ARRAY') {
    out.items = normalizeJsonSchemaForGemini(s.items);
  }

  if (out.type === 'OBJECT') {
    const props = s.properties && typeof s.properties === 'object' ? (s.properties as Record<string, unknown>) : undefined;
    if (props) {
      const converted: Record<string, GeminiSchema> = {};
      for (const [k, v] of Object.entries(props)) {
        const child = normalizeJsonSchemaForGemini(v);
        if (child) converted[k] = child;
      }
      if (Object.keys(converted).length > 0) out.properties = converted;
    }

    const required = Array.isArray(s.required) ? (s.required as unknown[]) : undefined;
    if (required) {
      const req: string[] = [];
      for (const r of required) if (typeof r === 'string' && r) req.push(r);
      if (req.length > 0) out.required = req;
    }
  }

  if (!out.type && (out.properties || out.items || out.enum || out.description)) {
    out.type = out.properties ? 'OBJECT' : out.items ? 'ARRAY' : out.enum ? 'STRING' : undefined;
  }

  if (!out.type) return undefined;
  return out;
}

function buildGeminiToolDeclarations(tools: unknown): Array<{ functionDeclarations: unknown[] }> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const functionDeclarations: unknown[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const name = (t as any).name;
    if (typeof name !== 'string' || !name) continue;
    const description = typeof (t as any).description === 'string' ? (t as any).description : undefined;
    const rawSchema = (t as any).input_schema && typeof (t as any).input_schema === 'object' ? (t as any).input_schema : undefined;
    const parameters = rawSchema ? normalizeJsonSchemaForGemini(rawSchema) : undefined;
    functionDeclarations.push({
      name,
      ...(description ? { description } : {}),
      ...(parameters ? { parameters } : {}),
    });
  }

  if (functionDeclarations.length === 0) return undefined;
  return [{ functionDeclarations }];
}

function buildGeminiContents(messages: unknown): {
  contents: Array<{ role: 'user' | 'model'; parts: unknown[] }>;
  toolUseIdToName: Record<string, string>;
} {
  const contents: Array<{ role: 'user' | 'model'; parts: unknown[] }> = [];
  const toolUseIdToName: Record<string, string> = {};

  if (!Array.isArray(messages)) return { contents, toolUseIdToName };

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const roleRaw = (m as any).role;
    const role: 'user' | 'model' = roleRaw === 'assistant' ? 'model' : 'user';
    const content = (m as any).content;

    const parts: unknown[] = [];

    const pushText = (text: string) => {
      const t = text.trim();
      if (t) parts.push({ text: t });
    };

    const pushToolUse = (block: any) => {
      const name = block?.name;
      const id = block?.id;
      if (typeof name !== 'string' || !name) return;
      if (typeof id === 'string' && id) toolUseIdToName[id] = name;
      parts.push({ functionCall: { name, args: block?.input && typeof block.input === 'object' ? block.input : {} } });
    };

    const pushToolResult = (block: any) => {
      const toolUseId = block?.tool_use_id;
      const name = typeof toolUseId === 'string' ? toolUseIdToName[toolUseId] : undefined;
      if (!name) return;
      parts.push({
        functionResponse: {
          name,
          response: {
            ...(block?.is_error ? { error: true } : {}),
            ...(block?.content !== undefined ? { content: block.content } : {}),
          },
        },
      });
    };

    if (typeof content === 'string') {
      pushText(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const type = (block as any).type;
        if (type === 'text' && typeof (block as any).text === 'string') {
          pushText((block as any).text);
        } else if (type === 'image' && (block as any).source?.type === 'base64') {
          const mediaType = (block as any).source?.media_type;
          const data = (block as any).source?.data;
          if (typeof mediaType === 'string' && typeof data === 'string') {
            parts.push({ inlineData: { mimeType: mediaType, data } });
          }
        } else if (type === 'tool_use') {
          pushToolUse(block);
        } else if (type === 'tool_result') {
          pushToolResult(block);
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  return { contents, toolUseIdToName };
}

function geminiFinishReasonToStopReason(reason: unknown, hasToolUse: boolean): string {
  if (hasToolUse) return 'tool_use';
  const r = typeof reason === 'string' ? reason.toUpperCase() : '';
  if (r === 'MAX_TOKENS') return 'max_tokens';
  if (r === 'SAFETY') return 'stop_sequence';
  return 'end_turn';
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

function geminiToAnthropicContentBlocks(geminiContent: any): AnthropicContentBlock[] {
  const parts = geminiContent?.parts;
  if (!Array.isArray(parts)) return [];

  const blocks: AnthropicContentBlock[] = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (typeof (p as any).text === 'string') {
      blocks.push({ type: 'text', text: (p as any).text });
      continue;
    }
    if ((p as any).functionCall && typeof (p as any).functionCall?.name === 'string') {
      const name = (p as any).functionCall.name;
      const args =
        (p as any).functionCall.args && typeof (p as any).functionCall.args === 'object'
          ? ((p as any).functionCall.args as Record<string, unknown>)
          : {};
      blocks.push({ type: 'tool_use', id: `toolu_${randomUUID()}`, name, input: args });
      continue;
    }
  }
  return blocks;
}

function buildAnthropicMessageFromGeminiResponse(
  geminiJson: any,
  requestedModel: string,
  streamRequested: boolean
): { message: any; streamEvents?: string } {
  const candidate = Array.isArray(geminiJson?.candidates) ? geminiJson.candidates[0] : undefined;
  const content = candidate?.content;
  const blocks = geminiToAnthropicContentBlocks(content);
  const hasToolUse = blocks.some(b => b.type === 'tool_use');
  const stopReason = geminiFinishReasonToStopReason(candidate?.finishReason, hasToolUse);

  const usage = geminiJson?.usageMetadata;
  const inputTokens = typeof usage?.promptTokenCount === 'number' ? usage.promptTokenCount : 0;
  const outputTokens = typeof usage?.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0;

  const message = {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content: blocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };

  if (!streamRequested) return { message };

  const streamStartMessage = {
    ...message,
    content: [],
    stop_reason: null,
  };

  const events: string[] = [];
  const pushEvent = (event: string, data: unknown) => {
    events.push(`event: ${event}\n`);
    events.push(`data: ${JSON.stringify(data)}\n\n`);
  };

  pushEvent('message_start', { type: 'message_start', message: streamStartMessage });

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    if (block.type === 'text') {
      pushEvent('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      pushEvent('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } });
      pushEvent('content_block_stop', { type: 'content_block_stop', index: i });
    } else if (block.type === 'tool_use') {
      const input = block.input;
      pushEvent('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      pushEvent('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      pushEvent('content_block_stop', { type: 'content_block_stop', index: i });
    }
  }

  pushEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  pushEvent('message_stop', { type: 'message_stop' });

  return { message, streamEvents: events.join('') };
}

function createSseResponse(payload: string, status: number): Response {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(payload);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

/**
 * Add _intent and _displayName fields to all MCP tool schemas in Anthropic API request.
 * Only modifies tools that start with "mcp__" (MCP tools from SDK).
 * Returns the modified request body object.
 *
 * - _intent: 1-2 sentence description of what the tool call accomplishes (for UI activity descriptions)
 * - _displayName: 2-4 word human-friendly action name (for UI tool name display)
 */
function addMetadataToMcpTools(body: Record<string, unknown>): Record<string, unknown> {
  const tools = body.tools as Array<{
    name?: string;
    input_schema?: {
      properties?: Record<string, unknown>;
      required?: string[];
    };
  }> | undefined;

  if (!tools || !Array.isArray(tools)) {
    return body;
  }

  let modifiedCount = 0;
  for (const tool of tools) {
    // Only modify MCP tools (prefixed with mcp__)
    if (tool.name?.startsWith('mcp__') && tool.input_schema?.properties) {
      let modified = false;

      // Add _intent if not present
      if (!('_intent' in tool.input_schema.properties)) {
        tool.input_schema.properties._intent = {
          type: 'string',
          description: 'REQUIRED: Describe what you are trying to accomplish with this tool call (1-2 sentences)',
        };
        modified = true;
      }

      // Add _displayName if not present
      if (!('_displayName' in tool.input_schema.properties)) {
        tool.input_schema.properties._displayName = {
          type: 'string',
          description: 'REQUIRED: Human-friendly name for this action (2-4 words, e.g., "List Folders", "Search Documents", "Create Task")',
        };
        modified = true;
      }

      // Add both to required array if we modified anything
      if (modified) {
        const currentRequired = tool.input_schema.required || [];
        const newRequired = [...currentRequired];
        if (!currentRequired.includes('_intent')) {
          newRequired.push('_intent');
        }
        if (!currentRequired.includes('_displayName')) {
          newRequired.push('_displayName');
        }
        tool.input_schema.required = newRequired;
        modifiedCount++;
      }
    }
  }

  if (modifiedCount > 0) {
    debugLog(`[MCP Schema] Added _intent and _displayName to ${modifiedCount} MCP tools`);
  }

  return body;
}

/**
 * Check if URL should have API errors captured.
 * Uses the configured base URL so error capture works with any provider.
 */
function shouldCaptureApiErrors(url: string): boolean {
  return isApiMessagesUrl(url);
}

const originalFetch = globalThis.fetch.bind(globalThis);

/**
 * Convert headers to cURL -H flags, redacting sensitive values
 */
function headersToCurl(headers: HeadersInitType | undefined): string {
  if (!headers) return '';

  const headerObj: Record<string, string> =
    headers instanceof Headers
      ? Object.fromEntries(Array.from(headers as unknown as Iterable<[string, string]>))
      : Array.isArray(headers)
        ? Object.fromEntries(headers)
        : (headers as Record<string, string>);

  const sensitiveKeys = ['x-api-key', 'x-goog-api-key', 'authorization', 'cookie'];

  return Object.entries(headerObj)
    .map(([key, value]) => {
      const redacted = sensitiveKeys.includes(key.toLowerCase())
        ? '[REDACTED]'
        : value;
      return `-H '${key}: ${redacted}'`;
    })
    .join(' \\\n  ');
}

/**
 * Format a fetch request as a cURL command
 */
function toCurl(url: string, init?: RequestInit): string {
  const method = init?.method?.toUpperCase() ?? 'GET';
  const headers = headersToCurl(init?.headers as HeadersInitType | undefined);

  let curl = `curl -X ${method}`;
  if (headers) {
    curl += ` \\\n  ${headers}`;
  }
  if (init?.body && typeof init.body === 'string') {
    // Escape single quotes in body for shell safety
    const escapedBody = init.body.replace(/'/g, "'\\''");
    curl += ` \\\n  -d '${escapedBody}'`;
  }
  curl += ` \\\n  '${url}'`;

  return curl;
}

/**
 * Clone response and log its body (handles streaming responses).
 * Also captures API errors (4xx/5xx) for the error handler.
 */
async function logResponse(response: Response, url: string, startTime: number): Promise<Response> {
  const duration = Date.now() - startTime;


  // Capture API errors (runs regardless of DEBUG mode)
  if (shouldCaptureApiErrors(url) && response.status >= 400) {
    debugLog(`  [Attempting to capture error for ${response.status} response]`);
    // Clone to read body without consuming the original
    const errorClone = response.clone();
    try {
      const errorText = await errorClone.text();
      let errorMessage = response.statusText;

      // Try to parse JSON error response
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error?.message) {
          errorMessage = errorJson.error.message;
        } else if (errorJson.message) {
          errorMessage = errorJson.message;
        }
      } catch {
        // Use raw text if not JSON
        if (errorText) errorMessage = errorText;
      }

      setStoredError({
        status: response.status,
        statusText: response.statusText,
        message: errorMessage,
        timestamp: Date.now(),
      });
      debugLog(`  [Captured API error: ${response.status} ${errorMessage}]`);
    } catch (e) {
      // Still capture basic info even if body read fails
      debugLog(`  [Error reading body, capturing basic info: ${e}]`);
      setStoredError({
        status: response.status,
        statusText: response.statusText,
        message: response.statusText,
        timestamp: Date.now(),
      });
    }
  }

  if (!DEBUG) return response;

  debugLog(`\n← RESPONSE ${response.status} ${response.statusText} (${duration}ms)`);
  debugLog(`  URL: ${url}`);

  // Log response headers
  const respHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    respHeaders[key] = value;
  });
  debugLog('  Headers:', respHeaders);

  // For streaming responses, we can't easily log the body without consuming it
  // For non-streaming, clone and log
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    debugLog('  Body: [SSE stream - not logged]');
    return response;
  }

  // Clone the response so we can read the body without consuming it
  const clone = response.clone();
  try {
    const text = await clone.text();
    // Limit logged response size to prevent huge logs
    const maxLogSize = 5000;
    if (text.length > maxLogSize) {
      debugLog(`  Body (truncated to ${maxLogSize} chars):\n${text.substring(0, maxLogSize)}...`);
    } else {
      debugLog(`  Body:\n${text}`);
    }
  } catch (e) {
    debugLog('  Body: [failed to read]', e);
  }

  return response;
}

async function interceptedFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  const startTime = Date.now();


  // Log all requests as cURL commands
  if (DEBUG) {
    debugLog('\n' + '='.repeat(80));
    debugLog('→ REQUEST');
    debugLog(toCurl(url, init));
  }

  if (
    isApiMessagesUrl(url) &&
    init?.method?.toUpperCase() === 'POST' &&
    init?.body
  ) {
    try {
      const body = typeof init.body === 'string' ? init.body : undefined;
      if (body) {
        let parsed = JSON.parse(body);

        const configuredBaseUrl = getConfiguredBaseUrl();
        const isGemini = isGeminiBaseUrl(configuredBaseUrl);

        if (isGemini) {
          const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
          if (!apiKey) {
            const missingKeyResponse = new Response(JSON.stringify({ error: { message: 'Missing API key for Gemini provider' } }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            });
            return logResponse(missingKeyResponse, url, startTime);
          }

          const streamRequested = Boolean((parsed as any).stream);
          const requestedModel = normalizeGeminiModelId(String((parsed as any).model ?? ''));

          const { contents } = buildGeminiContents((parsed as any).messages);
          const systemText = extractSystemText((parsed as any).system);
          const tools = buildGeminiToolDeclarations((parsed as any).tools);

          const generationConfig: Record<string, unknown> = {};
          if (typeof (parsed as any).max_tokens === 'number') generationConfig.maxOutputTokens = (parsed as any).max_tokens;
          if (typeof (parsed as any).temperature === 'number') generationConfig.temperature = (parsed as any).temperature;
          if (typeof (parsed as any).top_p === 'number') generationConfig.topP = (parsed as any).top_p;
          if (typeof (parsed as any).top_k === 'number') generationConfig.topK = (parsed as any).top_k;

          const geminiRequest: Record<string, unknown> = {
            contents,
            ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
            ...(tools ? { tools, toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
            ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
          };

          const base = normalizeGeminiBaseUrl(configuredBaseUrl);
          const endpoint = `${base}/${requestedModel}:generateContent`;

          const upstreamResponse = await originalFetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
            },
            body: JSON.stringify(geminiRequest),
          });

          const text = await upstreamResponse.text();
          if (!upstreamResponse.ok) {
            const message = text || upstreamResponse.statusText;
            const errorResponse = new Response(JSON.stringify({ error: { message } }), {
              status: upstreamResponse.status,
              headers: { 'Content-Type': 'application/json' },
            });
            return logResponse(errorResponse, url, startTime);
          }

          const geminiJson = text ? JSON.parse(text) : {};
          const { message, streamEvents } = buildAnthropicMessageFromGeminiResponse(geminiJson, requestedModel, streamRequested);
          const adaptedResponse = streamRequested && streamEvents
            ? createSseResponse(streamEvents, 200)
            : new Response(JSON.stringify(message), { status: 200, headers: { 'Content-Type': 'application/json' } });

          return logResponse(adaptedResponse, url, startTime);
        }

        parsed = addMetadataToMcpTools(parsed);

        const modifiedInit = {
          ...init,
          body: JSON.stringify(parsed),
        };

        const response = await originalFetch(url, modifiedInit);
        return logResponse(response, url, startTime);
      }
    } catch (e) {
      debugLog('FETCH modification failed:', e);
    }
  }

  const response = await originalFetch(input, init);
  return logResponse(response, url, startTime);
}

// Create proxy to handle both function calls and static properties (e.g., fetch.preconnect in Bun)
const fetchProxy = new Proxy(interceptedFetch, {
  apply(target, thisArg, args) {
    return Reflect.apply(target, thisArg, args);
  },
  get(target, prop, receiver) {
    if (prop in originalFetch) {
      return (originalFetch as unknown as Record<string | symbol, unknown>)[
        prop
      ];
    }
    return Reflect.get(target, prop, receiver);
  },
});

(globalThis as unknown as { fetch: unknown }).fetch = fetchProxy;
debugLog('Fetch interceptor installed');

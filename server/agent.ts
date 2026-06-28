import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------- Configuration ----------

let mcpClient: Client | null = null
let mcpTools: Anthropic.Tool[] = []
let systemPrompt = ''

// Read env vars lazily — module-level reads race with dotenv in ESM
const env = () => ({
  MCP_URL: process.env.MCP_URL || '',
  MCP_TRANSPORT: process.env.MCP_TRANSPORT || '',
  MCP_PYTHON: process.env.MCP_PYTHON || '',
  MCP_CWD: process.env.MCP_CWD || '',
  MCP_MODULE: process.env.MCP_MODULE || 'wip_mcp',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  CLAUDE_MODEL: process.env.CLAUDE_MODEL || 'claude-haiku-4-5',
  WIP_NAMESPACE: process.env.WIP_NAMESPACE || '',
  KB_LIBRARY_NAMESPACE: process.env.KB_LIBRARY_NAMESPACE || '',
  WIP_API_KEY: process.env.WIP_API_KEY || '',
  MAX_TURNS: parseInt(process.env.MAX_TURNS || '15'),
  SESSION_TTL_MS: parseInt(process.env.SESSION_TTL_MINUTES || '30') * 60_000,
})

// ---------- Anthropic key resolution (CASE-508) ----------
// process.env is frozen at process start, so an env-only key can't be rotated
// without a redeploy. Resolve in priority order so the key is settable in a
// running system: runtime override (set via the admin config endpoint) → key
// file (ANTHROPIC_API_KEY_FILE, mirroring the WIP apiKeyFile pattern, CASE-495)
// → env. The key is a secret — it never goes into a WIP document.
let runtimeKeyOverride: string | null = null

function keyFromFile(): string {
  const f = process.env.ANTHROPIC_API_KEY_FILE
  if (!f) return ''
  try {
    return readFileSync(f, 'utf-8').trim()
  } catch {
    return ''
  }
}

function anthropicKey(): string {
  return runtimeKeyOverride || keyFromFile() || process.env.ANTHROPIC_API_KEY || ''
}

function keySource(): 'override' | 'file' | 'env' | 'none' {
  if (runtimeKeyOverride) return 'override'
  if (keyFromFile()) return 'file'
  if (process.env.ANTHROPIC_API_KEY) return 'env'
  return 'none'
}

// Masked status only — the key value is never returned to a caller.
export function getKeyStatus() {
  const key = anthropicKey()
  return {
    configured: !!key,
    source: keySource(),
    last4: key ? key.slice(-4) : null,
    agentReady: mcpClient !== null,
  }
}

// Cheap liveness probe — confirm a key actually authenticates before accepting it.
export async function validateKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const probe = new Anthropic({ apiKey: key })
    await probe.messages.create({
      model: env().CLAUDE_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    })
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'validation failed' }
  }
}

// Set the key in the running system. Updates the in-memory override and, when
// persist is set and ANTHROPIC_API_KEY_FILE is configured, writes the key file
// 0600 so it survives a restart (and is picked up by file-resolve). If the agent
// was never initialised (no key at boot), connect it now so /api/ask comes alive.
export async function setAnthropicKey(
  key: string,
  opts: { persist?: boolean } = {},
): Promise<ReturnType<typeof getKeyStatus> & { persisted: boolean }> {
  runtimeKeyOverride = key
  let persisted = false
  const f = process.env.ANTHROPIC_API_KEY_FILE
  if (opts.persist && f) {
    writeFileSync(f, key, { mode: 0o600 })
    persisted = true
  }
  if (!mcpClient) {
    try {
      await initAgent()
    } catch (err) {
      console.warn('[agent] initAgent after key set failed:', (err as Error).message)
    }
  }
  return { ...getKeyStatus(), persisted }
}

// ---------- Tool-result sizing & steering (prompt-too-long defence) ----------
// The askBar's document tools (query_by_template/list_documents/query_documents/
// get_document) return full data.body fields; for a "find all cases about X"
// intent the model can dump dozens of full docs into the context and blow the
// 200k window. Three defences: (A) a standing system-prompt policy, (B) a
// per-turn recency nudge on the first (decisive) tool choice, and a hard
// per-result cap as the guaranteed backstop since A/B are only steering.

const QUERY_TOOL_POLICY = `TOOL-USE POLICY — keep results small (context window is 200k tokens):
- To find / list / count / filter documents (e.g. "all cases about X"), use run_report_query
  with an EXPLICIT, NARROW column list, e.g.:
    SELECT case_number, title, status, component FROM doc_case_record
    WHERE body ILIKE '%synonym%' ORDER BY case_number LIMIT 100
  NEVER "SELECT *", and NEVER select large free-text columns (body, content, snippet).
  Call list_report_tables first if you need the column names.
- To find passages or rank by relevance, use search (FTS) — it returns short ranked
  snippets, not whole documents.
- Use get_document / query_by_template / list_documents ONLY to fetch ONE specific
  document the user named — never to enumerate many; those return full bodies.
- When the user asks "how many" / "which", prefer COUNT / GROUP BY over row dumps,
  and always add LIMIT.`

const QUERY_TOOL_HINT = `[Answer using run_report_query with an explicit small column list `
  + `(never SELECT *, never body) for find/list/count, or search() for snippets; do not `
  + `enumerate many documents with query_by_template/list_documents. Add LIMIT.]`

// Hard cap on any single tool result (~6k tokens). Bounds whatever tool the model
// picks, regardless of the steering above.
const MAX_TOOL_RESULT_CHARS = 24_000

function capToolResult(s: string): string {
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s
  const dropped = s.length - MAX_TOOL_RESULT_CHARS
  return `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${dropped} chars — result too large. `
    + `Narrow it: select fewer columns, add WHERE/LIMIT, or use search() for snippets.]`
}

// Only expose read/query tools — no create, delete, or admin tools
const ALLOWED_TOOLS = new Set([
  'get_wip_status',
  'describe_data_model',
  'search',
  'search_registry',
  'list_namespaces',
  'get_namespace_stats',
  'list_terminologies',
  'get_terminology',
  'get_terminology_by_value',
  'list_terms',
  'get_term',
  'validate_term_value',
  'get_term_hierarchy',
  'list_templates',
  'get_template',
  'get_template_by_value',
  'get_template_fields',
  'list_documents',
  'get_document',
  'query_documents',
  'query_by_template',
  'get_document_versions',
  'get_file_metadata',
  'list_report_tables',
  'run_report_query',
])

// ---------- Session management ----------

interface Session {
  messages: Anthropic.MessageParam[]
  lastAccess: number
}

const sessions = new Map<string, Session>()

setInterval(() => {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > env().SESSION_TTL_MS) {
      sessions.delete(id)
    }
  }
}, 60_000)

// ---------- MCP connection ----------

function createTransport() {
  const e = env()
  if (e.MCP_URL) {
    const url = new URL(e.MCP_URL)
    // Inject WIP_API_KEY on every request so the MCP server's auth check passes.
    // The MCP SDK's transports don't carry any auth on their own — caller responsibility.
    const headers: Record<string, string> = {}
    if (e.WIP_API_KEY) headers['X-API-Key'] = e.WIP_API_KEY
    if (e.MCP_TRANSPORT === 'sse' || e.MCP_URL.endsWith('/sse')) {
      return new SSEClientTransport(url, {
        requestInit: { headers },
        eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...init?.headers, ...headers } }) },
      })
    }
    // Default to Streamable HTTP for remote URLs
    return new StreamableHTTPClientTransport(url, { requestInit: { headers } })
  }

  // Stdio: spawn local MCP server process
  const pythonPath = e.MCP_PYTHON || 'python'
  const cwd = e.MCP_CWD || process.cwd()
  return new StdioClientTransport({
    command: pythonPath,
    args: ['-m', e.MCP_MODULE],
    cwd,
    env: {
      ...process.env as Record<string, string>,
      WIP_API_KEY: process.env.WIP_API_KEY || 'dev_master_key_for_testing',
      WIP_MCP_MODE: 'readonly',
      PYTHONPATH: join(cwd, 'components/mcp-server/src'),
    },
  })
}

export async function initAgent() {
  if (!anthropicKey()) {
    console.warn('⚠ No Anthropic key (override/file/env) — /api/ask unavailable until one is set')
    return
  }

  const transport = createTransport()
  mcpClient = new Client({ name: 'wip-query-agent', version: '0.1.0' })
  await mcpClient.connect(transport)
  console.log('✓ MCP client connected')

  // Fetch and filter tools
  const toolsResult = await mcpClient.listTools()
  mcpTools = toolsResult.tools
    .filter(t => ALLOWED_TOOLS.has(t.name))
    .map(t => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }))
  console.log(`✓ ${mcpTools.length} tools available (filtered from ${toolsResult.tools.length})`)

  const realNames = new Set(toolsResult.tools.map(t => t.name))
  const stale = [...ALLOWED_TOOLS].filter(n => !realNames.has(n))
  if (stale.length > 0) {
    console.warn(`⚠ ${stale.length} whitelisted tool(s) not found on MCP surface (likely renamed upstream):`)
    for (const n of stale) console.warn(`    - ${n}`)
  }

  // Read the query assistant prompt resource for system prompt
  try {
    const resource = await mcpClient.readResource({ uri: 'wip://query-assistant-prompt' })
    systemPrompt = (resource.contents[0] as any)?.text || ''
    console.log(`✓ System prompt loaded from wip://query-assistant-prompt (${systemPrompt.length} chars)`)
  } catch {
    console.warn('⚠ Could not read wip://query-assistant-prompt — using fallback')
    systemPrompt = 'You are a helpful query assistant for a WIP data store. Use the available tools to answer questions about the data.'
  }

  // Append app-specific instructions if available
  try {
    const extra = readFileSync(join(__dirname, 'prompts', 'assistant.md'), 'utf-8')
    if (extra.trim()) {
      systemPrompt += '\n\n' + extra
    }
  } catch {
    // No app-specific prompt — that's fine
  }

  // (A) Standing tool-use policy — steer away from full-document dumps.
  systemPrompt += '\n\n' + QUERY_TOOL_POLICY

  // Two-namespace awareness (CASE-518): when a Library namespace is configured,
  // tell the model what each namespace holds and that it must pass `namespace`
  // to scope each tool call. Tool calls default to the corpus; a question about
  // the Technical Library (generated-from-code docs) needs namespace=<library>;
  // to cover both, query each. Namespace is clamped to these two server-side, so
  // the model can only reach the corpus and the Library.
  const e = env()
  if (e.KB_LIBRARY_NAMESPACE) {
    systemPrompt +=
      `\n\n## Namespaces\n` +
      `This KB spans two namespaces — pass \`namespace\` on every tool call to scope it:\n` +
      `- \`${e.WIP_NAMESPACE}\` (the **corpus**, default): cases, design decisions, lessons, ` +
      `firesides, journey entries, sessions, agent memory, git stats.\n` +
      `- \`${e.KB_LIBRARY_NAMESPACE}\` (the **Technical Library**): generated-from-code docs ` +
      `(template LIBRARY_DOC), organized by release line (e.g. wip-v1, wip-v2).\n` +
      `For a question about the Technical Library / generated API/CLI/lib/concept docs, pass ` +
      `namespace="${e.KB_LIBRARY_NAMESPACE}". For anything else, the corpus default applies. ` +
      `If a question could span both, run the query against each namespace and combine.`
  }
}

// ---------- Ask ----------

export async function ask(
  question: string,
  sessionId?: string,
): Promise<{ answer: string; toolCalls: number; sessionId: string }> {
  if (!mcpClient) {
    throw new Error('Agent not initialised — is ANTHROPIC_API_KEY set?')
  }

  const id = sessionId || crypto.randomUUID()
  let session = sessions.get(id)
  if (!session) {
    session = { messages: [], lastAccess: Date.now() }
    sessions.set(id, session)
  }
  session.lastAccess = Date.now()

  // Add user message. (B) Prepend the steering hint so it sits closest to the
  // model's decisive FIRST tool choice (search/SQL vs full-document dump).
  session.messages.push({ role: 'user', content: `${QUERY_TOOL_HINT}\n\n${question}` })

  const e = env()
  const anthropic = new Anthropic({ apiKey: anthropicKey() })
  let totalToolCalls = 0

  // Prompt-caching: system prompt + tool definitions are static across all askBar
  // requests in a session. Marking the last tool with cache_control extends the
  // cache breakpoint over the entire tools array, so multi-turn tool-loop
  // conversations within the 5-minute TTL hit cache from turn 2 onward.
  const cachedTools: Anthropic.Tool[] =
    mcpTools.length > 0
      ? [
          ...mcpTools.slice(0, -1),
          { ...mcpTools[mcpTools.length - 1]!, cache_control: { type: 'ephemeral' } },
        ]
      : mcpTools

  for (let turn = 0; turn < e.MAX_TURNS; turn++) {
    let response: Anthropic.Message
    try {
      response = await anthropic.messages.create({
        model: e.CLAUDE_MODEL,
        max_tokens: 4096,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        tools: cachedTools,
        messages: session.messages,
      })
    } catch (err: any) {
      if (/prompt is too long|too many tokens|context.*length|exceeds.*context/i.test(err?.message || '')) {
        // Context overflowed despite the per-result cap. Reset the session so the
        // next question starts clean, and return a clear, non-fatal message.
        sessions.delete(id)
        return {
          answer: 'That pulled back more data than fits in one context. Narrow it — ask for a count, '
            + 'filter by component/status, or search for a specific term — then try again.',
          toolCalls: totalToolCalls,
          sessionId: id,
        }
      }
      throw err
    }

    if (response.stop_reason === 'end_turn' || response.stop_reason !== 'tool_use') {
      // Extract text from response
      const answer = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n')

      session.messages.push({ role: 'assistant', content: response.content })
      return { answer, toolCalls: totalToolCalls, sessionId: id }
    }

    // Handle tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = []

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      totalToolCalls++

      const args = block.input as Record<string, unknown>

      // Scope each tool call to a configured namespace (CASE-518). The model may
      // choose `namespace` per call (corpus vs Technical Library — see the system
      // prompt); we respect a valid choice and otherwise default to the corpus.
      // The choice is CLAMPED to the configured set so the agent can't reach other
      // namespaces on the instance (the privileged key is cross-namespace).
      if (e.WIP_NAMESPACE) {
        const toolDef = mcpTools.find(t => t.name === block.name)
        const props = (toolDef?.input_schema as any)?.properties || {}
        const accepts = (args && 'namespace' in args) || 'namespace' in props
        if (accepts) {
          const allowed = [e.WIP_NAMESPACE, e.KB_LIBRARY_NAMESPACE].filter(Boolean)
          const chosen = args?.namespace
          args.namespace =
            typeof chosen === 'string' && allowed.includes(chosen) ? chosen : e.WIP_NAMESPACE
        }
      }

      try {
        const result = await mcpClient!.callTool({ name: block.name, arguments: args })
        const raw = typeof result.content === 'string'
          ? result.content
          : JSON.stringify(result.content)
        if (raw.length > MAX_TOOL_RESULT_CHARS) {
          console.warn(`[agent] tool ${block.name} → ${raw.length} chars (capped to ${MAX_TOOL_RESULT_CHARS})`)
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: capToolResult(raw),
          is_error: result.isError === true,
        })
      } catch (err: any) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Tool error: ${err.message}`,
          is_error: true,
        })
      }
    }

    // Feed tool results back
    session.messages.push({ role: 'assistant', content: response.content })
    session.messages.push({ role: 'user', content: toolResults })
  }

  return {
    answer: 'Reached maximum number of tool-call turns. Try a more specific question.',
    toolCalls: totalToolCalls,
    sessionId: id,
  }
}

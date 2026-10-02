#!/usr/bin/env node
// A dependency-free stdio MCP server for end-to-end tests.
//
// Transport: JSON-RPC 2.0, one message per line on stdin/stdout (what Pi's
// @earendil-works/pi-mcp StdioTransport speaks). Handshake: `initialize` →
// result with protocolVersion/capabilities/serverInfo, then the client's
// `notifications/initialized` notification.
//
// Tools:
//   echo        { text }        readOnlyHint   → "echo: <text>"
//   danger      { target }      destructiveHint → "danger executed on <target>"
//   write_note  { path, text }                  → writes the file (relative to cwd)
//
// Every tools/call is appended as one JSON line {tool, args} to $FAKE_MCP_LOG
// *before* it runs, so a test can assert that a tool executed zero times.
//
// Server name: $FAKE_MCP_NAME or the first CLI argument (default "fake").

import { appendFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const NAME = process.env.FAKE_MCP_NAME || process.argv[2] || 'fake'
const LOG = process.env.FAKE_MCP_LOG
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the given text back. Read-only.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to echo' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'danger',
    description: 'Irreversibly destroy the named target.',
    inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'What to destroy' } } },
    annotations: { destructiveHint: true },
  },
  {
    name: 'write_note',
    description: 'Write a note to a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'] },
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function text(t, isError = false) {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) }
}

function callTool(name, args) {
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ tool: name, args })}\n`)
  switch (name) {
    case 'echo':
      return text(`echo: ${String(args.text ?? '')}`)
    case 'danger':
      return text(`danger executed on ${String(args.target ?? '?')}`)
    case 'write_note': {
      const path = resolve(process.cwd(), String(args.path ?? 'note.txt'))
      writeFileSync(path, String(args.text ?? ''))
      return text(`wrote ${path}`)
    }
    default:
      return undefined
  }
}

function handle(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return
  const { id, method, params } = message
  // Responses to requests we never sent, and notifications: nothing to answer.
  if (id === undefined || id === null) return
  if (typeof method !== 'string') return
  switch (method) {
    case 'initialize': {
      const wanted = params?.protocolVersion
      reply(id, {
        protocolVersion: SUPPORTED.includes(wanted) ? wanted : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: '1.0.0' },
        instructions: `Fake MCP server "${NAME}" for Runway tests.`,
      })
      return
    }
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, { tools: TOOLS })
      return
    case 'tools/call': {
      const result = callTool(String(params?.name ?? ''), params?.arguments ?? {})
      if (!result) fail(id, -32602, `Unknown tool: ${params?.name}`)
      else reply(id, result)
      return
    }
    default:
      fail(id, -32601, `Method not found: ${method}`)
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      continue
    }
    try {
      handle(message)
    } catch (error) {
      if (message && message.id !== undefined) fail(message.id, -32603, error instanceof Error ? error.message : String(error))
    }
  }
})
process.stdin.on('end', () => process.exit(0))

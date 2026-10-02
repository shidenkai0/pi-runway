import { toolGrantable } from './operation.ts'
import type { Operation } from './operation.ts'

// A person's approvals that last for a session. They live in memory only, are keyed by
// session id, and are never shared between unrelated sessions. A subagent's
// session sees its parent's grants (one-way, read-only inheritance); grants
// made while a subagent asked stay with that subagent. Forked and new
// sessions start empty; resuming a session that was open earlier in this Pi
// process finds its grants again.

export type GrantScope = 'operation' | 'tool'

export interface Grant {
  id: string
  sessionId: string
  scope: GrantScope
  /** Operation key (scope operation) or tool name (scope tool). */
  key: string
  /** What people see: `npm test`, `all bash commands`. */
  label: string
  tool: string
  by: 'person'
  at: number
}

let counter = 0

export class GrantStore {
  private readonly bySession = new Map<string, Grant[]>()
  private readonly parents = new Map<string, string>()

  setParent(child: string, parent: string): void {
    if (child === parent) return
    // Refuse cycles: a session can't become its own ancestor.
    for (let p: string | undefined = parent; p; p = this.parents.get(p)) if (p === child) return
    this.parents.set(child, parent)
  }

  parentOf(sessionId: string): string | undefined {
    return this.parents.get(sessionId)
  }

  /** This session, then its parent, grandparent… */
  lineage(sessionId: string): string[] {
    const chain: string[] = []
    for (let s: string | undefined = sessionId; s && chain.length < 16; s = this.parents.get(s)) chain.push(s)
    return chain
  }

  add(sessionId: string, grant: Omit<Grant, 'id' | 'sessionId' | 'at'>): Grant {
    const full: Grant = { ...grant, id: `g${++counter}`, sessionId, at: Date.now() }
    const list = this.bySession.get(sessionId) ?? []
    if (!list.some(g => g.scope === full.scope && g.key === full.key)) list.push(full)
    this.bySession.set(sessionId, list)
    return full
  }

  /**
   * A person's grant that covers this operation in this session or an ancestor.
   * Whole-tool grants only cover calls inside the normal fence: never a command
   * outside the sandbox or one asking for extra write folders or hosts.
   */
  findPersonGrant(sessionId: string, op: Operation, scope: GrantScope): Grant | undefined {
    for (const s of this.lineage(sessionId)) {
      for (const g of this.bySession.get(s) ?? []) {
        if (g.scope !== scope) continue
        if (scope === 'operation' && g.key === op.key) return g
        if (scope === 'tool' && g.key === op.tool && toolGrantable(op)) return g
      }
    }
    return undefined
  }

  own(sessionId: string): Grant[] {
    return [...(this.bySession.get(sessionId) ?? [])]
  }

  inherited(sessionId: string): Grant[] {
    return this.lineage(sessionId).slice(1).flatMap(s => this.bySession.get(s) ?? [])
  }

  revoke(sessionId: string, id: string): boolean {
    const list = this.bySession.get(sessionId)
    if (!list) return false
    const next = list.filter(g => g.id !== id)
    this.bySession.set(sessionId, next)
    return next.length !== list.length
  }

  reset(sessionId: string): number {
    const n = this.bySession.get(sessionId)?.length ?? 0
    this.bySession.delete(sessionId)
    return n
  }

  clear(): void {
    this.bySession.clear()
    this.parents.clear()
  }
}

/**
 * JumpAI — DOM Discovery & Extraction Debugger Engine
 *
 * Scans live Claude DOM to surface:
 *  - Real message container candidates
 *  - Per-node metadata (role, depth, selector, text length)
 *  - Selector tier results
 *  - Structural pattern analysis (repeated wrappers, shared parents)
 *  - Extraction snapshots for drift comparison
 *
 * This module is PURELY for debugging. No extraction logic lives here.
 * It reads the DOM and returns structured data — overlays are handled separately.
 */

import {
  isHidden,
  isInSidebar,
  inferRole,
  MESSAGE_SELECTOR_CHAIN,
  discoverWithFallbackChain,
  type DiscoveredNode,
} from "./dom-resilience"

// ─── Types ────────────────────────────────────────────────────────────────────

export type CandidateType =
  | "assistant"
  | "user"
  | "unknown"
  | "rejected-noise"
  | "rejected-hidden"
  | "rejected-sidebar"
  | "rejected-short"
  | "rejected-extension"

export interface CandidateNode {
  el: Element
  type: CandidateType
  role: "user" | "assistant" | null
  selectorUsed: string
  textLength: number
  nodeDepth: number
  tagName: string
  classList: string
  dataAttrs: Record<string, string>
  textPreview: string
  domPath: string
  codeBlockCount: number
  isMarkdown: boolean
  hasProseWrapper: boolean
  parentTag: string
  childCount: number
  accepted: boolean
  rejectionReason: string | null
}

export interface SelectorTierResult {
  label: string
  selector: string
  matchCount: number
  acceptedCount: number
  confidence: "high" | "medium" | "low"
  examples: string[]  // first 3 text previews
}

export interface StructuralPattern {
  parentTag: string
  parentClass: string
  childCount: number
  occurrences: number
  likelyRole: "user" | "assistant" | "mixed" | "unknown"
}

export interface DebugSnapshot {
  id: string
  timestamp: number
  url: string
  totalScanned: number
  candidates: CandidateNode[]
  selectorResults: SelectorTierResult[]
  patterns: StructuralPattern[]
  acceptedCount: number
  rejectedCount: number
  assistantCount: number
  userCount: number
  duplicateCount: number
  dominantStrategy: string
}

export interface DiagnosticSummary {
  totalScanned: number
  candidateNodes: number
  acceptedNodes: number
  rejectedNodes: number
  duplicateNodes: number
  assistantCount: number
  userCount: number
  unknownRoleCount: number
  dominantStrategy: string
  selectorResults: SelectorTierResult[]
}

// ─── Extension UI Detection ───────────────────────────────────────────────────

function isExtensionUI(el: Element): boolean {
  let cur: Element | null = el
  while (cur && cur !== document.body) {
    const id = (cur.id || "").toLowerCase()
    const cls = (typeof cur.className === "string" ? cur.className : "").toLowerCase()
    if (
      id.includes("jumpai") ||
      id.includes("plasmo") ||
      cls.includes("jumpai") ||
      cur.tagName === "PLASMO-CSUI"
    ) return true
    cur = cur.parentElement
  }
  return false
}

// ─── Node Metadata Helpers ────────────────────────────────────────────────────

function getNodeDepth(el: Element): number {
  let depth = 0, cur: Element | null = el
  while (cur && cur !== document.body) { depth++; cur = cur.parentElement }
  return depth
}

function getDomPath(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  let depth = 0
  while (cur && cur !== document.body && depth < 6) {
    const tag = cur.tagName.toLowerCase()
    const id = cur.id ? `#${cur.id}` : ""
    const cls = typeof cur.className === "string" && cur.className
      ? `.${cur.className.trim().split(/\s+/).slice(0, 2).join(".")}`
      : ""
    parts.unshift(`${tag}${id}${cls}`)
    cur = cur.parentElement
    depth++
  }
  return parts.join(" > ")
}

function getDataAttrs(el: Element): Record<string, string> {
  const out: Record<string, string> = {}
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith("data-")) out[attr.name] = attr.value.slice(0, 80)
  }
  return out
}

function countCodeBlocks(el: Element): number {
  return el.querySelectorAll("pre, code").length
}

function hasMarkdown(el: Element): boolean {
  return !!(
    el.querySelector(".prose, .markdown, [class*='markdown'], [class*='prose']") ||
    el.querySelector("pre code, h1, h2, h3, ul, ol, blockquote")
  )
}

function hasProseWrapper(el: Element): boolean {
  return !!(el.querySelector(".prose") || el.closest(".prose"))
}

function getTextPreview(el: Element): string {
  const raw = (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? ""
  return raw.slice(0, 200).replace(/\s+/g, " ")
}

function getTextLength(el: Element): number {
  const raw = (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? ""
  return raw.length
}

// ─── NOISE_PHRASES (inline, same as extractor) ────────────────────────────────

const NOISE_PHRASES = new Set([
  "free plan", "pro plan", "team plan", "enterprise plan",
  "upgrade", "upgrade to pro", "upgrade plan", "upgrade now",
  "new chat", "new conversation",
  "recent conversations", "starred conversations",
  "search conversations", "search chats",
  "settings", "sign out", "sign in", "log in", "log out",
  "help", "help center", "documentation",
  "keyboard shortcuts", "shortcuts",
  "projects", "recents", "starred",
  "copy", "edit", "retry", "regenerate", "stop generating",
  "like", "dislike", "thumbs up", "thumbs down",
  "share", "export", "model:", "switch model",
  "back", "close", "cancel",
  "send message", "message claude",
  "claude.ai", "anthropic",
])

const NOISE_PATTERNS = [
  /^[\d,]+\s*tokens?$/i,
  /^\d+:\d+\s*(am|pm)?$/i,
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d+/i,
  /^\d+\s*\/\s*\d+$/,
  /^today$|^yesterday$/i,
  /^\$\d+\s*\/\s*(month|mo|yr|year)/i,
]

function isNoise(text: string): boolean {
  const t = text.trim()
  if (t.length < 3) return true
  const lo = t.toLowerCase()
  if (NOISE_PHRASES.has(lo)) return true
  if (NOISE_PATTERNS.some(r => r.test(t))) return true
  if (/^[A-Z\s]{3,20}$/.test(t) && t.split(" ").length <= 3) return true
  return false
}

// ─── Main Discovery Engine ────────────────────────────────────────────────────

/**
 * Scans ALL DOM nodes and classifies them as candidates.
 * This is intentionally broad — we want to see everything.
 */
export function discoverAllCandidates(): CandidateNode[] {
  const candidates: CandidateNode[] = []
  const seen = new Set<Element>()

  // Walk entire body
  const allEls = Array.from(document.body.querySelectorAll("*"))

  for (const el of allEls) {
    if (seen.has(el)) continue

    // Skip: extension UI
    if (isExtensionUI(el)) continue

    // Skip: tiny elements (unlikely to be message containers)
    const textLen = getTextLength(el)
    if (textLen < 20) continue

    // Skip: deeply nested leaf nodes with no children (just text nodes)
    if (el.children.length === 0 && textLen < 80) continue

    // ── Rejection checks ──
    let type: CandidateType = "unknown"
    let rejected = false
    let rejectionReason: string | null = null

    if (isHidden(el)) {
      type = "rejected-hidden"
      rejected = true
      rejectionReason = "hidden (display:none, visibility:hidden, or aria-hidden)"
    } else if (isInSidebar(el)) {
      type = "rejected-sidebar"
      rejected = true
      rejectionReason = "inside sidebar/navigation"
    } else if (isNoise(getTextPreview(el))) {
      type = "rejected-noise"
      rejected = true
      rejectionReason = "noise gate (UI phrase or pattern)"
    } else if (textLen < 20) {
      type = "rejected-short"
      rejected = true
      rejectionReason = "text too short (<20 chars)"
    } else {
      // Accepted candidate — classify role
      const role = inferRole(el)
      if (role === "user") type = "user"
      else if (role === "assistant") type = "assistant"
      else type = "unknown"
    }

    seen.add(el)

    candidates.push({
      el,
      type,
      role: type === "user" ? "user" : type === "assistant" ? "assistant" : null,
      selectorUsed: getBestMatchingSelector(el),
      textLength: textLen,
      nodeDepth: getNodeDepth(el),
      tagName: el.tagName.toLowerCase(),
      classList: typeof el.className === "string" ? el.className.slice(0, 120) : "",
      dataAttrs: getDataAttrs(el),
      textPreview: getTextPreview(el),
      domPath: getDomPath(el),
      codeBlockCount: countCodeBlocks(el),
      isMarkdown: hasMarkdown(el),
      hasProseWrapper: hasProseWrapper(el),
      parentTag: el.parentElement?.tagName.toLowerCase() ?? "",
      childCount: el.children.length,
      accepted: !rejected,
      rejectionReason,
    })
  }

  return candidates
}

/**
 * Returns the most specific matching selector from our chain for a given element.
 */
function getBestMatchingSelector(el: Element): string {
  for (const strategy of MESSAGE_SELECTOR_CHAIN) {
    if (el.matches(strategy.selector)) return strategy.label
  }
  // Check data attrs manually
  if (el.hasAttribute("data-message-author-role")) return "data-message-author-role"
  if (el.hasAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`
  if (el.querySelector(".prose")) return "contains-.prose"
  if (el.querySelector("pre, code")) return "contains-code"
  return el.tagName.toLowerCase()
}

// ─── Selector Tier Testing ────────────────────────────────────────────────────

export function runSelectorTierTests(): SelectorTierResult[] {
  const results: SelectorTierResult[] = []

  for (const strategy of MESSAGE_SELECTOR_CHAIN) {
    const matches = Array.from(document.querySelectorAll(strategy.selector))
      .filter(el => !isInSidebar(el) && !isHidden(el) && !isExtensionUI(el))

    const accepted = matches.filter(el => {
      const role = inferRole(el)
      const text = getTextPreview(el)
      return role !== null && !isNoise(text) && text.length >= 20
    })

    const examples = accepted.slice(0, 3).map(el => getTextPreview(el).slice(0, 80))

    results.push({
      label: strategy.label,
      selector: strategy.selector,
      matchCount: matches.length,
      acceptedCount: accepted.length,
      confidence: strategy.confidence,
      examples,
    })
  }

  return results
}

// ─── Structural Pattern Analysis ──────────────────────────────────────────────

export function analyzeStructuralPatterns(candidates: CandidateNode[]): StructuralPattern[] {
  const accepted = candidates.filter(c => c.accepted)
  if (accepted.length < 2) return []

  // Group by parent element characteristics
  const parentMap = new Map<string, { nodes: CandidateNode[]; parentEl: Element | null }>()

  for (const c of accepted) {
    const parent = c.el.parentElement
    const key = `${parent?.tagName?.toLowerCase() ?? "?"}::${
      typeof parent?.className === "string" ? parent.className.slice(0, 60) : ""
    }`
    if (!parentMap.has(key)) parentMap.set(key, { nodes: [], parentEl: parent })
    parentMap.get(key)!.nodes.push(c)
  }

  const patterns: StructuralPattern[] = []

  for (const [key, { nodes, parentEl }] of parentMap.entries()) {
    if (nodes.length < 2) continue  // Need at least 2 children to be a pattern

    const [parentTag, parentClass] = key.split("::")
    const userCount = nodes.filter(n => n.role === "user").length
    const assistantCount = nodes.filter(n => n.role === "assistant").length

    let likelyRole: StructuralPattern["likelyRole"] = "unknown"
    if (userCount > 0 && assistantCount > 0) likelyRole = "mixed"
    else if (userCount > 0) likelyRole = "user"
    else if (assistantCount > 0) likelyRole = "assistant"

    patterns.push({
      parentTag: parentTag ?? "?",
      parentClass: parentClass ?? "",
      childCount: parentEl?.children.length ?? nodes.length,
      occurrences: nodes.length,
      likelyRole,
    })
  }

  // Sort by occurrences (most repeated = most likely real containers)
  return patterns.sort((a, b) => b.occurrences - a.occurrences).slice(0, 10)
}

// ─── Deduplication (for accepted candidates) ──────────────────────────────────

export function deduplicateCandidates(candidates: CandidateNode[]): {
  unique: CandidateNode[]
  duplicateCount: number
} {
  const unique: CandidateNode[] = []
  let duplicateCount = 0

  for (const c of candidates) {
    if (!c.accepted) {
      unique.push(c)
      continue
    }
    const overlaps = unique.some(prev =>
      prev.accepted && (
        prev.el.contains(c.el) || c.el.contains(prev.el)
      )
    )
    if (overlaps) duplicateCount++
    else unique.push(c)
  }

  return { unique, duplicateCount }
}

// ─── Full Discovery Run ───────────────────────────────────────────────────────

export function runFullDiscovery(): DebugSnapshot {
  const t = Date.now()
  const allCandidates = discoverAllCandidates()
  const { unique, duplicateCount } = deduplicateCandidates(allCandidates)
  const selectorResults = runSelectorTierTests()
  const patterns = analyzeStructuralPatterns(unique)

  // Find dominant strategy (most accepted)
  const dominantResult = selectorResults
    .filter(r => r.acceptedCount > 0)
    .sort((a, b) => b.acceptedCount - a.acceptedCount)[0]

  const acceptedNodes = unique.filter(c => c.accepted)
  const rejectedNodes = unique.filter(c => !c.accepted)

  // Also run the actual fallback chain for ground truth
  const { strategyUsed } = discoverWithFallbackChain(document.body)

  return {
    id: `snap_${t}`,
    timestamp: t,
    url: window.location.href,
    totalScanned: allCandidates.length,
    candidates: unique,
    selectorResults,
    patterns,
    acceptedCount: acceptedNodes.length,
    rejectedCount: rejectedNodes.length,
    assistantCount: acceptedNodes.filter(c => c.role === "assistant").length,
    userCount: acceptedNodes.filter(c => c.role === "user").length,
    duplicateCount,
    dominantStrategy: dominantResult?.label ?? strategyUsed ?? "none",
  }
}

// ─── Snapshot Storage ─────────────────────────────────────────────────────────

const SNAPSHOT_KEY = "__jumpai_debug_snapshots__"

export function saveSnapshot(snap: DebugSnapshot): void {
  try {
    const raw = sessionStorage.getItem(SNAPSHOT_KEY)
    const existing: DebugSnapshot[] = raw ? JSON.parse(raw) : []
    // Keep only last 5 snapshots (store without DOM elements)
    const toStore = { ...snap, candidates: snap.candidates.map(c => ({ ...c, el: null as any })) }
    existing.unshift(toStore)
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(existing.slice(0, 5)))
  } catch { /* ignore */ }
}

export function loadSnapshots(): Omit<DebugSnapshot, "candidates">[] {
  try {
    const raw = sessionStorage.getItem(SNAPSHOT_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return []
}

// ─── Diagnostic Summary ───────────────────────────────────────────────────────

export function buildDiagnosticSummary(snap: DebugSnapshot): DiagnosticSummary {
  const accepted = snap.candidates.filter(c => c.accepted)
  const unknownRole = accepted.filter(c => c.role === null).length

  return {
    totalScanned: snap.totalScanned,
    candidateNodes: snap.candidates.length,
    acceptedNodes: snap.acceptedCount,
    rejectedNodes: snap.rejectedCount,
    duplicateNodes: snap.duplicateCount,
    assistantCount: snap.assistantCount,
    userCount: snap.userCount,
    unknownRoleCount: unknownRole,
    dominantStrategy: snap.dominantStrategy,
    selectorResults: snap.selectorResults,
  }
}

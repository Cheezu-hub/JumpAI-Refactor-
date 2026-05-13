/**
 * JumpAI — Dedicated Assistant Message Extractor
 *
 * WHY THIS EXISTS:
 * The generic discoverWithFallbackChain() stops at the FIRST selector tier that
 * returns ANY results. If that tier finds user messages but NOT assistant ones
 * (because Claude renders them in a structurally different way), all assistant
 * content is silently dropped.
 *
 * This module uses TWO completely independent extraction paths:
 *   extractUserMessages()      — plain text containers, short-medium length
 *   extractAssistantMessages() — markdown/prose/code blocks, long content
 *
 * The assistant path uses CONTENT HEURISTICS (not DOM role attributes) as
 * the primary signal, then validates with role inference as secondary.
 * This matches how Claude actually renders: assistant replies are always
 * wrapped in .prose / markdown containers with code blocks, headers, etc.
 */

import { isHidden, isInSidebar } from "./dom-resilience"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawMessageTwo {
  role: "user" | "assistant"
  content: string
  sourceStrategy: string
  nodeDepth: number
  el?: Element
}

export interface TwoPathResult {
  messages: RawMessageTwo[]
  userStrategy: string
  assistantStrategy: string
  userCount: number
  assistantCount: number
  warnings: string[]
}

// ─── Content Signals ──────────────────────────────────────────────────────────

/** Returns a 0–100 score for "how likely is this to be an assistant message". */
function assistantContentScore(el: Element): number {
  let score = 0
  const text = (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? ""

  if (text.length < 100) return 0      // Too short to be a real assistant reply
  if (text.length > 200) score += 20   // Long text = strong signal
  if (text.length > 800) score += 20

  // Code/technical content — Claude's replies almost always have these
  if (/\bconst\b|\bfunction\b|\bimport\b|\bexport\b|\breturn\b/.test(text)) score += 25
  if (/\bclass\b|\binterface\b|\btype\b/.test(text)) score += 10
  if (/\berror\b|\bwarning\b|\bfailed\b|\bfix\b|\bsolution\b/i.test(text)) score += 10
  if (/React|useState|useEffect|props|component/i.test(text)) score += 10

  // DOM structure signals
  if (el.querySelector("pre, code")) score += 25
  if (el.querySelector(".prose, .markdown, [class*='prose'], [class*='markdown']")) score += 30
  if (el.querySelector("h1, h2, h3, ul, ol, blockquote")) score += 15
  if (el.querySelector("pre > code")) score += 20  // fenced code = almost certainly assistant

  // Explicit class signals
  const cls = (typeof el.className === "string" ? el.className : "").toLowerCase()
  if (/prose|markdown|claude-message|assistant/i.test(cls)) score += 30
  if (/font-claude|font-message/i.test(cls)) score += 30

  // Data attributes
  const role = el.getAttribute("data-message-author-role") || el.getAttribute("data-author-role") || ""
  if (role === "assistant" || role === "ai" || role === "claude") score += 50
  if (role === "user" || role === "human") return 0  // Definitely not assistant

  return Math.min(score, 100)
}

/** Returns a 0–100 score for "how likely is this to be a user message". */
function userContentScore(el: Element): number {
  let score = 0
  const text = (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? ""

  if (text.length < 5) return 0
  if (text.length > 5000) return 0   // User prompts don't go this long typically
  if (text.length >= 10 && text.length <= 2000) score += 20

  // No complex markdown = more likely a user message
  if (!el.querySelector("pre, .prose, h1, h2, h3")) score += 15
  if (!el.querySelector("code")) score += 10

  // Explicit class signals
  const cls = (typeof el.className === "string" ? el.className : "").toLowerCase()
  if (/font-user|user-message|human-turn|from-user/i.test(cls)) score += 50
  if (/prose|markdown|claude-message|assistant/i.test(cls)) return 0

  // Data attributes
  const role = el.getAttribute("data-message-author-role") || el.getAttribute("data-author-role") || ""
  if (role === "user" || role === "human") score += 50
  if (role === "assistant" || role === "ai" || role === "claude") return 0

  return Math.min(score, 100)
}

// ─── Extraction Helpers ───────────────────────────────────────────────────────

function isExtensionNode(el: Element): boolean {
  let cur: Element | null = el
  while (cur && cur !== document.body) {
    if ((cur.id || "").includes("jumpai")) return true
    if (cur.tagName === "PLASMO-CSUI") return true
    cur = cur.parentElement
  }
  return false
}

function getNodeDepth(el: Element): number {
  let d = 0, cur: Element | null = el
  while (cur && cur !== document.body) { d++; cur = cur.parentElement }
  return d
}

function extractText(el: Element): string {
  const contentEl =
    el.querySelector("[data-message-content]") ||
    el.querySelector(".prose") ||
    el.querySelector(".font-claude-message") ||
    el.querySelector(".font-user-message") ||
    el

  const clone = contentEl.cloneNode(true) as Element

  // Strip UI chrome
  clone.querySelectorAll([
    "button", "[role='button']", "[aria-hidden='true']", "[hidden]", "svg",
    ".sr-only", ".hidden",
    "[data-testid*='copy']", "[data-testid*='edit']",
    "[data-testid*='retry']", "[data-testid*='vote']",
  ].join(",")).forEach(c => c.remove())

  // Fence code blocks
  clone.querySelectorAll("pre").forEach(pre => {
    const codeEl = pre.querySelector("code")
    const code = (codeEl || pre).textContent?.trim() ?? ""
    const lang = (codeEl || pre).className.match(/language-(\w+)/)?.[1] ?? ""
    pre.replaceWith(document.createTextNode(`\n\`\`\`${lang}\n${code}\n\`\`\`\n`))
  })

  return ((clone as HTMLElement).innerText ?? clone.textContent ?? "")
    .replace(/\u00a0/g, " ").replace(/\u200b/g, "")
    .replace(/[ \t]{3,}/g, "  ").replace(/\n{4,}/g, "\n\n\n").trim()
}

function isDuplicate(el: Element, others: Element[]): boolean {
  return others.some(o => o.contains(el) || el.contains(o))
}

// ─── USER Path ────────────────────────────────────────────────────────────────

/**
 * Extracts user messages using explicit selectors first,
 * then falls back to content scoring.
 */
export function extractUserMessages(): { nodes: Element[]; strategy: string } {
  const USER_SELECTORS = [
    "[data-message-author-role='user']",
    "[data-author-role='user']",
    "[data-message-author-role='human']",
    "[aria-label*='Human turn']",
    "[data-testid*='human-turn']",
    ".font-user-message",
    "[class*='user-turn']",
    "[class*='human-turn']",
  ]

  // Try explicit selectors first
  for (const sel of USER_SELECTORS) {
    const matches = Array.from(document.querySelectorAll(sel))
      .filter(el => !isHidden(el) && !isInSidebar(el) && !isExtensionNode(el))

    if (matches.length > 0) {
      return { nodes: matches, strategy: `explicit:${sel}` }
    }
  }

  // Content-score fallback: find elements scoring > 30 for user
  const all = Array.from(document.body.querySelectorAll("div, p, article, section"))
    .filter(el => !isHidden(el) && !isInSidebar(el) && !isExtensionNode(el))

  const scored = all
    .map(el => ({ el, score: userContentScore(el) }))
    .filter(x => x.score >= 30)
    .sort((a, b) => b.score - a.score)

  const deduped: Element[] = []
  for (const { el } of scored) {
    if (!isDuplicate(el, deduped)) deduped.push(el)
  }

  return { nodes: deduped, strategy: "content-score:user" }
}

// ─── ASSISTANT Path ───────────────────────────────────────────────────────────

/**
 * Extracts assistant messages using explicit selectors first,
 * then falls back to content heuristics (long text + code/markdown signals).
 *
 * This is the path that was silently failing — Claude renders assistant
 * replies with .prose wrappers and code blocks which aren't matched by
 * simple role attribute checks when the attribute is missing/different.
 */
export function extractAssistantMessages(): { nodes: Element[]; strategy: string } {
  const ASSISTANT_SELECTORS = [
    "[data-message-author-role='assistant']",
    "[data-author-role='assistant']",
    "[data-message-author-role='ai']",
    "[aria-label*='Assistant turn']",
    "[data-testid*='assistant-turn']",
    ".font-claude-message",
    "[class*='assistant-turn']",
    "[class*='claude-turn']",
    // Prose containers — Claude ALWAYS wraps assistant content in one of these
    "div.prose",
    "[class*='prose']",
  ]

  // ─── Combined Assistant Discovery ───
  const matches: Element[] = []
  
  // 1. Try explicit selectors
  for (const sel of ASSISTANT_SELECTORS) {
    const els = Array.from(document.querySelectorAll(sel))
      .filter(el => {
        if (isHidden(el) || isInSidebar(el) || isExtensionNode(el)) return false
        const text = (el as HTMLElement).innerText?.trim() ?? ""
        return text.length >= 80
      })
    matches.push(...els)
  }

  // 2. Combine with content heuristic fallback
  const all = Array.from(document.body.querySelectorAll("div, article, section, main"))
    .filter(el => !isHidden(el) && !isInSidebar(el) && !isExtensionNode(el))

  const highScoring = all
    .map(el => ({ el, score: assistantContentScore(el) }))
    .filter(x => x.score >= 40) // Any node with significant signal
    .map(x => x.el)
  
  matches.push(...highScoring)

  // 3. Deduplicate (keep the most specific containers that contain content)
  const finalNodes: Element[] = []
  // Sort by text length ASCENDING so we process smaller (more granular) nodes first
  const sortedMatches = matches.sort((a, b) => 
    ((a as HTMLElement).innerText?.length || 0) - ((b as HTMLElement).innerText?.length || 0)
  )

  for (const el of sortedMatches) {
    // Skip massive page wrappers that accidentally got a high score
    if (((el as HTMLElement).innerText?.length || 0) > 15000) continue;

    // If this element contains something we already found, or is contained by it, 
    // we just need one of them. Prefer the one with more technical/assistant signals.
    const existingIdx = finalNodes.findIndex(prev => prev.contains(el) || el.contains(prev))
    if (existingIdx === -1) {
      finalNodes.push(el)
    } else {
      // If redundant, swap if this one has a noticeably higher score (e.g. +20)
      if (assistantContentScore(el) > assistantContentScore(finalNodes[existingIdx]) + 20) {
        finalNodes[existingIdx] = el
      }
    }
  }

  if (finalNodes.length > 0) {
    return { nodes: finalNodes, strategy: "combined-discovery" }
  }

  // Last resort: any element with pre>code that's long enough
  const codeBlocks = Array.from(document.querySelectorAll("pre"))
    .filter(el => !isHidden(el) && !isInSidebar(el) && !isExtensionNode(el))
    .map(pre => {
      // Walk up to find the wrapper
      let cur: Element | null = pre.parentElement
      let depth = 0
      while (cur && depth < 6) {
        const text = (cur as HTMLElement).innerText?.trim() ?? ""
        if (text.length > 200) return cur
        cur = cur.parentElement
        depth++
      }
      return pre
    })

  const dedupedCode: Element[] = []
  for (const el of codeBlocks) {
    if (!isDuplicate(el, dedupedCode)) dedupedCode.push(el)
  }

  return { nodes: dedupedCode, strategy: "code-block-walk" }
}

// ─── Two-Path Merge ───────────────────────────────────────────────────────────

/**
 * Runs both extraction paths independently and merges by DOM order.
 *
 * This is the replacement for the generic discoverWithFallbackChain()
 * when that chain returns 0 assistant messages.
 */
export function runTwoPathExtraction(): TwoPathResult {
  const warnings: string[] = []

  const { nodes: userNodes, strategy: userStrat } = extractUserMessages()
  const { nodes: assistantNodes, strategy: assistStrat } = extractAssistantMessages()

  if (userNodes.length === 0) warnings.push("Two-path: 0 user nodes found")
  if (assistantNodes.length === 0) warnings.push("Two-path: 0 assistant nodes found — DOM structure may have changed significantly")

  // FIX: Claude's assistant responses contain many generic <p> tags that the user
  // heuristic accidentally scores highly. If a user node is inside an assistant node, ignore it.
  const realUserNodes = userNodes.filter(uNode => 
    !assistantNodes.some(aNode => aNode.contains(uNode))
  )

  // Build typed list
  const all: RawMessageTwo[] = [
    ...realUserNodes.map(el => ({
      role: "user" as const,
      content: extractText(el),
      sourceStrategy: userStrat,
      nodeDepth: getNodeDepth(el),
      el,
    })),
    ...assistantNodes.map(el => ({
      role: "assistant" as const,
      content: extractText(el),
      sourceStrategy: assistStrat,
      nodeDepth: getNodeDepth(el),
      el,
    })),
  ]

  // Filter empty / noise content
  const filtered = all.filter(m => m.content.length >= 5)

  // Sort by DOM position
  filtered.sort((a, b) => {
    if (!a.el || !b.el) return 0
    const pos = a.el.compareDocumentPosition(b.el)
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1
    return 0
  })

  const userCount = filtered.filter(m => m.role === "user").length
  const assistantCount = filtered.filter(m => m.role === "assistant").length

  if (assistantCount === 0 && userCount > 0) {
    warnings.push(`Two-path: found ${userCount} user messages but 0 assistant — content heuristic scored nothing ≥40`)
  }

  return {
    messages: filtered,
    userStrategy: userStrat,
    assistantStrategy: assistStrat,
    userCount,
    assistantCount,
    warnings,
  }
}

// ─── Live DOM Scan (for Debugger UI) ─────────────────────────────────────────

export interface AssistantScanResult {
  el: Element
  score: number
  reason: string[]
  textPreview: string
  textLength: number
  hasCode: boolean
  hasProse: boolean
}

/**
 * Raw scan exposing every element's assistant score ≥ 25.
 * Used by ExtractionDebugger "Assistant Scan" view.
 */
export function scanForAssistantCandidates(): AssistantScanResult[] {
  const all = Array.from(document.body.querySelectorAll("div, article, section, main"))
    .filter(el => !isHidden(el) && !isInSidebar(el) && !isExtensionNode(el))

  const results: AssistantScanResult[] = []

  for (const el of all) {
    const text = (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? ""
    if (text.length < 80) continue

    const score = assistantContentScore(el)
    if (score < 25) continue

    const reason: string[] = []
    if (text.length > 200) reason.push(`long text (${text.length}ch)`)
    if (el.querySelector("pre, code")) reason.push("has code blocks")
    if (el.querySelector(".prose, [class*='prose']")) reason.push("has .prose")
    if (el.querySelector("h1,h2,h3,ul,ol,blockquote")) reason.push("has markdown structure")
    const role = el.getAttribute("data-message-author-role") || el.getAttribute("data-author-role")
    if (role) reason.push(`role="${role}"`)
    const cls = typeof el.className === "string" ? el.className : ""
    if (/prose|claude|assistant/i.test(cls)) reason.push(`class="${cls.slice(0, 40)}"`)

    results.push({
      el,
      score,
      reason,
      textPreview: text.slice(0, 160),
      textLength: text.length,
      hasCode: !!el.querySelector("pre, code"),
      hasProse: !!el.querySelector(".prose, [class*='prose']"),
    })
  }

  // Sort by score desc, then deduplicate containers
  results.sort((a, b) => b.score - a.score)
  const deduped: AssistantScanResult[] = []
  for (const r of results) {
    if (!deduped.some(d => d.el.contains(r.el) || r.el.contains(d.el))) {
      deduped.push(r)
    }
  }

  return deduped
}

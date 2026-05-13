/**
 * JumpAI V2 — Claude Conversation Extractor
 *
 * Hardened against Claude SPA DOM instability via lib/dom-resilience.ts:
 *  - Selector fallback chains (7 tiers + structural inference)
 *  - Hydration stabilization (MutationObserver settle detection)
 *  - Virtualized scroll recovery with snapshot merging
 *  - DOM anomaly detection (selector drift, count drops)
 *  - Retry pipeline (up to 3 attempts with backoff)
 *
 * No fake scores. No placeholder diagnostics.
 */

import {
  ExtractionLogger,
  type ExtractionDiagnosticReport,
  type NodeSnapshot,
} from "./extraction-logger"

import {
  findScrollContainer,
  discoverWithFallbackChain,
  deduplicateNodes,
  sortByDOMOrder,
  scrollRecovery,
  waitForDOMSettle,
  waitForConversationRoot,
  checkDOMHealth,
  detectSelectorDrift,
  recordSuccessfulSelector,
  withRetry,
  mergeOptions,
  isHidden,
  isInSidebar,
  type DiscoveredNode,
  type ResilienceOptions,
} from "./dom-resilience"

import { runTwoPathExtraction } from "./assistant-extractor"

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface RawMessage {
  role: "user" | "assistant"
  content: string
}

export interface ExtractionProgress {
  stage: string
  totalFound: number
  userCount: number
  assistantCount: number
  codeBlockCount: number
  durationMs: number
}

export interface ExtractionResult {
  messages: RawMessage[]
  strategy: string
  warnings: string[]
  debugDump: string
  diagnostics: ExtractionDiagnosticReport
}

// ─── Noise Gate ───────────────────────────────────────────────────────────────

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

// ─── Content Extraction ───────────────────────────────────────────────────────

function extractContent(el: Element): string {
  // Try to locate the prose/content sub-element first
  const contentEl =
    el.querySelector("[data-message-content]") ||
    el.querySelector(".prose") ||
    el.querySelector(".font-claude-message") ||
    el.querySelector(".font-user-message") ||
    el

  const clone = contentEl.cloneNode(true) as Element

  // Remove UI chrome from clone
  clone.querySelectorAll([
    "button", "[role='button']", "[aria-hidden='true']", "[hidden]", "svg",
    ".sr-only", ".hidden",
    "[data-testid*='copy']", "[data-testid*='edit']",
    "[data-testid*='retry']", "[data-testid*='vote']",
    ".feedback-buttons", ".message-actions",
  ].join(",")).forEach(c => c.remove())

  // Convert <pre> blocks to fenced markdown before stripping
  clone.querySelectorAll("pre").forEach(pre => {
    const codeEl = pre.querySelector("code")
    const code = (codeEl || pre).textContent?.trim() || ""
    const cls = (codeEl || pre).className || ""
    const langMatch = cls.match(/language-(\w+)/)
    const lang = langMatch ? langMatch[1] : ""
    pre.replaceWith(document.createTextNode(`\n\`\`\`${lang}\n${code}\n\`\`\`\n`))
  })

  const raw = (clone as HTMLElement).innerText ?? clone.textContent ?? ""
  return raw
    .replace(/\u00a0/g, " ")
    .replace(/\u200b/g, "")
    .replace(/[ \t]{3,}/g, "  ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
}

function parseCodeBlocks(content: string): { count: number; languages: string[]; malformed: number } {
  const openFences = (content.match(/^```/gm) || []).length
  const closeFences = (content.match(/^```\s*$/gm) || []).length
  const languages: string[] = []
  const langRe = /```(\w+)/g
  let m: RegExpExecArray | null
  while ((m = langRe.exec(content)) !== null) {
    if (m[1] && !languages.includes(m[1])) languages.push(m[1])
  }
  return { count: openFences, languages, malformed: Math.abs(openFences - closeFences) }
}

function fingerprint(role: string, content: string): string {
  return role + ":" + content.slice(0, 120).replace(/\s+/g, " ").trim()
}

function getNodeDepth(el: Element): number {
  let depth = 0, cur: Element | null = el
  while (cur && cur !== document.body) { depth++; cur = cur.parentElement }
  return depth
}

function getDataAttrs(el: Element): Record<string, string> {
  const out: Record<string, string> = {}
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith("data-")) out[attr.name] = attr.value.slice(0, 60)
  }
  return out
}

// ─── Core Extraction Attempt ──────────────────────────────────────────────────

interface ExtractionAttemptResult {
  messages: RawMessage[]
  strategy: string
  warnings: string[]
  logger: ExtractionLogger
}

async function runExtractionAttempt(
  attemptNum: number,
  seen: Set<string>,
  allMessages: RawMessage[],
  opts: Required<ResilienceOptions>,
  emit: (stage: string, total: number) => void,
  logger: ExtractionLogger
): Promise<{ added: number; strategy: string; warnings: string[] }> {
  const warnings: string[] = []
  let strategyUsed = "none"

  // ── Phase 1: Hydration wait ────────────────────────────────────────────────
  emit("Waiting for hydration", allMessages.length)
  logger.hydrationCheck(attemptNum)

  const CONVERSATION_ROOTS = [
    "[data-message-author-role]",
    "[data-testid='conversation-turn']",
    "[aria-label*='turn']",
    "main",
    "[role='main']",
  ]

  const rootFound = await waitForConversationRoot(CONVERSATION_ROOTS, opts.hydrationTimeoutMs)
  if (rootFound) {
    logger.hydrationOk()
    // Wait for DOM to fully settle after hydration
    await waitForDOMSettle(document.body, opts.settleMs, 2000)
  } else {
    logger.hydrationTimeout(opts.hydrationTimeoutMs)
    warnings.push(`Hydration timeout after ${opts.hydrationTimeoutMs}ms — page may still be loading`)
  }

  // ── Phase 2: Locate scroll container ──────────────────────────────────────
  emit("Locating scroll container", allMessages.length)
  const containerResult = findScrollContainer()

  if (!containerResult) {
    logger.containerMissing([
      "[role='main']", "main", "div.flex-1.overflow-y-auto",
      "computed-overflow-fallback",
    ])
    warnings.push("No scroll container found. DOM structure may have changed.")
    return { added: 0, strategy: "none", warnings }
  }

  logger.containerFound(
    containerResult.strategyUsed,
    containerResult.isFallback,
    containerResult.el
  )

  if (containerResult.isFallback) {
    logger.virtualizationWarning(
      `Fallback scroll container used (${containerResult.strategyUsed}) — primary selectors did not match`
    )
  }

  const container = containerResult.el

  // ── Phase 3: DOM health check ──────────────────────────────────────────────
  const health = checkDOMHealth(container)
  for (const anomaly of health.anomalies) {
    logger.mutationWarning(anomaly)
    warnings.push(anomaly)
  }

  if (!health.isHydrated) {
    warnings.push("Container appears unhydrated — waiting an extra 800ms")
    await new Promise(r => setTimeout(r, 800))
    await waitForDOMSettle(container, opts.settleMs, 1500)
  }

  // ── Phase 4: Initial message discovery ────────────────────────────────────
  emit("Discovering messages", allMessages.length)

  const addBatch = (nodes: DiscoveredNode[]): number => {
    let added = 0
    const sorted = sortByDOMOrder(deduplicateNodes(nodes))

    for (let i = sorted.length - 1; i >= 0; i--) {
      const { el, role, strategyUsed: sUsed, confidence } = sorted[i]
      const content = extractContent(el)

      if (!content || content.length < 5) {
        logger.messageMalformed("Content too short or empty after extraction")
        logger.messageRejected(
          "empty or too short",
          content.slice(0, 80),
          el.tagName + (el.id ? `#${el.id}` : "")
        )
        continue
      }

      if (isNoise(content)) {
        logger.messageRejected(
          "noise gate",
          content.slice(0, 80),
          el.getAttribute("data-testid") || el.tagName
        )
        continue
      }

      const key = fingerprint(role, content)
      if (seen.has(key)) {
        logger.messageDuplicate(role, key)
        continue
      }

      seen.add(key)

      const { count: cbCount, languages, malformed: cbMalformed } = parseCodeBlocks(content)
      if (cbMalformed > 0) logger.codeBlockMalformed(`${cbMalformed} unclosed fence(s) in ${role} message`)

      if (confidence === "low") {
        warnings.push(`Low-confidence role assignment for message ${allMessages.length + 1} — structural inference used`)
      }

      logger.messageAccepted(allMessages.length, role, content, cbCount, languages)
      allMessages.unshift({ role, content })
      added++
    }
    return added
  }

  const { nodes: initialNodes, strategyUsed: s } = discoverWithFallbackChain(
    container,
    (label, count) => {
      if (count > 0) logger.selectorMatched(label, count)
      else logger.selectorFailed(label)
    }
  )

  strategyUsed = s
  logger.nodeScanStart(initialNodes.length)
  const initialAdded = addBatch(initialNodes)
  logger.nodeScanComplete(initialNodes.length)
  logger.markInitialExtractionDone()
  emit("Initial extraction complete", allMessages.length)

  // Snapshot
  const snapshots: NodeSnapshot[] = initialNodes.slice(0, 20).map((n, i) => {
    const content = extractContent(n.el)
    const { count: cbCount } = parseCodeBlocks(content)
    return {
      index: i,
      selector: n.strategyUsed,
      role: n.role,
      accepted: !isNoise(content) && content.length >= 5,
      rejectionReason: isNoise(content) ? "noise" : content.length < 5 ? "too short" : undefined,
      contentPreview: content.slice(0, 120),
      codeBlockCount: cbCount,
      nodeDepth: getNodeDepth(n.el),
      classList: typeof n.el.className === "string" ? n.el.className.slice(0, 80) : "",
      dataAttrs: getDataAttrs(n.el),
    }
  })
  logger.takeSnapshot(`attempt_${attemptNum}_initial`, container, snapshots)

  // ── Phase 5: Virtualized scroll recovery ──────────────────────────────────
  // PERF: Only run scroll recovery if the initial pass found ZERO messages.
  // If we already have messages, the DOM is fully loaded and scrolling is wasted time.
  const needsScroll = initialAdded === 0 && container.scrollHeight > container.clientHeight + 50
  if (needsScroll) {
    if (container.scrollHeight > container.clientHeight * 3) {
      logger.virtualizationWarning(
        `Scroll height ${container.scrollHeight}px is >3x viewport — content likely virtualized`
      )
    }

    emit("Recovering history", allMessages.length)

    let scrollTotal = allMessages.length

    const scrollResult = await scrollRecovery(
      container,
      (nodes) => {
        const added = addBatch(nodes)
        scrollTotal = allMessages.length
        return added
      },
      opts,
      (attempt, scrollTop, newMessages, _total) => {
        logger.scrollAttempt(attempt, scrollTop, newMessages, scrollTotal)
        emit(`Recovering history (${scrollTotal} found)`, scrollTotal)
      }
    )

    logger.scrollComplete(scrollResult.totalScrollAttempts)

    if (scrollResult.stuckWarning) {
      logger.mutationWarning("Scroll position did not change during recovery — possible DOM virtualization lock")
      warnings.push("Scroll recovery may be incomplete due to virtualization")
    }
  }

  return { added: allMessages.length, strategy: strategyUsed, warnings }
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function extractClaudeConversation(
  onProgress?: (p: ExtractionProgress) => void,
  resilienceOpts?: ResilienceOptions
): Promise<ExtractionResult> {
  const opts = mergeOptions(resilienceOpts)
  const logger = new ExtractionLogger()
  logger.pipelineStart()

  const t0 = performance.now()
  const seen = new Set<string>()
  const allMessages: RawMessage[] = []
  const allWarnings: string[] = []

  const emit = (stage: string, total: number) => {
    if (!onProgress) return
    onProgress({
      stage,
      totalFound: total,
      userCount: allMessages.filter(m => m.role === "user").length,
      assistantCount: allMessages.filter(m => m.role === "assistant").length,
      codeBlockCount: allMessages.filter(m => m.content.includes("```")).length,
      durationMs: Math.round(performance.now() - t0),
    })
  }

  // ── Retry pipeline ─────────────────────────────────────────────────────────
  emit("Starting extraction", 0)

  const retryResult = await withRetry(
    async (attempt) => {
      emit(`Extraction attempt ${attempt}`, allMessages.length)
      const result = await runExtractionAttempt(
        attempt, seen, allMessages, opts, emit, logger
      )
      for (const w of result.warnings) {
        if (!allWarnings.includes(w)) allWarnings.push(w)
      }
      return result.added > 0 ? result : null
    },
    opts.retryAttempts,
    opts.retryDelayMs,
    (result) => result === null || result.added === 0
  )

  // ── Anomaly detection ──────────────────────────────────────────────────────
  const strategy = retryResult.result?.strategy ?? "none"
  const anomaly = detectSelectorDrift(strategy !== "none" ? strategy : null, allMessages.length)

  if (anomaly.selectorDrift) {
    const msg = `Selector drift detected: previously used "${anomaly.driftedSelectors[0]}", now using "${strategy}"`
    allWarnings.push(msg)
    logger.mutationWarning(msg)
  }

  if (anomaly.countDropDetected) {
    const msg = `Count drop: extracted ${allMessages.length} vs last known ${anomaly.lastKnownCount} — possible virtualization or DOM change`
    allWarnings.push(msg)
    logger.mutationWarning(msg)
  }

  // Record this run for future drift detection
  if (allMessages.length > 0 && strategy !== "none") {
    recordSuccessfulSelector(strategy, allMessages.length)
  }

  // ── Sanity warnings ────────────────────────────────────────────────────────
  let userCount = allMessages.filter(m => m.role === "user").length
  let aiCount   = allMessages.filter(m => m.role === "assistant").length

  // ── Two-Path Rescue ────────────────────────────────────────────────────────
  // If the generic chain found 0 assistant messages (the most common failure),
  // run the dedicated two-path extractor that uses content heuristics.
  // This fires for BOTH: zero total messages AND messages-but-no-assistant.
  if (aiCount === 0) {
    emit("Trying two-path assistant rescue…", allMessages.length)
    logger.mutationWarning("Generic chain returned 0 assistant messages — activating two-path rescue")

    const twoPath = runTwoPathExtraction()
    for (const w of twoPath.warnings) {
      if (!allWarnings.includes(w)) allWarnings.push(w)
    }

    if (twoPath.assistantCount > 0) {
      // Merge: keep any existing user messages, add two-path results
      const existingKeys = new Set(allMessages.map(m => fingerprint(m.role, m.content)))
      let added = 0
      for (const m of twoPath.messages) {
        const key = fingerprint(m.role, m.content)
        if (!existingKeys.has(key) && m.content.length >= 5) {
          existingKeys.add(key)
          allMessages.push({ role: m.role, content: m.content })
          added++
        }
      }
      if (added > 0) {
        allWarnings.push(`Two-path rescue recovered ${twoPath.assistantCount} assistant message(s) via "${twoPath.assistantStrategy}"`)
        logger.mutationWarning(`Two-path rescue added ${added} message(s)`)
      }
    } else {
      allWarnings.push(`Two-path rescue also found 0 assistant messages (tried "${twoPath.assistantStrategy}")`)
    }

    // Re-sort by DOM insertion order approximation (user before assistant within each pair)
    // We can't re-compare DOM nodes here since we lost references; keep existing order.
    userCount = allMessages.filter(m => m.role === "user").length
    aiCount   = allMessages.filter(m => m.role === "assistant").length
  }

  if (allMessages.length === 0) {
    const reason = [
      "Extraction failed:",
      `${opts.retryAttempts} attempt(s) + two-path rescue produced 0 valid messages.`,
      "",
      "Selector chain tried:",
      "  • [data-message-author-role]",
      "  • [data-author-role]",
      "  • [aria-label*='turn']",
      "  • [data-testid='conversation-turn']",
      "  • [data-testid*='message']",
      "  • .font-claude-message / .prose",
      "  • structural inference",
      "  • two-path content heuristic (long text + code/markdown signals)",
      "  • code-block parent walk",
      "",
      "Possible causes:",
      "  • Claude DOM has changed significantly",
      "  • Page not fully hydrated — try again in 2s",
      "  • Conversation is empty",
      "  • MutationObserver blocked by Content Security Policy",
    ].join("\n")

    allWarnings.push("All extraction strategies (including two-path rescue) returned 0 messages.")
    logger.pipelineFailed(reason)
    const report = logger.buildReport(false, reason)
    return {
      messages: [],
      strategy: "none",
      warnings: allWarnings,
      debugDump: logger.buildTextDump(report),
      diagnostics: report,
    }
  }

  if (allMessages.length <= 2) {
    allWarnings.push("Only 1–2 messages found — conversation may be incomplete.")
  }

  if (allMessages.length > 2 && Math.abs(userCount - aiCount) > 3) {
    allWarnings.push(`Role imbalance: ${userCount} user vs ${aiCount} assistant — role inference may be inaccurate`)
  }

  if (!retryResult.succeeded && retryResult.attempts > 1) {
    allWarnings.push(`Extraction required ${retryResult.attempts} attempt(s) — DOM instability detected`)
  }

  logger.pipelineComplete(true)
  emit("Done", allMessages.length)

  const report = logger.buildReport(true, null)
  return {
    messages: allMessages,
    strategy,
    warnings: allWarnings,
    debugDump: logger.buildTextDump(report),
    diagnostics: report,
  }
}

// ─── Legacy shim ──────────────────────────────────────────────────────────────

export type ExtractedMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  codeBlocks: { language: string; code: string; filename?: string }[]
  rawLength: number
  index: number
}

export type ExtractionQuality = {
  score: number
  isReliable: boolean
  issues: string[]
}

export function isLikelyNoise(text: string): boolean {
  return isNoise(text)
}

export function toExtractedMessages(raw: RawMessage[]): ExtractedMessage[] {
  return raw.map((m, i) => {
    const codeBlocks: ExtractedMessage["codeBlocks"] = []
    const codeRe = /```(\w*)\n([\s\S]*?)```/g
    let match: RegExpExecArray | null
    while ((match = codeRe.exec(m.content)) !== null) {
      codeBlocks.push({ language: match[1] || "unknown", code: match[2].trim() })
    }
    const prose = m.content.replace(/```[\s\S]*?```/g, "").trim()
    return {
      id: `msg-${i}`,
      role: m.role,
      content: prose,
      codeBlocks,
      rawLength: m.content.length,
      index: i,
    }
  })
}

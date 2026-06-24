/**
 * JumpAI — DOM Resilience Layer
 *
 * Hardens extraction against Claude SPA DOM instability:
 *  1. Selector fallback chains  (semantic → aria → structural → inference)
 *  2. Hydration stabilization   (MutationObserver + DOM settle detection)
 *  3. Virtualization handling   (incremental scroll + snapshot merging)
 *  4. DOM anomaly detection     (selector drift, count drops, missing roots)
 *  5. Extraction recovery       (retry pipeline, fallback mode, structural inference)
 *
 * No summarization. No scoring. Pure extraction durability.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant"

export interface DiscoveredNode {
  el: Element
  role: MessageRole
  strategyUsed: string
  confidence: "high" | "medium" | "low"   // structural certainty only, NOT AI scoring
}

export interface ContainerResult {
  el: Element
  strategyUsed: string
  isFallback: boolean
}

export interface AnomalyReport {
  missingRoot: boolean
  selectorDrift: boolean           // previously working selector now fails
  countDropDetected: boolean       // current < 50% of last known count
  lastKnownCount: number
  currentCount: number
  driftedSelectors: string[]
  activeSelector: string | null
}

export interface ResilienceOptions {
  settleMs?: number          // ms of DOM quiet before extraction (default 400)
  hydrationTimeoutMs?: number // max wait for conversation root (default 6000)
  retryAttempts?: number     // number of full pipeline retries (default 3)
  retryDelayMs?: number      // delay between retries (default 800)
  scrollStepPx?: number      // scroll step for virtualized content (default 1000)
  scrollPauseMs?: number     // pause after each scroll step (default 450)
  maxScrollAttempts?: number // cap on scroll iterations (default 45)
  noNewCountLimit?: number   // consecutive empty batches before stopping scroll (default 3)
}

const DEFAULTS: Required<ResilienceOptions> = {
  settleMs: 80,             // fast-exit path in waitForDOMSettle makes this rarely reached
  hydrationTimeoutMs: 1500, // 1.5s is plenty for an already-loaded SPA page
  retryAttempts: 2,
  retryDelayMs: 300,        // was 600 — halved; short chats never need a retry
  scrollStepPx: 1000,
  scrollPauseMs: 150,       // was 250
  maxScrollAttempts: 20,
  noNewCountLimit: 3,
}

// ─── Session-Level Selector Drift Tracker ─────────────────────────────────────
// Persists across extractions in the same page session so we can detect
// when a previously working selector stops matching.

const DRIFT_KEY = "__jumpai_selector_history__"

interface SelectorHistory {
  lastWorking: string | null
  lastCount: number
  timestamp: number
}

function readHistory(): SelectorHistory {
  try {
    const raw = sessionStorage.getItem(DRIFT_KEY)
    if (raw) return JSON.parse(raw) as SelectorHistory
  } catch { /* ignore */ }
  return { lastWorking: null, lastCount: 0, timestamp: 0 }
}

function writeHistory(h: SelectorHistory): void {
  try { sessionStorage.setItem(DRIFT_KEY, JSON.stringify(h)) } catch { /* ignore */ }
}

export function recordSuccessfulSelector(selector: string, count: number): void {
  writeHistory({ lastWorking: selector, lastCount: count, timestamp: Date.now() })
}

export function detectSelectorDrift(activeSelector: string | null, currentCount: number): AnomalyReport {
  const history = readHistory()
  const driftedSelectors: string[] = []

  const selectorDrift =
    history.lastWorking !== null &&
    activeSelector !== null &&
    history.lastWorking !== activeSelector &&
    history.lastCount > 0

  if (selectorDrift && history.lastWorking) {
    driftedSelectors.push(history.lastWorking)
  }

  // Count drop: current extraction is <50% of last known good count
  const countDropDetected =
    history.lastCount > 4 &&
    currentCount > 0 &&
    currentCount < history.lastCount * 0.5

  return {
    missingRoot: activeSelector === null,
    selectorDrift,
    countDropDetected,
    lastKnownCount: history.lastCount,
    currentCount,
    driftedSelectors,
    activeSelector,
  }
}

// ─── Hydration Stabilization ──────────────────────────────────────────────────

/**
 * Waits for the DOM to stop mutating for `settleMs` consecutive milliseconds.
 * Resolves early if the DOM settles. Rejects on timeout.
 */
// Fast-exit: if the DOM is already quiet, resolve in FAST_QUIET_MS instead of settleMs.
// This is the primary speedup for short, already-loaded chats.
const FAST_QUIET_MS = 50

export function waitForDOMSettle(
  root: Element | Document,
  settleMs = 400,
  timeoutMs = 4000
): Promise<"settled" | "timeout"> {
  return new Promise(resolve => {
    let mutated = false
    let timer: ReturnType<typeof setTimeout>

    const deadline = setTimeout(() => {
      observer.disconnect()
      resolve("timeout")
    }, timeoutMs)

    const observer = new MutationObserver(() => {
      mutated = true
      clearTimeout(timer)
      // DOM is changing — wait the full settleMs for it to calm down
      timer = setTimeout(() => {
        observer.disconnect()
        clearTimeout(deadline)
        resolve("settled")
      }, settleMs)
    })

    observer.observe(root instanceof Document ? root.body : root, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false,
    })

    // Fast-exit: if no mutations arrive within FAST_QUIET_MS, the DOM is already
    // static — resolve immediately rather than waiting the full settleMs.
    timer = setTimeout(() => {
      if (!mutated) {
        observer.disconnect()
        clearTimeout(deadline)
        resolve("settled")
      }
      // If mutations have arrived, the MutationObserver timer takes over.
    }, FAST_QUIET_MS)
  })
}

/**
 * Waits until any conversation root selector matches in the DOM.
 * Uses MutationObserver for efficiency; falls back to polling.
 */
export function waitForConversationRoot(
  selectors: string[],
  timeoutMs = 6000
): Promise<{ el: Element; selector: string } | null> {
  return new Promise(resolve => {
    const check = (): { el: Element; selector: string } | null => {
      for (const sel of selectors) {
        const el = document.querySelector(sel)
        if (el) return { el, selector: sel }
      }
      return null
    }

    const found = check()
    if (found) { resolve(found); return }

    const observer = new MutationObserver(() => {
      const hit = check()
      if (hit) { observer.disconnect(); clearTimeout(deadline); resolve(hit) }
    })

    observer.observe(document.body, { childList: true, subtree: true })

    const deadline = setTimeout(() => {
      observer.disconnect()
      resolve(null)
    }, timeoutMs)
  })
}

// ─── Sidebar / Visibility Filters ─────────────────────────────────────────────

export function isHidden(el: Element): boolean {
  const s = window.getComputedStyle(el)
  return (
    s.display === "none" ||
    s.visibility === "hidden" ||
    s.opacity === "0" ||
    el.getAttribute("aria-hidden") === "true" ||
    (el as HTMLElement).hidden
  )
}

export function isInSidebar(el: Element): boolean {
  let cur: Element | null = el
  while (cur && cur !== document.body) {
    const tag = cur.tagName.toLowerCase()
    const cls = (typeof cur.className === "string" ? cur.className : "").toLowerCase()
    const role = (cur.getAttribute("role") || "").toLowerCase()
    const id = (cur.id || "").toLowerCase()
    if (tag === "nav" || tag === "aside") return true
    if (role === "navigation" || role === "complementary") return true
    if (/sidebar|side-bar|nav-panel|left-panel|drawer|conversation-list|history-panel/i.test(cls)) return true
    if (/sidebar|nav|history/i.test(id)) return true
    cur = cur.parentElement
  }
  return false
}

// ─── Scroll Container — Fallback Chain ───────────────────────────────────────
//
// Ordered from most specific / stable → most generic.
// We prefer semantic / structural signals over class names.

const SCROLL_CONTAINER_SELECTORS: string[] = [
  // 1. Semantic role — most stable across class renames
  "[role='main']",
  // 2. Data-attribute scroll containers Claude has used
  "[data-scroll-root]",
  "[data-conversation-container]",
  // 3. Main element (semantic HTML)
  "main",
  // 4. Known structural class patterns (less stable, but widely used)
  "div.flex-1.overflow-y-auto",
  "main div.overflow-y-auto",
  "[role='main'] .overflow-y-auto",
  ".conversation-container",
]

function isScrollable(el: Element): boolean {
  const s = window.getComputedStyle(el)
  return (
    (s.overflowY === "auto" || s.overflowY === "scroll") &&
    el.scrollHeight > el.clientHeight + 50
  )
}

export function findScrollContainer(): ContainerResult | null {
  for (const selector of SCROLL_CONTAINER_SELECTORS) {
    const el = document.querySelector(selector)
    if (!el) continue
    if (isInSidebar(el) || isHidden(el)) continue
    // Prefer containers that are actually scrollable, but accept main element even if not
    if (isScrollable(el) || selector === "main" || selector === "[role='main']") {
      return { el, strategyUsed: selector, isFallback: false }
    }
  }

  // Structural fallback: largest scrollable non-sidebar div
  const candidates = Array.from(document.querySelectorAll("div, main, section"))
    .filter(el => !isInSidebar(el) && !isHidden(el) && isScrollable(el))
    .sort((a, b) => b.scrollHeight - a.scrollHeight)

  if (candidates[0]) {
    return { el: candidates[0], strategyUsed: "computed-overflow-fallback", isFallback: true }
  }

  return null
}

// ─── Role Inference — Priority Chain ─────────────────────────────────────────
//
// Each check is independent. We return as soon as one matches.
// Order: data-attribute > aria > testid > class name

export function inferRole(el: Element): MessageRole | null {
  // 1. Explicit semantic data attribute (most stable)
  const roleAttr = el.getAttribute("data-message-author-role") ||
                   el.getAttribute("data-role") ||
                   el.getAttribute("data-author-role")
  if (roleAttr) {
    if (/^user$/i.test(roleAttr) || /human/i.test(roleAttr)) return "user"
    if (/^assistant$/i.test(roleAttr) || /claude|ai|bot/i.test(roleAttr)) return "assistant"
  }

  // 2. ARIA label
  const aria = (el.getAttribute("aria-label") || "").toLowerCase()
  if (/\byou\b|human|user said|your message/i.test(aria)) return "user"
  if (/claude|assistant|ai response|model response/i.test(aria)) return "assistant"

  // 3. data-testid
  const testId = (el.getAttribute("data-testid") || "").toLowerCase()
  if (/human|user/.test(testId)) return "user"
  if (/assistant|claude|ai/.test(testId)) return "assistant"

  // 4. Class names (least stable — changes with CSS refactors)
  const cls = (typeof el.className === "string" ? el.className : "").toLowerCase()
  if (/user-turn|human-turn|font-user|from-user/.test(cls)) return "user"
  if (/assistant-turn|claude-turn|font-claude|from-assistant/.test(cls)) return "assistant"

  // 5. Parent hierarchy walk (handles wrapper divs)
  let parent = el.parentElement
  let depth = 0
  while (parent && depth < 5) {
    const parentRole = inferRole(parent)
    if (parentRole) return parentRole
    parent = parent.parentElement
    depth++
  }

  return null
}

// ─── Selector Fallback Chain ──────────────────────────────────────────────────

export interface SelectorStrategy {
  selector: string
  label: string
  confidence: "high" | "medium" | "low"
  /** If true, extract role from DOM attr directly; otherwise use inferRole() */
  directRole?: boolean
  roleAttr?: string   // attribute name for direct role extraction
}

export const MESSAGE_SELECTOR_CHAIN: SelectorStrategy[] = [
  // Tier 1 — Semantic data attributes (stable across CSS refactors)
  {
    selector: "[data-message-author-role]",
    label: "data-message-author-role",
    confidence: "high",
    directRole: true,
    roleAttr: "data-message-author-role",
  },
  {
    selector: "[data-author-role]",
    label: "data-author-role",
    confidence: "high",
    directRole: true,
    roleAttr: "data-author-role",
  },
  // Tier 2 — ARIA / accessibility markers
  {
    selector: "[aria-label*='Human turn'], [aria-label*='Assistant turn']",
    label: "aria-label-turn",
    confidence: "high",
    directRole: false,
  },
  {
    selector: "[aria-roledescription*='message']",
    label: "aria-roledescription-message",
    confidence: "medium",
    directRole: false,
  },
  // Tier 3 — data-testid patterns
  {
    selector: '[data-testid="conversation-turn"]',
    label: "testid-conversation-turn",
    confidence: "medium",
    directRole: false,
  },
  {
    selector: '[data-testid*="human-turn"], [data-testid*="assistant-turn"]',
    label: "testid-turn-variant",
    confidence: "medium",
    directRole: false,
  },
  {
    selector: '[data-testid*="message"]',
    label: "testid-message",
    confidence: "medium",
    directRole: false,
  },
  // Tier 4 — Class-based (fragile; last resort before structural inference)
  {
    selector: ".font-claude-message, .font-user-message",
    label: "class-font-message",
    confidence: "low",
    directRole: false,
  },
  {
    selector: ".prose",
    label: "class-prose",
    confidence: "low",
    directRole: false,
  },
]

/**
 * Tries each selector strategy in order, returns the first that yields results.
 * Skips strategies that produce 0 matched + role-inferrable nodes.
 */
export function discoverWithFallbackChain(
  container: Element | Document,
  onStrategyTried?: (label: string, matched: number) => void
): { nodes: DiscoveredNode[]; strategyUsed: string } {

  for (const strategy of MESSAGE_SELECTOR_CHAIN) {
    const raw = Array.from(container.querySelectorAll(strategy.selector))
      .filter(el => !isInSidebar(el) && !isHidden(el))

    if (raw.length === 0) {
      onStrategyTried?.(strategy.label, 0)
      continue
    }

    const discovered: DiscoveredNode[] = []
    for (const el of raw) {
      let role: MessageRole | null = null

      if (strategy.directRole && strategy.roleAttr) {
        const val = (el.getAttribute(strategy.roleAttr) || "").toLowerCase()
        if (val === "user" || val === "human") role = "user"
        else if (val === "assistant" || val === "ai" || val === "claude") role = "assistant"
      }

      if (!role) role = inferRole(el)
      if (!role) continue   // skip nodes we can't classify

      discovered.push({ el, role, strategyUsed: strategy.label, confidence: strategy.confidence })
    }

    onStrategyTried?.(strategy.label, discovered.length)

    if (discovered.length > 0) {
      // FIX: If a selector returns only 1 or 2 massive nodes, it's likely a conversation wrapper, not individual messages.
      // We want granular turns. If it's a giant wrapper, ignore this strategy and keep searching deeper.
      const totalChars = discovered.reduce((acc, d) => acc + ((d.el as HTMLElement).innerText?.length || 0), 0)
      if (discovered.length <= 2 && totalChars > 8000) {
        console.warn(`[JumpAI] Strategy ${strategy.label} returned massive wrapper nodes. Skipping.`)
        continue
      }
      
      return { nodes: discovered, strategyUsed: strategy.label }
    }
  }

  // All named strategies failed → try structural inference
  const inferred = structuralInferenceMode(container)
  onStrategyTried?.("structural-inference", inferred.length)
  return { nodes: inferred, strategyUsed: "structural-inference" }
}

// ─── Structural Inference Mode ────────────────────────────────────────────────
//
// Last-resort extraction when all selectors fail.
// Looks for text-dense alternating containers that match the turn pattern.

export function structuralInferenceMode(container: Element | Document): DiscoveredNode[] {
  const root = container instanceof Document ? document.body : container

  // Walk all direct children of plausible conversation wrappers
  // looking for alternating text blocks > 40 chars
  const candidates: Array<{ el: Element; textLen: number; depth: number }> = []

  function walkForTextBlocks(el: Element, depth: number): void {
    if (depth > 8) return
    if (isInSidebar(el) || isHidden(el)) return

    const text = (el as HTMLElement).innerText?.trim() ?? ""
    const hasDirectTextContent = text.length > 40
    const isContainer = el.children.length > 0

    if (hasDirectTextContent && isContainer && depth > 2) {
      candidates.push({ el, textLen: text.length, depth })
    }

    for (const child of Array.from(el.children)) {
      walkForTextBlocks(child, depth + 1)
    }
  }

  walkForTextBlocks(root, 0)

  if (candidates.length < 2) return []

  // Sort by depth (prefer deepest consistent level) then by DOM order
  const depthFrequency = new Map<number, number>()
  for (const c of candidates) {
    depthFrequency.set(c.depth, (depthFrequency.get(c.depth) ?? 0) + 1)
  }
  const dominantDepth = [...depthFrequency.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0

  const atDominantDepth = candidates
    .filter(c => Math.abs(c.depth - dominantDepth) <= 1)
    .map(c => c.el)

  if (atDominantDepth.length < 2) return []

  // Assign roles by alternation — assume user starts first
  return atDominantDepth.map((el, i) => ({
    el,
    role: (i % 2 === 0 ? "user" : "assistant") as MessageRole,
    strategyUsed: "structural-inference",
    confidence: "low" as const,
  }))
}

// ─── Deduplication + Sort ─────────────────────────────────────────────────────

export function sortByDOMOrder(items: DiscoveredNode[]): DiscoveredNode[] {
  return [...items].sort((a, b) => {
    const pos = a.el.compareDocumentPosition(b.el)
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1
    return 0
  })
}

export function deduplicateNodes(items: DiscoveredNode[]): DiscoveredNode[] {
  const deduped: DiscoveredNode[] = []
  for (const item of items) {
    const overlaps = deduped.some(
      prev => prev.el.contains(item.el) || item.el.contains(prev.el)
    )
    if (!overlaps) deduped.push(item)
  }
  return deduped
}

// ─── Virtualized Scroll Recovery ─────────────────────────────────────────────

export interface ScrollRecoveryResult {
  totalScrollAttempts: number
  reachedTop: boolean
  stuckWarning: boolean
}

/**
 * Incrementally scrolls the container upward, calling `onBatch` after each
 * step so the caller can merge newly revealed nodes.
 */
export async function scrollRecovery(
  container: Element,
  onBatch: (nodes: DiscoveredNode[]) => number,
  opts: Required<ResilienceOptions>,
  onAttempt?: (attempt: number, scrollTop: number, newMessages: number, total: number) => void
): Promise<ScrollRecoveryResult> {
  let noNewCount = 0
  let attempts = 0
  let stuckWarning = false
  const savedScrollTop = container.scrollTop

  while (noNewCount < opts.noNewCountLimit && attempts < opts.maxScrollAttempts) {
    attempts++
    const prevTop = container.scrollTop
    container.scrollTop = Math.max(0, container.scrollTop - opts.scrollStepPx)

    await new Promise(r => setTimeout(r, opts.scrollPauseMs))
    await waitForDOMSettle(container, Math.min(opts.settleMs, 200), 1000)

    const { nodes } = discoverWithFallbackChain(container)
    const added = onBatch(nodes)

    onAttempt?.(attempts, container.scrollTop, added, 0 /* caller tracks total */)

    if (added === 0) noNewCount++
    else noNewCount = 0

    if (container.scrollTop <= 0) break

    if (container.scrollTop === prevTop) {
      stuckWarning = true
      noNewCount++
    }
  }

  // Restore position
  container.scrollTop = savedScrollTop

  return {
    totalScrollAttempts: attempts,
    reachedTop: container.scrollTop <= 0,
    stuckWarning,
  }
}

// ─── Retry Pipeline ───────────────────────────────────────────────────────────

export interface RetryResult<T> {
  result: T | null
  attempts: number
  succeeded: boolean
  lastError: string | null
}

/**
 * Runs `fn` up to `maxAttempts` times with `delayMs` between retries.
 * `fn` must return null/undefined to signal failure.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T | null>,
  maxAttempts: number,
  delayMs: number,
  shouldRetry?: (result: T | null, attempt: number) => boolean
): Promise<RetryResult<T>> {
  let lastError: string | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn(attempt)
      const needsRetry = shouldRetry ? shouldRetry(result, attempt) : result === null
      if (!needsRetry && result !== null) {
        return { result, attempts: attempt, succeeded: true, lastError: null }
      }
      lastError = `Attempt ${attempt}: returned empty result`
    } catch (err) {
      lastError = `Attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`
    }

    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, delayMs * attempt))  // exponential-ish backoff
    }
  }

  return { result: null, attempts: maxAttempts, succeeded: false, lastError }
}

// ─── DOM Anomaly Detection ────────────────────────────────────────────────────

export interface DOMHealthCheck {
  hasConversationRoot: boolean
  hasMessageNodes: boolean
  messageCount: number
  isHydrated: boolean
  anomalies: string[]
}

export function checkDOMHealth(container: Element | null): DOMHealthCheck {
  const anomalies: string[] = []

  if (!container) {
    anomalies.push("No conversation root found in DOM")
    return { hasConversationRoot: false, hasMessageNodes: false, messageCount: 0, isHydrated: false, anomalies }
  }

  // Check if React/SPA has hydrated (look for data-reactroot or any rendered child content)
  const isHydrated = container.children.length > 0 &&
    (container as HTMLElement).innerText?.trim().length > 0

  if (!isHydrated) anomalies.push("Conversation container appears unhydrated (empty or no text)")

  // Quick probe for message nodes
  const { nodes } = discoverWithFallbackChain(container)

  if (nodes.length === 0) anomalies.push("0 message nodes detected across all selector strategies")

  const userCount = nodes.filter(n => n.role === "user").length
  const assistantCount = nodes.filter(n => n.role === "assistant").length

  if (nodes.length > 2 && userCount === 0) anomalies.push("No user messages found — role inference may be broken")
  if (nodes.length > 2 && assistantCount === 0) anomalies.push("No assistant messages found — role inference may be broken")
  if (nodes.length > 3 && Math.abs(userCount - assistantCount) > nodes.length * 0.4) {
    anomalies.push(`Severe role imbalance: ${userCount} user vs ${assistantCount} assistant`)
  }

  return {
    hasConversationRoot: true,
    hasMessageNodes: nodes.length > 0,
    messageCount: nodes.length,
    isHydrated,
    anomalies,
  }
}

// ─── Public Options Helper ────────────────────────────────────────────────────

export function mergeOptions(opts?: ResilienceOptions): Required<ResilienceOptions> {
  return { ...DEFAULTS, ...opts }
}

/**
 * JumpAI Workflow Engine
 *
 * Implements the five-stage pipeline:
 *   1. Global noise filtering
 *   2. Role-aware message classification
 *   3. Planning chatter removal
 *   4. Accomplishment extraction
 *   5. Blocker detection + workflow state synthesis
 *
 * This module is consumed by both recovery-engine.ts and packet-builder.ts.
 * It produces a WorkflowSynthesis — the authoritative structured state that
 * all packet formatters should render.
 */

import type { RawMessage } from "./extractor"

// ─── 1. GLOBAL NOISE FILTER ───────────────────────────────────────────────────
// Remove UI chrome, marketing language, and AI filler sentences BEFORE any
// processing. This is the single highest-impact change.

const NOISE_PATTERNS: RegExp[] = [
  // AI disclaimer / brand lines — these are the most common source of bad objectives
  /claude is (an )?ai/i,
  /please double-?check (my )?responses/i,
  /i can make mistakes/i,
  /ai (can|may) make mistakes/i,
  /responses may be inaccurate/i,
  /claude may make mistakes/i,

  // Upgrade / plan prompts (standalone phrases)
  /^free plan$/i,
  /^upgrade(\s+to\s+(pro|team|enterprise))?$/i,
  /^pro plan$/i,
  /^team plan$/i,
  /^enterprise plan$/i,

  // UI navigation chrome — only match as entire line/message (not within sentences)
  /^new chat$/i,
  /^new conversation$/i,
  /^artifacts?$/i,
  /^projects$/i,
  /^customize$/i,
  /^share$/i,

  // Keyboard shortcut references
  /ctrl\+/i,
  /cmd\+/i,

  // Worthless AI filler (standalone short phrases — line-anchored)
  /^let me (think|write|present|consider|explain|walk you|show you|break).{0,60}$/im,
  /^now i (have a complete picture|can see|understand).{0,80}$/im,
  /^all (validations|checks|tests) passed\.?$/im,
  /^(great|perfect|excellent|wonderful|sure|absolutely|of course|happy to help)\.?$/im,
  /^(got it|understood|noted|acknowledged)\.?$/im,

  // Excitement / emoji decoration lines (lines that are mostly emoji)
  /^[\s✨🎨🚀💡🔥⚡🌟🎯🏆🎉]+.{0,40}[\s✨🎨🚀💡🔥⚡🌟🎯🏆🎉]+$/m,
]

/**
 * Returns true if the entire message text is noise and should be dropped.
 * Applied to the full message content.
 */
export function isGlobalNoise(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 3) return true
  // Check each noise pattern
  return NOISE_PATTERNS.some((p) => p.test(trimmed))
}

/**
 * Filters noise sentences out of a single message body.
 * Returns a cleaned version of the text (may be shorter; may be empty).
 */
export function cleanMessageText(text: string): string {
  return text
    .split(/\n/)
    .map((line) => {
      if (isGlobalNoise(line)) return ""
      return line
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Apply global noise gate to the full message list.
 * Messages whose content collapses to empty after cleaning are dropped.
 */
export function filterNoiseMessages(messages: RawMessage[]): RawMessage[] {
  const result: RawMessage[] = []
  for (const m of messages) {
    const cleaned = cleanMessageText(m.content)
    if (cleaned.length > 5) {
      result.push({ ...m, content: cleaned })
    }
  }
  return result
}

// ─── 2. ROLE-AWARE OBJECTIVE EXTRACTION ───────────────────────────────────────
// Objective ONLY from user messages with >= 20 chars that aren't noise.
// Prefers: longest message, then first message with an action verb.

// Action verbs that indicate task-oriented user messages
const TASK_VERB_RE = /\b(build|create|generate|fill|implement|fix|analyze|develop|write|make|add|refactor|migrate|design|integrate|update|set up)\b/i

/**
 * Extract the project objective from user messages only.
 * Never use assistant messages for objective extraction.
 */
export function extractObjectiveFromUser(messages: RawMessage[]): string {
  const candidates = messages
    .filter((m) => m.role === "user")
    .filter((m) => m.content.trim().length >= 20)
    // Never use messages that are pure noise
    .filter((m) => !isGlobalNoise(m.content.trim()))

  if (candidates.length === 0) {
    // Ultra-fallback: any non-noise user message
    const any = messages.find((m) => m.role === "user" && !isGlobalNoise(m.content.trim()))
    if (any) return any.content.replace(/\n+/g, " ").trim().slice(0, 400)
    return "Project goal not explicitly stated — infer from conversation context."
  }

  // Prefer messages with task verbs and length >= 50
  const taskOriented = candidates
    .filter((m) => m.content.length >= 50 && TASK_VERB_RE.test(m.content))
  
  if (taskOriented.length > 0) {
    // Longest task-oriented user message
    const best = taskOriented.sort((a, b) => b.content.length - a.content.length)[0]
    const text = best.content.replace(/\n+/g, " ").replace(/\s+/g, " ").trim()
    return text.length > 500 ? text.slice(0, 500) + "…" : text
  }

  // Fallback: longest user message overall
  const byLength = [...candidates].sort((a, b) => b.content.length - a.content.length)
  const primary = byLength[0]
  const text = primary.content.replace(/\n+/g, " ").replace(/\s+/g, " ").trim()
  return text.length > 500 ? text.slice(0, 500) + "…" : text
}

// ─── 3. PLANNING CHATTER REMOVAL ──────────────────────────────────────────────
// Filter assistant sentences that announce FUTURE actions.
// These should NEVER enter progress, next steps, or accomplishment extraction.

export const PLANNING_PATTERNS: RegExp[] = [
  /^let me\b/i,
  /^now i('ll| will)\b/i,
  /^i('ll| will) now\b/i,
  /^i am going to\b/i,
  /^next i will\b/i,
  /^i'm going to\b/i,
  /^i'm now going to\b/i,
  /^first[,\s]+i('ll| will)\b/i,
  /^to (begin|start|kick off|get started)\b/i,
  /^to do this[,\s]/i,
  /^what i('ll| will) do\b/i,
  /^here's what i('ll| will| am going to)\b/i,
  /^the (approach|plan|strategy|steps?) (is|are|will be)\b/i,
  // Additional planning signals from the spec
  /^let me present\b/i,
  /^let me write\b/i,
  /^now i have\b/i,
  /^i will (now|next|then)\b/i,
  /^going to\b/i,
]

export function isPlanning(sentence: string): boolean {
  const s = sentence.trim()
  return PLANNING_PATTERNS.some((p) => p.test(s))
}

/**
 * Remove planning-chatter sentences from an assistant message body.
 * Splits on sentence boundaries, filters, rejoins.
 */
export function removePlanningChatter(text: string): string {
  // Split on sentence-ending punctuation
  const sentences = text.split(/(?<=[.!?])\s+/)
  const kept = sentences.filter((s) => !isPlanning(s))
  return kept.join(" ").trim()
}

// ─── 4. ACCOMPLISHMENT EXTRACTION ─────────────────────────────────────────────
// Only keep sentences from assistant messages that describe COMPLETED work.
// Expanded pattern list to cover common completion signals.

const ACCOMPLISHMENT_PATTERNS: RegExp[] = [
  // "I've / I have <verb>-ed"
  /i(?:'ve|\s+have)\s+(?:implemented|created|built|generated|added|fixed|completed|updated|written|configured|set\s+up|integrated|connected|wired|refactored|deployed|published|removed|extracted|migrated|merged)\s+(?:the\s+)?(.{10,200})/gi,

  // "X is now working / complete / done"
  /(?:the\s+)?(.{5,100})\s+is\s+now\s+(?:working|complete|done|implemented|ready|functional|connected|live|active)/gi,

  // "Successfully / Just <verb>-ed"
  /(?:successfully|just)\s+(?:implemented|created|built|generated|added|fixed|completed|updated|configured|integrated|connected|resolved|finished)\s+(?:the\s+)?(.{10,180})/gi,

  // "Added X", "Fixed X", "Generated X" at start of sentence
  /^(?:implemented|created|added|fixed|completed|generated|integrated|resolved|built)\s+(?:the\s+)?(.{10,200})\.?$/gim,

  // "Here's the completed / implemented X"
  /(?:here(?:'s|\s+is)\s+the\s+(?:completed?|implemented|final|updated|finished))\s+(.{5,120})/gi,

  // "X has been implemented / completed"
  /(?:the\s+)?(.{5,100})\s+has\s+been\s+(?:implemented|completed|fixed|added|updated|resolved|deployed|integrated)/gi,

  // Working/done signal
  /(?:working|done|complete)[:\s](.{5,120})/gi,
]

function deduplicateSemantically(strings: string[], threshold = 0.45): string[] {
  function similarity(a: string, b: string): number {
    const wa = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 2))
    const wb = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 2))
    if (wa.size === 0 && wb.size === 0) return 1
    let inter = 0
    for (const w of wa) if (wb.has(w)) inter++
    return inter / (wa.size + wb.size - inter)
  }
  const result: string[] = []
  for (const s of strings) {
    const clean = s.trim()
    if (!clean) continue
    if (!result.some((r) => similarity(r, clean) > threshold)) {
      result.push(clean)
    }
  }
  return result
}

/**
 * Extract accomplishments from assistant messages only.
 * Strips planning chatter first, then scans for completion signals.
 * Returns deduplicated, human-readable bullet strings.
 */
export function extractAccomplishments(messages: RawMessage[]): string[] {
  const results: string[] = []
  const seen = new Set<string>()

  // Only assistant messages, most recent first (last 10)
  const assistantMsgs = messages
    .filter((m) => m.role === "assistant")
    .slice(-10)
    .reverse()

  for (const msg of assistantMsgs) {
    // Strip planning chatter before scanning
    const text = removePlanningChatter(msg.content.slice(0, 2500))

    for (const pat of ACCOMPLISHMENT_PATTERNS) {
      pat.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = pat.exec(text)) !== null) {
        const raw = (m[1] || m[0]).trim().replace(/\s+/g, " ").slice(0, 160)
        // Reject planning language that snuck through
        if (isPlanning(raw)) continue
        // Reject noise
        if (isGlobalNoise(raw)) continue
        if (raw.length < 8) continue
        if (!seen.has(raw)) {
          seen.add(raw)
          results.push(raw)
        }
        if (results.length >= 8) break
      }
      if (results.length >= 8) break
    }
    if (results.length >= 8) break
  }

  return deduplicateSemantically(results)
}

// ─── 5. BLOCKER DETECTION ─────────────────────────────────────────────────────
// Expanded pattern list to catch interruptions, errors, and stuck states.

const BLOCKER_PATTERNS: RegExp[] = [
  // Generation interruption
  /(?:generation|response)\s+(?:interrupted|cut\s+off|stopped|halted|was\s+cut)/i,
  /(?:interrupted|cut\s+off)\s+(?:during|before|mid)/i,
  /(?:ran out of|hit the|reached the)\s+(?:context|token|output)\s+(?:limit|window|length)/i,
  /(?:max|maximum)\s+(?:context|token|output|response)\s+(?:length|limit|window)\s+(?:reached|hit|exceeded)/i,

  // Error states
  /\b(?:TypeError|SyntaxError|ReferenceError|ValueError|ImportError|RuntimeError|ENOENT|EACCES)\b.{0,150}/i,
  /(?:error|exception|crash|panic)\s+(?:in|at|during|when).{0,150}/i,
  /(?:failed|failure)\s+(?:to\s+)?(?:compile|build|load|parse|connect|start|run|generate).{0,150}/i,

  // Stuck states
  /\bstuck\s+(?:on|at|with)\b.{0,200}/i,
  /\bcan(?:'t|not)\s+(?:proceed|continue|get\s+this\s+to\s+work|figure\s+out)\b.{0,200}/i,
  /\bblocked\s+(?:by|on)\b.{0,200}/i,
  /\bthis\s+is\s+preventing\b.{0,200}/i,
  /\bunfinished\b.{0,150}/i,

  // User-reported blockers
  /(?:i(?:'m|\s+am)\s+)?(?:not\s+sure\s+why|struggling\s+with|having\s+trouble\s+with)\b.{0,200}/i,
  /(?:keeps?|keeps?\s+on)\s+(?:failing|breaking|throwing|crashing)\b.{0,200}/i,
]

/**
 * Detect the most relevant current blocker from recent messages.
 * Scans the last 8 messages (both roles) for blocker signals.
 * Returns the blocker string or undefined if none found.
 */
export function detectCurrentBlocker(messages: RawMessage[]): string | undefined {
  const recent = messages.slice(-8)
  const allText = recent.map((m) => m.content.slice(0, 800)).join("\n")

  for (const pat of BLOCKER_PATTERNS) {
    const m = pat.exec(allText)
    if (m) {
      return m[0].trim().replace(/\s+/g, " ").slice(0, 250)
    }
  }
  return undefined
}

// ─── 6. WORKFLOW STATE SYNTHESIS ──────────────────────────────────────────────
// Combines all five stages into a single authoritative WorkflowSynthesis.

export interface WorkflowSynthesis {
  /** The project objective — from user messages only */
  objective: string
  /** What has been completed — from assistant completion signals only */
  completedWork: string[]
  /** Current blocker if any */
  currentBlocker?: string
  /** Pending / incomplete items */
  pendingWork: string[]
  /** Inferred next immediate step */
  nextImmediateStep: string
}

const PENDING_LIST_HEADER = /(?:pending|still\s+need|remaining|not\s+yet\s+done|todo|incomplete|left\s+to\s+implement|haven't\s+(?:done|built|implemented))[:\s]{0,10}/gi

function extractPendingItems(messages: RawMessage[]): string[] {
  const items: string[] = []
  const seen = new Set<string>()
  const recent = messages.slice(-6)

  for (const msg of recent) {
    const text = msg.content.slice(0, 3000)
    const re = new RegExp(PENDING_LIST_HEADER.source, "gi")
    let hm: RegExpExecArray | null
    while ((hm = re.exec(text)) !== null) {
      const after = text.slice(hm.index + hm[0].length, hm.index + hm[0].length + 600)
      const listItems = after.match(/^[\s]*(?:[-*•]|\d+\.)[\s]+.{3,120}$/gm) || []
      for (const li of listItems.slice(0, 8)) {
        const desc = li.trim().replace(/^[-*•\d.]+\s+/, "").trim()
        if (desc.length > 3 && !seen.has(desc) && !isPlanning(desc)) {
          seen.add(desc)
          items.push(desc)
        }
      }
    }
  }
  return items
}

function inferNextStep(blocker: string | undefined, pending: string[]): string {
  if (blocker) {
    if (/interrupted|cut.?off|max.?length|context.?limit/i.test(blocker)) {
      return "Resume the interrupted generation and deliver the complete output."
    }
    if (/error|failed|crash|exception/i.test(blocker)) {
      return "Resolve the error and verify the fix before continuing."
    }
    return "Resolve the current blocker and continue implementation."
  }
  if (pending.length > 0) {
    return `Implement the next pending item: ${pending[0]}`
  }
  return "Continue from the last completed step — review the transcript below."
}

/**
 * Full five-stage pipeline. Call this once with raw messages.
 * Returns WorkflowSynthesis ready for packet formatting.
 */
export function synthesizeWorkflow(rawMessages: RawMessage[]): WorkflowSynthesis {
  // Stage 1 — Noise filter
  const clean = filterNoiseMessages(rawMessages)

  // Stage 2 — User-only objective
  const objective = extractObjectiveFromUser(clean)

  // Stage 3 & 4 — Accomplishments (planning chatter removed internally)
  const completedWork = extractAccomplishments(clean)

  // Stage 5a — Blocker detection
  const currentBlocker = detectCurrentBlocker(clean)

  // Stage 5b — Pending work
  const pendingWork = extractPendingItems(clean)

  // Stage 5c — Next step
  const nextImmediateStep = inferNextStep(currentBlocker, pendingWork)

  return {
    objective,
    completedWork,
    currentBlocker,
    pendingWork,
    nextImmediateStep,
  }
}

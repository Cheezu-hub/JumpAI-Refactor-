/**
 * JumpAI — Extraction Logger
 *
 * Provides:
 *  - Structured debug events (typed, timestamped)
 *  - Pipeline stage timing instrumentation
 *  - Extraction snapshots (DOM state at each phase)
 *  - Developer inspection utilities
 *
 * Zero fake metrics. Every value is derived from actual DOM/extraction state.
 */

// ─── Event Types ──────────────────────────────────────────────────────────────

export type ExtractionEventKind =
  | "pipeline_start"
  | "container_probe"
  | "container_found"
  | "container_missing"
  | "selector_tried"
  | "selector_matched"
  | "selector_failed"
  | "hydration_check"
  | "hydration_timeout"
  | "node_scan_start"
  | "node_scan_complete"
  | "message_accepted"
  | "message_rejected"
  | "message_duplicate"
  | "message_malformed"
  | "role_assigned"
  | "role_unknown"
  | "code_block_found"
  | "code_block_malformed"
  | "scroll_attempt"
  | "scroll_complete"
  | "mutation_warning"
  | "virtualization_warning"
  | "pipeline_complete"
  | "pipeline_failed"

export interface ExtractionEvent {
  id: number
  kind: ExtractionEventKind
  timestampMs: number        // ms since pipeline start
  absoluteMs: number         // performance.now()
  detail: Record<string, unknown>
  level: "info" | "warn" | "error"
}

// ─── Snapshot Types ───────────────────────────────────────────────────────────

export interface NodeSnapshot {
  index: number
  selector: string
  role: "user" | "assistant" | "unknown"
  accepted: boolean
  rejectionReason?: string
  contentPreview: string    // first 120 chars
  codeBlockCount: number
  nodeDepth: number
  classList: string
  dataAttrs: Record<string, string>
}

export interface ExtractionSnapshot {
  phase: string
  takenAtMs: number
  scrollTop: number
  scrollHeight: number
  containerSelector: string | null
  nodes: NodeSnapshot[]
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export interface ConversationDetectionMetrics {
  rootFound: boolean
  selectorUsed: string | null
  fallbackSelectorUsed: boolean
  hydrated: boolean
  hydrationAttempts: number
  hydrationTimeoutMs: number | null
  containerScrollHeight: number | null
  containerClientHeight: number | null
}

export interface MessageExtractionMetrics {
  totalDOMNodesScanned: number
  candidateNodes: number
  acceptedMessages: number
  rejectedMessages: number
  duplicateMessages: number
  malformedMessages: number
}

export interface RoleMetrics {
  userCount: number
  assistantCount: number
  unknownRoleCount: number
}

export interface CodeBlockMetrics {
  detectedCodeBlocks: number
  extractedLanguages: string[]
  malformedCodeRegions: number
}

export interface FailureDiagnostics {
  missingSelectors: string[]
  hydrationTimeout: boolean
  emptyExtractionReasons: string[]
  domMutationWarnings: string[]
  virtualizedContentWarnings: string[]
}

export interface PipelineTimings {
  startMs: number
  containerDetectionMs: number | null
  initialExtractionMs: number | null
  scrollRecoveryMs: number | null
  totalMs: number | null
  scrollAttempts: number
}

// ─── Full Diagnostic Report ───────────────────────────────────────────────────

export interface ExtractionDiagnosticReport {
  events: ExtractionEvent[]
  snapshots: ExtractionSnapshot[]
  conversationDetection: ConversationDetectionMetrics
  messageExtraction: MessageExtractionMetrics
  roles: RoleMetrics
  codeBlocks: CodeBlockMetrics
  failures: FailureDiagnostics
  timings: PipelineTimings
  rawExtractionPreview: RawExtractionPreviewEntry[]
  ignoredNodePreviews: IgnoredNodeEntry[]
  succeeded: boolean
  failureReason: string | null
}

export interface RawExtractionPreviewEntry {
  index: number
  role: "user" | "assistant"
  contentPreview: string    // first 300 chars
  fullLength: number
  codeBlockCount: number
  extractedAtMs: number
  languages: string[]
}

export interface IgnoredNodeEntry {
  reason: string
  contentPreview: string
  selector: string
}

// ─── Logger Class ─────────────────────────────────────────────────────────────

export class ExtractionLogger {
  private events: ExtractionEvent[] = []
  private snapshots: ExtractionSnapshot[] = []
  private startTime: number = 0
  private eventCounter = 0

  // Metric accumulators (all zeroed, only incremented from real data)
  private convDetection: ConversationDetectionMetrics = {
    rootFound: false,
    selectorUsed: null,
    fallbackSelectorUsed: false,
    hydrated: false,
    hydrationAttempts: 0,
    hydrationTimeoutMs: null,
    containerScrollHeight: null,
    containerClientHeight: null,
  }

  private msgMetrics: MessageExtractionMetrics = {
    totalDOMNodesScanned: 0,
    candidateNodes: 0,
    acceptedMessages: 0,
    rejectedMessages: 0,
    duplicateMessages: 0,
    malformedMessages: 0,
  }

  private roleMetrics: RoleMetrics = {
    userCount: 0,
    assistantCount: 0,
    unknownRoleCount: 0,
  }

  private codeMetrics: CodeBlockMetrics = {
    detectedCodeBlocks: 0,
    extractedLanguages: [],
    malformedCodeRegions: 0,
  }

  private failures: FailureDiagnostics = {
    missingSelectors: [],
    hydrationTimeout: false,
    emptyExtractionReasons: [],
    domMutationWarnings: [],
    virtualizedContentWarnings: [],
  }

  private timings: PipelineTimings = {
    startMs: 0,
    containerDetectionMs: null,
    initialExtractionMs: null,
    scrollRecoveryMs: null,
    totalMs: null,
    scrollAttempts: 0,
  }

  private rawPreview: RawExtractionPreviewEntry[] = []
  private ignoredNodes: IgnoredNodeEntry[] = []

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  pipelineStart(): void {
    this.startTime = performance.now()
    this.timings.startMs = this.startTime
    this.emit("pipeline_start", "info", {
      url: window.location.href,
      timestamp: new Date().toISOString(),
    })
  }

  pipelineComplete(succeeded: boolean, reason?: string): void {
    this.timings.totalMs = Math.round(performance.now() - this.startTime)
    this.emit("pipeline_complete", succeeded ? "info" : "error", {
      succeeded,
      reason: reason ?? null,
      totalMs: this.timings.totalMs,
      messagesAccepted: this.msgMetrics.acceptedMessages,
    })
  }

  pipelineFailed(reason: string): void {
    this.timings.totalMs = Math.round(performance.now() - this.startTime)
    this.emit("pipeline_failed", "error", { reason })
  }

  // ── Container Detection ───────────────────────────────────────────────────

  containerProbe(selector: string): void {
    this.emit("container_probe", "info", { selector })
  }

  containerFound(selector: string, isFallback: boolean, el: Element): void {
    this.timings.containerDetectionMs = Math.round(performance.now() - this.startTime)
    this.convDetection.rootFound = true
    this.convDetection.selectorUsed = selector
    this.convDetection.fallbackSelectorUsed = isFallback
    this.convDetection.containerScrollHeight = el.scrollHeight
    this.convDetection.containerClientHeight = el.clientHeight
    this.emit("container_found", "info", {
      selector,
      isFallback,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      tagName: el.tagName,
      id: el.id || null,
      classList: typeof el.className === "string" ? el.className.slice(0, 80) : "",
    })
  }

  containerMissing(selectorsTried: string[]): void {
    this.timings.containerDetectionMs = Math.round(performance.now() - this.startTime)
    this.convDetection.rootFound = false
    this.failures.missingSelectors.push(...selectorsTried)
    this.emit("container_missing", "error", { selectorsTried })
  }

  selectorTried(selector: string): void {
    this.emit("selector_tried", "info", { selector })
  }

  selectorMatched(selector: string, count: number): void {
    this.emit("selector_matched", "info", { selector, count })
  }

  selectorFailed(selector: string): void {
    this.failures.missingSelectors.push(selector)
    this.emit("selector_failed", "warn", { selector })
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  hydrationCheck(attempt: number): void {
    this.convDetection.hydrationAttempts = attempt
    this.emit("hydration_check", "info", { attempt })
  }

  hydrationOk(): void {
    this.convDetection.hydrated = true
    this.emit("hydration_check", "info", { status: "hydrated" })
  }

  hydrationTimeout(waitedMs: number): void {
    this.convDetection.hydrated = false
    this.convDetection.hydrationTimeoutMs = waitedMs
    this.failures.hydrationTimeout = true
    this.failures.emptyExtractionReasons.push(`Hydration timed out after ${waitedMs}ms`)
    this.emit("hydration_timeout", "warn", { waitedMs })
  }

  // ── Node Scanning ─────────────────────────────────────────────────────────

  nodeScanStart(totalScanned: number): void {
    this.msgMetrics.totalDOMNodesScanned += totalScanned
    this.emit("node_scan_start", "info", { totalScanned })
  }

  nodeScanComplete(candidateCount: number): void {
    this.msgMetrics.candidateNodes += candidateCount
    this.emit("node_scan_complete", "info", {
      candidateCount,
      totalScanned: this.msgMetrics.totalDOMNodesScanned,
    })
  }

  // ── Message Processing ────────────────────────────────────────────────────

  messageAccepted(index: number, role: "user" | "assistant", content: string, codeBlockCount: number, langs: string[]): void {
    this.msgMetrics.acceptedMessages++
    if (role === "user") this.roleMetrics.userCount++
    else this.roleMetrics.assistantCount++

    this.codeMetrics.detectedCodeBlocks += codeBlockCount
    for (const lang of langs) {
      if (!this.codeMetrics.extractedLanguages.includes(lang)) {
        this.codeMetrics.extractedLanguages.push(lang)
      }
    }

    const extractedAtMs = Math.round(performance.now() - this.startTime)
    this.rawPreview.push({
      index,
      role,
      contentPreview: content.slice(0, 300),
      fullLength: content.length,
      codeBlockCount,
      extractedAtMs,
      languages: langs,
    })

    this.emit("message_accepted", "info", {
      index,
      role,
      contentLength: content.length,
      codeBlockCount,
      languages: langs,
      extractedAtMs,
    })
  }

  messageRejected(reason: string, contentPreview: string, selector: string): void {
    this.msgMetrics.rejectedMessages++
    this.ignoredNodes.push({ reason, contentPreview: contentPreview.slice(0, 120), selector })
    this.emit("message_rejected", "warn", { reason, contentPreview: contentPreview.slice(0, 80) })
  }

  messageDuplicate(role: string, fingerprint: string): void {
    this.msgMetrics.duplicateMessages++
    this.emit("message_duplicate", "warn", { role, fingerprint: fingerprint.slice(0, 80) })
  }

  messageMalformed(reason: string): void {
    this.msgMetrics.malformedMessages++
    this.emit("message_malformed", "warn", { reason })
  }

  roleUnknown(el: Element): void {
    this.roleMetrics.unknownRoleCount++
    this.emit("role_unknown", "warn", {
      tagName: el.tagName,
      classList: typeof el.className === "string" ? el.className.slice(0, 60) : "",
      testId: el.getAttribute("data-testid") || null,
    })
  }

  // ── Code Blocks ───────────────────────────────────────────────────────────

  codeBlockMalformed(context: string): void {
    this.codeMetrics.malformedCodeRegions++
    this.emit("code_block_malformed", "warn", { context })
  }

  // ── Scroll / Virtualization ───────────────────────────────────────────────

  scrollAttempt(attempt: number, scrollTop: number, newMessages: number, total: number): void {
    this.timings.scrollAttempts = attempt
    this.emit("scroll_attempt", "info", { attempt, scrollTop, newMessages, total })
  }

  scrollComplete(totalAttempts: number): void {
    this.timings.scrollRecoveryMs = Math.round(performance.now() - this.startTime)
    this.emit("scroll_complete", "info", { totalAttempts })
  }

  mutationWarning(detail: string): void {
    this.failures.domMutationWarnings.push(detail)
    this.emit("mutation_warning", "warn", { detail })
  }

  virtualizationWarning(detail: string): void {
    this.failures.virtualizedContentWarnings.push(detail)
    this.emit("virtualization_warning", "warn", { detail })
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  takeSnapshot(phase: string, container: Element | null, nodes: NodeSnapshot[]): void {
    this.snapshots.push({
      phase,
      takenAtMs: Math.round(performance.now() - this.startTime),
      scrollTop: container?.scrollTop ?? 0,
      scrollHeight: container?.scrollHeight ?? 0,
      containerSelector: this.convDetection.selectorUsed,
      nodes,
    })
  }

  markInitialExtractionDone(): void {
    this.timings.initialExtractionMs = Math.round(performance.now() - this.startTime)
  }

  // ── Report ────────────────────────────────────────────────────────────────

  buildReport(succeeded: boolean, failureReason: string | null = null): ExtractionDiagnosticReport {
    return {
      events: [...this.events],
      snapshots: [...this.snapshots],
      conversationDetection: { ...this.convDetection },
      messageExtraction: { ...this.msgMetrics },
      roles: { ...this.roleMetrics },
      codeBlocks: {
        ...this.codeMetrics,
        extractedLanguages: [...this.codeMetrics.extractedLanguages],
      },
      failures: {
        missingSelectors: [...new Set(this.failures.missingSelectors)],
        hydrationTimeout: this.failures.hydrationTimeout,
        emptyExtractionReasons: [...this.failures.emptyExtractionReasons],
        domMutationWarnings: [...this.failures.domMutationWarnings],
        virtualizedContentWarnings: [...this.failures.virtualizedContentWarnings],
      },
      timings: { ...this.timings },
      rawExtractionPreview: [...this.rawPreview],
      ignoredNodePreviews: [...this.ignoredNodes],
      succeeded,
      failureReason,
    }
  }

  // ── Inspector Utilities ────────────────────────────────────────────────────

  /** Human-readable text dump for copy-paste debugging */
  buildTextDump(report: ExtractionDiagnosticReport): string {
    const lines: string[] = []
    const sep = "─".repeat(48)

    lines.push("╔══════════════════════════════════════════════╗")
    lines.push("║       JumpAI Extraction Diagnostic Report    ║")
    lines.push("╚══════════════════════════════════════════════╝")
    lines.push(`Status     : ${report.succeeded ? "✓ SUCCEEDED" : "✗ FAILED"}`)
    if (report.failureReason) lines.push(`Failure    : ${report.failureReason}`)
    lines.push(`Total time : ${report.timings.totalMs ?? "?"}ms`)
    lines.push("")

    lines.push(sep)
    lines.push("CONVERSATION DETECTION")
    lines.push(sep)
    lines.push(`Root found      : ${report.conversationDetection.rootFound}`)
    lines.push(`Selector used   : ${report.conversationDetection.selectorUsed ?? "none"}`)
    lines.push(`Fallback used   : ${report.conversationDetection.fallbackSelectorUsed}`)
    lines.push(`Hydrated        : ${report.conversationDetection.hydrated}`)
    lines.push(`Hydration tries : ${report.conversationDetection.hydrationAttempts}`)
    if (report.conversationDetection.hydrationTimeoutMs !== null)
      lines.push(`Hydration timeout: ${report.conversationDetection.hydrationTimeoutMs}ms`)
    lines.push(`Container size  : ${report.conversationDetection.containerScrollHeight ?? "?"}px scroll`)
    lines.push("")

    lines.push(sep)
    lines.push("MESSAGE EXTRACTION METRICS")
    lines.push(sep)
    lines.push(`DOM nodes scanned  : ${report.messageExtraction.totalDOMNodesScanned}`)
    lines.push(`Candidate nodes    : ${report.messageExtraction.candidateNodes}`)
    lines.push(`Accepted messages  : ${report.messageExtraction.acceptedMessages}`)
    lines.push(`Rejected messages  : ${report.messageExtraction.rejectedMessages}`)
    lines.push(`Duplicate messages : ${report.messageExtraction.duplicateMessages}`)
    lines.push(`Malformed messages : ${report.messageExtraction.malformedMessages}`)
    lines.push("")

    lines.push(sep)
    lines.push("ROLE METRICS")
    lines.push(sep)
    lines.push(`User messages      : ${report.roles.userCount}`)
    lines.push(`Assistant messages : ${report.roles.assistantCount}`)
    lines.push(`Unknown role       : ${report.roles.unknownRoleCount}`)
    lines.push("")

    lines.push(sep)
    lines.push("CODE BLOCK METRICS")
    lines.push(sep)
    lines.push(`Detected code blocks   : ${report.codeBlocks.detectedCodeBlocks}`)
    lines.push(`Extracted languages    : ${report.codeBlocks.extractedLanguages.join(", ") || "none"}`)
    lines.push(`Malformed code regions : ${report.codeBlocks.malformedCodeRegions}`)
    lines.push("")

    lines.push(sep)
    lines.push("FAILURE DIAGNOSTICS")
    lines.push(sep)
    if (report.failures.missingSelectors.length)
      lines.push(`Missing selectors       : ${report.failures.missingSelectors.join(", ")}`)
    lines.push(`Hydration timeout       : ${report.failures.hydrationTimeout}`)
    if (report.failures.emptyExtractionReasons.length) {
      lines.push("Empty extraction reasons:")
      report.failures.emptyExtractionReasons.forEach(r => lines.push(`  • ${r}`))
    }
    if (report.failures.domMutationWarnings.length) {
      lines.push("DOM mutation warnings:")
      report.failures.domMutationWarnings.forEach(w => lines.push(`  ⚠ ${w}`))
    }
    if (report.failures.virtualizedContentWarnings.length) {
      lines.push("Virtualization warnings:")
      report.failures.virtualizedContentWarnings.forEach(w => lines.push(`  ⚠ ${w}`))
    }
    lines.push("")

    if (!report.succeeded) {
      lines.push(sep)
      lines.push("EXTRACTION FAILED")
      lines.push(sep)
      lines.push(`${report.messageExtraction.acceptedMessages} valid message containers detected.`)
      if (report.failureReason) lines.push(`Reason: ${report.failureReason}`)
      lines.push("")
    }

    if (report.rawExtractionPreview.length > 0) {
      lines.push(sep)
      lines.push("RAW EXTRACTION PREVIEW")
      lines.push(sep)
      for (const m of report.rawExtractionPreview) {
        lines.push(`[${m.index + 1}] ${m.role.toUpperCase()} (${m.fullLength} chars, ${m.codeBlockCount} code blocks, +${m.extractedAtMs}ms)`)
        lines.push(m.contentPreview + (m.fullLength > 300 ? "…" : ""))
        lines.push("")
      }
    }

    if (report.ignoredNodePreviews.length > 0) {
      lines.push(sep)
      lines.push("IGNORED NODES")
      lines.push(sep)
      for (const n of report.ignoredNodePreviews) {
        lines.push(`REASON: ${n.reason}`)
        lines.push(`  ${n.contentPreview}`)
        lines.push("")
      }
    }

    return lines.join("\n")
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private emit(kind: ExtractionEventKind, level: "info" | "warn" | "error", detail: Record<string, unknown>): void {
    const now = performance.now()
    this.events.push({
      id: ++this.eventCounter,
      kind,
      timestampMs: Math.round(now - this.startTime),
      absoluteMs: Math.round(now),
      detail,
      level,
    })
  }
}

/** Singleton logger — reset per extraction run */
export const extractionLogger = new ExtractionLogger()

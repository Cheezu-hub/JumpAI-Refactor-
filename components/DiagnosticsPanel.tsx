import React, { useState } from "react"
import type { ExtractionDiagnosticReport } from "../lib/extraction-logger"

// ─── Helpers ──────────────────────────────────────────────────────────────────

const S = {
  section: {
    padding: "10px 14px",
    borderBottom: "1px solid rgba(255,255,255,0.05)",
  } as React.CSSProperties,
  label: {
    fontSize: 8.5,
    fontWeight: 700,
    color: "rgba(255,255,255,0.25)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    marginBottom: 8,
  } as React.CSSProperties,
  grid2: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 6,
  } as React.CSSProperties,
  card: (highlight?: string) => ({
    padding: "7px 9px",
    borderRadius: 7,
    background: highlight ? `rgba(${highlight},0.07)` : "rgba(255,255,255,0.03)",
    border: `1px solid ${highlight ? `rgba(${highlight},0.2)` : "rgba(255,255,255,0.06)"}`,
  } as React.CSSProperties),
  cardLabel: {
    fontSize: 8,
    color: "rgba(255,255,255,0.3)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  } as React.CSSProperties,
  cardValue: (color?: string) => ({
    fontSize: 13,
    fontWeight: 700,
    color: color || "rgba(255,255,255,0.85)",
    marginTop: 2,
    fontVariantNumeric: "tabular-nums",
  } as React.CSSProperties),
  warn: {
    fontSize: 10,
    color: "rgba(251,191,36,0.85)",
    display: "flex",
    gap: 5,
    marginBottom: 4,
    lineHeight: 1.5,
  } as React.CSSProperties,
  err: {
    fontSize: 10,
    color: "rgba(248,113,113,0.85)",
    display: "flex",
    gap: 5,
    marginBottom: 4,
    lineHeight: 1.5,
  } as React.CSSProperties,
  ok: {
    fontSize: 10,
    color: "rgba(74,222,128,0.85)",
    display: "flex",
    gap: 5,
    marginBottom: 4,
  } as React.CSSProperties,
  pill: (color: string) => ({
    display: "inline-block",
    padding: "1px 6px",
    borderRadius: 99,
    fontSize: 9,
    fontWeight: 600,
    background: `rgba(${color},0.15)`,
    border: `1px solid rgba(${color},0.35)`,
    color: `rgb(${color})`,
    marginRight: 4,
    marginBottom: 3,
  } as React.CSSProperties),
}

function MetricCard({ label, value, highlight }: { label: string; value: string | number; highlight?: string }) {
  return (
    <div style={S.card(highlight)}>
      <div style={S.cardLabel}>{label}</div>
      <div style={S.cardValue(highlight ? `rgb(${highlight})` : undefined)}>{value}</div>
    </div>
  )
}

// ─── Sub-sections ─────────────────────────────────────────────────────────────

function ConvDetection({ d }: { d: ExtractionDiagnosticReport["conversationDetection"] }) {
  return (
    <div style={S.section}>
      <div style={S.label}>1 · Conversation Detection</div>
      <div style={S.grid2}>
        <MetricCard label="Root Found" value={d.rootFound ? "✓ Yes" : "✗ No"} highlight={d.rootFound ? "74,222,128" : "248,113,113"} />
        <MetricCard label="Fallback Used" value={d.fallbackSelectorUsed ? "Yes" : "No"} highlight={d.fallbackSelectorUsed ? "251,191,36" : undefined} />
        <MetricCard label="Hydrated" value={d.hydrated ? "✓ Yes" : d.hydrationAttempts > 0 ? "Timeout" : "Not checked"} highlight={d.hydrated ? "74,222,128" : d.hydrationTimeoutMs ? "248,113,113" : undefined} />
        <MetricCard label="Hydration Tries" value={d.hydrationAttempts} />
      </div>
      {d.selectorUsed && (
        <div style={{ marginTop: 8, fontSize: 9.5, color: "rgba(255,255,255,0.35)", fontFamily: "monospace", wordBreak: "break-all" }}>
          Selector: <span style={{ color: "rgba(204,120,92,0.8)" }}>{d.selectorUsed}</span>
        </div>
      )}
      {d.containerScrollHeight !== null && (
        <div style={{ marginTop: 4, fontSize: 9.5, color: "rgba(255,255,255,0.25)" }}>
          Container: {d.containerScrollHeight}px scroll / {d.containerClientHeight}px visible
        </div>
      )}
    </div>
  )
}

function MsgMetrics({ d }: { d: ExtractionDiagnosticReport["messageExtraction"] }) {
  return (
    <div style={S.section}>
      <div style={S.label}>2 · Message Extraction Metrics</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
        <MetricCard label="DOM Nodes Scanned" value={d.totalDOMNodesScanned} />
        <MetricCard label="Candidates" value={d.candidateNodes} />
        <MetricCard label="Accepted" value={d.acceptedMessages} highlight={d.acceptedMessages > 0 ? "74,222,128" : "248,113,113"} />
        <MetricCard label="Rejected" value={d.rejectedMessages} highlight={d.rejectedMessages > 0 ? "251,191,36" : undefined} />
        <MetricCard label="Duplicates" value={d.duplicateMessages} highlight={d.duplicateMessages > 0 ? "251,191,36" : undefined} />
        <MetricCard label="Malformed" value={d.malformedMessages} highlight={d.malformedMessages > 0 ? "248,113,113" : undefined} />
      </div>
    </div>
  )
}

function RoleMetrics({ d }: { d: ExtractionDiagnosticReport["roles"] }) {
  return (
    <div style={S.section}>
      <div style={S.label}>3 · Role Metrics</div>
      <div style={S.grid2}>
        <MetricCard label="User Messages" value={d.userCount} />
        <MetricCard label="Assistant Messages" value={d.assistantCount} />
        <MetricCard label="Unknown Role" value={d.unknownRoleCount} highlight={d.unknownRoleCount > 0 ? "248,113,113" : undefined} />
      </div>
    </div>
  )
}

function CodeBlockMetrics({ d }: { d: ExtractionDiagnosticReport["codeBlocks"] }) {
  return (
    <div style={S.section}>
      <div style={S.label}>4 · Code Block Metrics</div>
      <div style={S.grid2}>
        <MetricCard label="Detected Blocks" value={d.detectedCodeBlocks} />
        <MetricCard label="Malformed Regions" value={d.malformedCodeRegions} highlight={d.malformedCodeRegions > 0 ? "248,113,113" : undefined} />
      </div>
      {d.extractedLanguages.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ ...S.cardLabel, marginBottom: 5 }}>Extracted Languages</div>
          <div>{d.extractedLanguages.map(l => (
            <span key={l} style={S.pill("148,163,184")}>{l}</span>
          ))}</div>
        </div>
      )}
      {d.extractedLanguages.length === 0 && (
        <div style={{ marginTop: 6, fontSize: 9.5, color: "rgba(255,255,255,0.2)" }}>No code blocks detected</div>
      )}
    </div>
  )
}

function FailureDiagnostics({ d, report }: { d: ExtractionDiagnosticReport["failures"]; report: ExtractionDiagnosticReport }) {
  const hasIssues = !report.succeeded || d.hydrationTimeout || d.missingSelectors.length > 0 ||
    d.emptyExtractionReasons.length > 0 || d.domMutationWarnings.length > 0 || d.virtualizedContentWarnings.length > 0

  return (
    <div style={{ ...S.section, background: hasIssues ? "rgba(248,113,113,0.02)" : undefined }}>
      <div style={S.label}>5 · Failure Diagnostics</div>

      {!report.succeeded && report.failureReason && (
        <div style={{
          padding: "8px 10px", borderRadius: 7, marginBottom: 8,
          background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)"
        }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: "#f87171", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
            Extraction Failed
          </div>
          <pre style={{ fontSize: 9.5, color: "rgba(248,113,113,0.9)", margin: 0, whiteSpace: "pre-wrap", fontFamily: "monospace", lineHeight: 1.6 }}>
            {report.failureReason}
          </pre>
        </div>
      )}

      {d.missingSelectors.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ ...S.cardLabel, marginBottom: 4 }}>Missing Selectors</div>
          {[...new Set(d.missingSelectors)].map(s => (
            <div key={s} style={S.err}><span>✗</span><span style={{ fontFamily: "monospace" }}>{s}</span></div>
          ))}
        </div>
      )}

      {d.hydrationTimeout && (
        <div style={S.err}><span>⚠</span><span>Hydration timed out — page may not have finished rendering</span></div>
      )}

      {d.emptyExtractionReasons.map((r, i) => (
        <div key={i} style={S.err}><span>⚠</span><span>{r}</span></div>
      ))}

      {d.domMutationWarnings.map((w, i) => (
        <div key={i} style={S.warn}><span>⚡</span><span>{w}</span></div>
      ))}

      {d.virtualizedContentWarnings.map((w, i) => (
        <div key={i} style={S.warn}><span>⚡</span><span>{w}</span></div>
      ))}

      {!hasIssues && (
        <div style={S.ok}><span>✓</span><span>No failures detected</span></div>
      )}
    </div>
  )
}

function TimingBar({ t }: { t: ExtractionDiagnosticReport["timings"] }) {
  const stages = [
    { label: "Container", ms: t.containerDetectionMs },
    { label: "Initial Extract", ms: t.initialExtractionMs },
    { label: "Scroll Recovery", ms: t.scrollRecoveryMs },
  ].filter(s => s.ms !== null)

  const total = t.totalMs ?? 1

  return (
    <div style={S.section}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={S.label}>Pipeline Timing</div>
        <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.4)", fontVariantNumeric: "tabular-nums" }}>
          {total}ms total · {t.scrollAttempts} scroll attempt{t.scrollAttempts !== 1 ? "s" : ""}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {stages.map(s => {
          const pct = Math.max(4, Math.round(((s.ms ?? 0) / total) * 100))
          return (
            <div key={s.label}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "rgba(255,255,255,0.35)", marginBottom: 2 }}>
                <span>{s.label}</span><span>{s.ms}ms</span>
              </div>
              <div style={{ height: 4, borderRadius: 99, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", borderRadius: 99, background: "rgba(204,120,92,0.6)", transition: "width 0.4s ease" }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Raw Extraction Preview ───────────────────────────────────────────────────

function RawPreview({ report }: { report: ExtractionDiagnosticReport }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const msgs = report.rawExtractionPreview

  if (msgs.length === 0) return (
    <div style={S.section}>
      <div style={S.label}>6 · Raw Extraction Preview</div>
      <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.2)", padding: "8px 0" }}>
        No messages extracted.
      </div>
    </div>
  )

  return (
    <div style={S.section}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={S.label}>6 · Raw Extraction Preview</div>
        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>{msgs.length} messages</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {msgs.map((m, i) => {
          const isUser = m.role === "user"
          const expanded = expandedIdx === i
          return (
            <div
              key={i}
              onClick={() => setExpandedIdx(expanded ? null : i)}
              style={{
                padding: "7px 9px", borderRadius: 7, cursor: "pointer",
                background: isUser ? "rgba(255,255,255,0.03)" : "rgba(204,120,92,0.05)",
                border: isUser ? "1px solid rgba(255,255,255,0.06)" : "1px solid rgba(204,120,92,0.15)",
                transition: "all 0.15s",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: expanded ? 6 : 0 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{
                    fontSize: 8.5, fontWeight: 700, textTransform: "uppercase",
                    color: isUser ? "rgba(255,255,255,0.4)" : "#cc785c",
                  }}>{i + 1}. {m.role}</span>
                  {m.codeBlockCount > 0 && (
                    <span style={S.pill("148,163,184")}>{m.codeBlockCount} block{m.codeBlockCount > 1 ? "s" : ""}</span>
                  )}
                  {m.languages.map(l => <span key={l} style={S.pill("148,163,184")}>{l}</span>)}
                </div>
                <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontVariantNumeric: "tabular-nums" }}>
                  {m.fullLength}ch · +{m.extractedAtMs}ms
                </div>
              </div>
              {expanded && (
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.65)", lineHeight: 1.6, whiteSpace: "pre-wrap", marginTop: 4, fontFamily: "monospace" }}>
                  {m.contentPreview}{m.fullLength > 300 ? "…" : ""}
                </div>
              )}
              {!expanded && (
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", lineHeight: 1.5, overflow: "hidden", maxHeight: 32, maskImage: "linear-gradient(to bottom, black 60%, transparent)" }}>
                  {m.contentPreview.slice(0, 120)}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {report.ignoredNodePreviews.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ ...S.cardLabel, marginBottom: 5, color: "rgba(251,191,36,0.4)" }}>
            Ignored Nodes ({report.ignoredNodePreviews.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {report.ignoredNodePreviews.slice(0, 8).map((n, i) => (
              <div key={i} style={{ padding: "5px 8px", borderRadius: 6, background: "rgba(251,191,36,0.04)", border: "1px solid rgba(251,191,36,0.1)" }}>
                <div style={{ fontSize: 8.5, color: "rgba(251,191,36,0.5)", marginBottom: 2, textTransform: "uppercase" }}>
                  {n.reason}
                </div>
                <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.3)", fontFamily: "monospace" }}>
                  {n.contentPreview}
                </div>
              </div>
            ))}
            {report.ignoredNodePreviews.length > 8 && (
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", textAlign: "center", paddingTop: 2 }}>
                +{report.ignoredNodePreviews.length - 8} more ignored nodes
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Event Log ────────────────────────────────────────────────────────────────

function EventLog({ events }: { events: ExtractionDiagnosticReport["events"] }) {
  const [open, setOpen] = useState(false)
  const relevant = events.filter(e => e.level !== "info" || ["pipeline_start", "pipeline_complete", "pipeline_failed", "container_found", "container_missing"].includes(e.kind))

  return (
    <div style={S.section}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 6, width: "100%" }}
      >
        <div style={{ ...S.label, marginBottom: 0, flex: 1, textAlign: "left" }}>
          Event Log ({events.length})
        </div>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2.5" strokeLinecap="round"
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s", flexShrink: 0 }}>
          <path d="M18 15l-6-6-6 6" />
        </svg>
      </button>
      {open && (
        <div style={{ marginTop: 8, maxHeight: 200, overflowY: "auto" }}>
          {relevant.map(e => (
            <div key={e.id} style={{
              display: "flex", gap: 6, fontSize: 9.5, padding: "3px 0",
              borderBottom: "1px solid rgba(255,255,255,0.03)",
              color: e.level === "error" ? "rgba(248,113,113,0.8)" : e.level === "warn" ? "rgba(251,191,36,0.8)" : "rgba(255,255,255,0.35)"
            }}>
              <span style={{ flexShrink: 0, fontFamily: "monospace", color: "rgba(255,255,255,0.2)", minWidth: 38 }}>+{e.timestampMs}ms</span>
              <span style={{ flexShrink: 0, minWidth: 6 }}>{e.level === "error" ? "✗" : e.level === "warn" ? "⚠" : "·"}</span>
              <span>{e.kind.replace(/_/g, " ")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export function DiagnosticsPanel({ report }: { report: ExtractionDiagnosticReport | null }) {
  if (!report) return (
    <div style={{ padding: "32px 14px", textAlign: "center" }}>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", lineHeight: 1.7 }}>
        Run an extraction to see<br />live diagnostics.
      </div>
    </div>
  )

  const statusColor = report.succeeded ? "74,222,128" : "248,113,113"

  return (
    <div style={{ animation: "ji-in 0.2s ease" }}>
      {/* Status header */}
      <div style={{
        padding: "8px 14px", display: "flex", alignItems: "center", gap: 8,
        background: `rgba(${statusColor},0.07)`,
        borderBottom: `1px solid rgba(${statusColor},0.2)`,
      }}>
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: `rgb(${statusColor})`, boxShadow: `0 0 6px rgb(${statusColor})` }} />
        <div style={{ fontSize: 10.5, fontWeight: 600, color: `rgb(${statusColor})` }}>
          {report.succeeded
            ? `Extraction succeeded · ${report.messageExtraction.acceptedMessages} messages`
            : `Extraction failed · ${report.failureReason?.split("\n")[0] ?? "unknown reason"}`}
        </div>
        <div style={{ marginLeft: "auto", fontSize: 9, color: "rgba(255,255,255,0.25)", fontVariantNumeric: "tabular-nums" }}>
          {report.timings.totalMs}ms
        </div>
      </div>

      <div style={{ maxHeight: 400, overflowY: "auto" }}>
        <ConvDetection d={report.conversationDetection} />
        <MsgMetrics d={report.messageExtraction} />
        <RoleMetrics d={report.roles} />
        <CodeBlockMetrics d={report.codeBlocks} />
        <FailureDiagnostics d={report.failures} report={report} />
        <TimingBar t={report.timings} />
        <RawPreview report={report} />
        <EventLog events={report.events} />
      </div>
    </div>
  )
}

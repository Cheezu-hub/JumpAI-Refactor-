import React, { useState, useCallback, useRef } from "react"
import {
  runFullDiscovery,
  saveSnapshot,
  loadSnapshots,
  type DebugSnapshot,
  type CandidateNode,
  type SelectorTierResult,
  type StructuralPattern,
} from "../lib/dom-debugger"
import { applyOverlays, clearAllOverlays, highlightSingleNode } from "../lib/overlay-manager"
import { scanForAssistantCandidates, type AssistantScanResult } from "../lib/assistant-extractor"

// ─── Shared Styles ────────────────────────────────────────────────────────────

const C = {
  section: { padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.05)" } as React.CSSProperties,
  label: { fontSize: 8.5, fontWeight: 700, color: "rgba(255,255,255,0.25)", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 8 } as React.CSSProperties,
  pill: (color: string) => ({ display: "inline-block", padding: "1px 6px", borderRadius: 99, fontSize: 9, fontWeight: 600, background: `rgba(${color},0.15)`, border: `1px solid rgba(${color},0.3)`, color: `rgb(${color})`, marginRight: 4, marginBottom: 3 } as React.CSSProperties),
  btn: (active?: boolean, color = "204,120,92") => ({ padding: "5px 10px", borderRadius: 6, cursor: "pointer", fontSize: 10, fontWeight: 600, outline: "none", border: `1px solid rgba(${color},${active ? "0.5" : "0.2"})`, background: `rgba(${color},${active ? "0.15" : "0.05"})`, color: `rgba(${color},${active ? "1" : "0.6"})`, transition: "all 0.15s" } as React.CSSProperties),
  mono: { fontFamily: "monospace", fontSize: 9.5, color: "rgba(255,255,255,0.55)" } as React.CSSProperties,
  card: (hl?: string) => ({ padding: "7px 9px", borderRadius: 7, background: hl ? `rgba(${hl},0.07)` : "rgba(255,255,255,0.03)", border: `1px solid ${hl ? `rgba(${hl},0.2)` : "rgba(255,255,255,0.06)"}` } as React.CSSProperties),
}

function Metric({ label, value, hl }: { label: string; value: string | number; hl?: string }) {
  return (
    <div style={C.card(hl)}>
      <div style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: hl ? `rgb(${hl})` : "rgba(255,255,255,0.85)", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  )
}

// ─── Diagnostics Summary ──────────────────────────────────────────────────────

function SummaryPanel({ snap }: { snap: DebugSnapshot }) {
  return (
    <div style={C.section}>
      <div style={C.label}>1 · Extraction Diagnostics</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 }}>
        <Metric label="Scanned" value={snap.totalScanned} />
        <Metric label="Candidates" value={snap.candidates.length} />
        <Metric label="Accepted" value={snap.acceptedCount} hl={snap.acceptedCount > 0 ? "74,222,128" : "248,113,113"} />
        <Metric label="Rejected" value={snap.rejectedCount} hl={snap.rejectedCount > 0 ? "251,191,36" : undefined} />
        <Metric label="Duplicates" value={snap.duplicateCount} hl={snap.duplicateCount > 0 ? "251,191,36" : undefined} />
        <Metric label="Strategy" value={snap.dominantStrategy.slice(0, 14)} />
        <Metric label="Assistant" value={snap.assistantCount} hl="59,130,246" />
        <Metric label="User" value={snap.userCount} hl="34,197,94" />
        <Metric label="Unknown" value={snap.candidates.filter(c => c.accepted && !c.role).length} hl="167,139,250" />
      </div>
    </div>
  )
}

// ─── Selector Tier Results ────────────────────────────────────────────────────

function SelectorPanel({ results }: { results: SelectorTierResult[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <div style={C.section}>
      <div style={C.label}>2 · Selector Tier Results</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {results.map(r => {
          const isOpen = expanded === r.label
          const matched = r.matchCount > 0
          const accepted = r.acceptedCount > 0
          const color = accepted ? "74,222,128" : matched ? "251,191,36" : "107,114,128"
          return (
            <div key={r.label} onClick={() => setExpanded(isOpen ? null : r.label)}
              style={{ padding: "6px 8px", borderRadius: 6, cursor: "pointer", border: `1px solid rgba(${color},0.2)`, background: `rgba(${color},0.05)` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: `rgb(${color})` }}>{accepted ? "✓" : matched ? "~" : "✗"}</span>
                  <span style={{ ...C.mono, color: "rgba(255,255,255,0.7)" }}>{r.label}</span>
                  <span style={C.pill(r.confidence === "high" ? "74,222,128" : r.confidence === "medium" ? "251,191,36" : "248,113,113")}>{r.confidence}</span>
                </div>
                <div style={{ display: "flex", gap: 8, fontSize: 9.5, fontVariantNumeric: "tabular-nums" }}>
                  <span style={{ color: "rgba(255,255,255,0.3)" }}>{r.matchCount} match</span>
                  <span style={{ color: `rgb(${color})`, fontWeight: 700 }}>{r.acceptedCount} ok</span>
                </div>
              </div>
              {isOpen && (
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                  <div style={{ ...C.mono, color: "rgba(204,120,92,0.8)", marginBottom: 4, wordBreak: "break-all" }}>{r.selector}</div>
                  {r.examples.map((ex, i) => (
                    <div key={i} style={{ fontSize: 9.5, color: "rgba(255,255,255,0.35)", marginBottom: 2 }}>
                      "{ex.slice(0, 90)}{ex.length > 90 ? "…" : ""}"
                    </div>
                  ))}
                  {r.examples.length === 0 && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)" }}>No accepted examples</div>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Structural Patterns ──────────────────────────────────────────────────────

function PatternsPanel({ patterns }: { patterns: StructuralPattern[] }) {
  if (patterns.length === 0) return (
    <div style={C.section}>
      <div style={C.label}>3 · Structural Patterns</div>
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>No repeating patterns detected.</div>
    </div>
  )
  return (
    <div style={C.section}>
      <div style={C.label}>3 · Structural Patterns</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {patterns.map((p, i) => {
          const roleColor = p.likelyRole === "mixed" ? "251,191,36" : p.likelyRole === "assistant" ? "59,130,246" : p.likelyRole === "user" ? "34,197,94" : "167,139,250"
          return (
            <div key={i} style={{ padding: "6px 9px", borderRadius: 6, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span style={{ ...C.mono, color: "rgba(255,255,255,0.65)" }}>{p.parentTag}</span>
                {p.parentClass && <span style={{ fontSize: 8.5, color: "rgba(255,255,255,0.25)", marginLeft: 5 }}>.{p.parentClass.split(" ")[0].slice(0, 30)}</span>}
                <span style={C.pill(roleColor)}>{p.likelyRole}</span>
              </div>
              <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.3)", fontVariantNumeric: "tabular-nums" }}>
                {p.occurrences}× · {p.childCount} children
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Node List ────────────────────────────────────────────────────────────────

const ROLE_COLOR: Record<string, string> = {
  assistant: "59,130,246",
  user: "34,197,94",
  unknown: "167,139,250",
  "rejected-noise": "248,113,113",
  "rejected-hidden": "107,114,128",
  "rejected-sidebar": "245,158,11",
  "rejected-short": "107,114,128",
  "rejected-extension": "107,114,128",
}

function NodeList({ candidates, onHover }: { candidates: CandidateNode[]; onHover: (c: CandidateNode | null) => void }) {
  const [filter, setFilter] = useState<"all" | "accepted" | "rejected">("accepted")
  const [expanded, setExpanded] = useState<number | null>(null)

  const shown = candidates.filter(c =>
    filter === "all" ? true : filter === "accepted" ? c.accepted : !c.accepted
  ).slice(0, 60)

  return (
    <div style={C.section}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={C.label}>4 · Node Inspector</div>
        <div style={{ display: "flex", gap: 4 }}>
          {(["accepted", "rejected", "all"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} style={C.btn(filter === f)}>{f}</button>
          ))}
        </div>
      </div>
      <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
        {shown.map((c, i) => {
          const color = ROLE_COLOR[c.type] ?? "167,139,250"
          const isOpen = expanded === i
          return (
            <div key={i}
              onMouseEnter={() => onHover(c)}
              onMouseLeave={() => onHover(null)}
              onClick={() => setExpanded(isOpen ? null : i)}
              style={{ padding: "6px 8px", borderRadius: 6, cursor: "pointer", border: `1px solid rgba(${color},0.2)`, background: `rgba(${color},0.04)` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: `rgb(${color})`, flexShrink: 0, display: "inline-block" }} />
                  <span style={{ fontSize: 9, fontWeight: 700, color: `rgb(${color})`, textTransform: "uppercase" }}>{c.type.replace("rejected-", "✗ ")}</span>
                  <span style={{ ...C.mono, color: "rgba(255,255,255,0.4)" }}>{c.tagName}</span>
                  {c.isMarkdown && <span style={C.pill("148,163,184")}>md</span>}
                  {c.codeBlockCount > 0 && <span style={C.pill("148,163,184")}>{c.codeBlockCount} code</span>}
                </div>
                <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontVariantNumeric: "tabular-nums" }}>
                  {c.textLength}ch · d{c.nodeDepth}
                </div>
              </div>
              {isOpen && (
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                  <div style={{ ...C.mono, color: "rgba(204,120,92,0.7)", marginBottom: 3, wordBreak: "break-all", fontSize: 8.5 }}>{c.domPath}</div>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", marginBottom: 3 }}>selector: <span style={{ color: "rgba(255,255,255,0.45)" }}>{c.selectorUsed}</span></div>
                  {c.rejectionReason && <div style={{ fontSize: 9, color: "rgba(248,113,113,0.7)" }}>✗ {c.rejectionReason}</div>}
                  {Object.keys(c.dataAttrs).length > 0 && (
                    <div style={{ marginTop: 3 }}>
                      {Object.entries(c.dataAttrs).slice(0, 4).map(([k, v]) => (
                        <div key={k} style={{ fontSize: 8.5, color: "rgba(255,255,255,0.3)", marginBottom: 1 }}>
                          <span style={{ color: "rgba(255,255,255,0.2)" }}>{k}=</span>"{v}"
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ marginTop: 5, fontSize: 9.5, color: "rgba(255,255,255,0.5)", lineHeight: 1.5, fontFamily: "monospace", whiteSpace: "pre-wrap", maxHeight: 80, overflow: "hidden" }}>
                    {c.textPreview.slice(0, 200)}{c.textPreview.length > 200 ? "…" : ""}
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {candidates.length > 60 && (
          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", textAlign: "center", padding: "4px 0" }}>
            +{candidates.length - 60} more nodes
          </div>
        )}
        {shown.length === 0 && (
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", padding: "8px 0" }}>No nodes in this filter.</div>
        )}
      </div>
    </div>
  )
}

// ─── Assistant Scan Panel ─────────────────────────────────────────────────────
// The "red outline" scan from the debugging guide — but visualized in-panel.

function AssistantScanPanel() {
  const [results, setResults] = useState<AssistantScanResult[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [outlinesOn, setOutlinesOn] = useState(false)
  const outlineCleanups = useRef<Array<() => void>>([])  
  const [expanded, setExpanded] = useState<number | null>(null)

  const runScan = useCallback(() => {
    setScanning(true)
    setTimeout(() => {
      try {
        const r = scanForAssistantCandidates()
        setResults(r)
      } finally {
        setScanning(false)
      }
    }, 30)
  }, [])

  const toggleOutlines = useCallback(() => {
    if (outlinesOn) {
      outlineCleanups.current.forEach(fn => fn())
      outlineCleanups.current = []
      setOutlinesOn(false)
    } else if (results) {
      outlineCleanups.current = results.map(r => highlightSingleNode(r.el, "#3b82f6"))
      setOutlinesOn(true)
    }
  }, [outlinesOn, results])

  return (
    <div style={C.section}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={C.label}>Assistant Heuristic Scan</div>
        <button onClick={runScan} disabled={scanning}
          style={{ ...C.btn(false, "59,130,246"), display: "flex", alignItems: "center", gap: 5, opacity: scanning ? 0.6 : 1 }}>
          {scanning
            ? <><span style={{ width: 9, height: 9, border: "2px solid rgba(59,130,246,0.2)", borderTopColor: "#3b82f6", borderRadius: "50%", animation: "ji-spin 0.7s linear infinite", display: "inline-block" }} /> Scanning…</>
            : "▶ Run Assistant Scan"}
        </button>
        {results && (
          <button onClick={toggleOutlines} style={C.btn(outlinesOn, "59,130,246")}>
            {outlinesOn ? "✓ Outlines ON" : "Outlines OFF"}
          </button>
        )}
        {results && (
          <span style={{ marginLeft: "auto", fontSize: 9, color: results.length > 0 ? "rgb(59,130,246)" : "rgba(248,113,113,0.8)", fontWeight: 700 }}>
            {results.length} candidates
          </span>
        )}
      </div>

      <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.3)", lineHeight: 1.6, marginBottom: 10 }}>
        Finds elements with score ≥25 based on: long text + code/markdown signals.
        These are the nodes the two-path assistant extractor will try to recover.
      </div>

      {results === null && (
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>Click "Run Assistant Scan" to start.</div>
      )}

      {results !== null && results.length === 0 && (
        <div style={{ padding: "10px 0", textAlign: "center" }}>
          <div style={{ fontSize: 20, marginBottom: 6 }}>⚠️</div>
          <div style={{ fontSize: 10.5, color: "rgba(248,113,113,0.8)", lineHeight: 1.6 }}>
            0 assistant candidates found.<br />
            <span style={{ color: "rgba(255,255,255,0.3)" }}>Claude may not have replied yet, or the DOM<br />structure has changed beyond known patterns.</span>
          </div>
        </div>
      )}

      {results !== null && results.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 280, overflowY: "auto" }}>
          {results.map((r, i) => {
            const scoreColor = r.score >= 70 ? "74,222,128" : r.score >= 40 ? "59,130,246" : "251,191,36"
            const isOpen = expanded === i
            return (
              <div key={i} onClick={() => setExpanded(isOpen ? null : i)}
                style={{ padding: "6px 9px", borderRadius: 6, cursor: "pointer", border: `1px solid rgba(${scoreColor},0.25)`, background: `rgba(${scoreColor},0.06)` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                    <span style={{ fontSize: 10, fontWeight: 800, color: `rgb(${scoreColor})`, minWidth: 24 }}>{r.score}</span>
                    {r.hasCode && <span style={C.pill("148,163,184")}>code</span>}
                    {r.hasProse && <span style={C.pill("148,163,184")}>.prose</span>}
                  </div>
                  <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontVariantNumeric: "tabular-nums" }}>{r.textLength}ch</span>
                </div>
                <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", marginTop: 3 }}>
                  {r.reason.join(" · ")}
                </div>
                {isOpen && (
                  <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                    <div style={{ fontSize: 9.5, color: "rgba(255,255,255,0.5)", lineHeight: 1.5, fontFamily: "monospace", whiteSpace: "pre-wrap", maxHeight: 80, overflow: "hidden" }}>
                      {r.textPreview}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Snapshots ────────────────────────────────────────────────────────────────

function SnapshotsPanel() {
  const snaps = loadSnapshots()
  if (snaps.length === 0) return (
    <div style={C.section}>
      <div style={C.label}>5 · Snapshots</div>
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>No saved snapshots yet. Run discovery to save one.</div>
    </div>
  )
  return (
    <div style={C.section}>
      <div style={C.label}>5 · Snapshots ({snaps.length})</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {snaps.map((s, i) => (
          <div key={s.id} style={{ padding: "6px 9px", borderRadius: 6, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: "rgba(255,255,255,0.5)" }}>#{i + 1} · {new Date(s.timestamp).toLocaleTimeString()}</div>
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)" }}>{s.acceptedCount} accepted · {s.dominantStrategy}</div>
            </div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", marginTop: 2, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.url}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function Legend() {
  const items = [
    { color: "59,130,246", label: "Assistant candidate" },
    { color: "34,197,94", label: "User candidate" },
    { color: "167,139,250", label: "Unknown role" },
    { color: "248,113,113", label: "Rejected (noise)" },
    { color: "245,158,11", label: "Rejected (sidebar)" },
    { color: "107,114,128", label: "Rejected (hidden/short)" },
  ]
  return (
    <div style={{ padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
      <div style={C.label}>Overlay Legend</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
        {items.map(item => (
          <div key={item.color} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, border: `2px solid rgb(${item.color})`, background: `rgba(${item.color},0.15)` }} />
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.4)" }}>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

type DebugTab = "summary" | "selectors" | "patterns" | "nodes" | "snapshots" | "assistant-scan"

export function ExtractionDebugger() {
  const [snap, setSnap] = useState<DebugSnapshot | null>(null)
  const [scanning, setScanning] = useState(false)
  const [overlayOn, setOverlayOn] = useState(false)
  const [showRejected, setShowRejected] = useState(false)
  const [tab, setTab] = useState<DebugTab>("summary")
  const cleanupRef = useRef<(() => void) | null>(null)

  const runScan = useCallback(() => {
    setScanning(true)
    // Defer to allow UI to update
    setTimeout(() => {
      try {
        const result = runFullDiscovery()
        setSnap(result)
        saveSnapshot(result)
        if (overlayOn) {
          clearAllOverlays()
          applyOverlays(result.candidates, showRejected)
        }
      } finally {
        setScanning(false)
      }
    }, 50)
  }, [overlayOn, showRejected])

  const toggleOverlay = useCallback(() => {
    if (!snap) return
    if (overlayOn) {
      clearAllOverlays()
      setOverlayOn(false)
    } else {
      applyOverlays(snap.candidates, showRejected)
      setOverlayOn(true)
    }
  }, [overlayOn, snap, showRejected])

  const toggleRejected = useCallback(() => {
    const next = !showRejected
    setShowRejected(next)
    if (overlayOn && snap) {
      clearAllOverlays()
      applyOverlays(snap.candidates, next)
    }
  }, [showRejected, overlayOn, snap])

  const handleHover = useCallback((c: CandidateNode | null) => {
    if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null }
    if (c?.el) {
      const color = c.type === "assistant" ? "#3b82f6" : c.type === "user" ? "#22c55e" : "#f59e0b"
      cleanupRef.current = highlightSingleNode(c.el, color)
    }
  }, [])

  const tabs: DebugTab[] = ["summary", "selectors", "patterns", "nodes", "snapshots", "assistant-scan"]

  return (
    <div>
      {/* Toolbar */}
      <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={runScan} disabled={scanning}
          style={{ ...C.btn(false, "204,120,92"), display: "flex", alignItems: "center", gap: 5, opacity: scanning ? 0.6 : 1 }}>
          {scanning
            ? <><span style={{ width: 10, height: 10, border: "2px solid rgba(204,120,92,0.2)", borderTopColor: "#cc785c", borderRadius: "50%", animation: "ji-spin 0.7s linear infinite", display: "inline-block" }} /> Scanning…</>
            : "▶ Run Discovery"}
        </button>
        {snap && (
          <>
            <button onClick={toggleOverlay} style={C.btn(overlayOn, overlayOn ? "59,130,246" : "148,163,184")}>
              {overlayOn ? "✓ Overlays ON" : "Overlays OFF"}
            </button>
            <button onClick={toggleRejected} style={C.btn(showRejected, "248,113,113")}>
              {showRejected ? "✓ Show Rejected" : "Show Rejected"}
            </button>
          </>
        )}
        {snap && (
          <span style={{ marginLeft: "auto", fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: "monospace" }}>
            {new Date(snap.timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>

      {!snap && !scanning && (
        <div style={{ padding: "28px 14px", textAlign: "center" }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>🔬</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", lineHeight: 1.7 }}>
            Click <strong style={{ color: "#cc785c" }}>Run Discovery</strong> to scan<br />
            Claude's DOM and visualize<br />
            message container candidates.
          </div>
        </div>
      )}

      {snap && (
        <>
          <Legend />

          {/* Sub-tabs */}
          <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.05)", padding: "0 8px", overflowX: "auto" }}>
            {tabs.map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                padding: "7px 9px", fontSize: 9.5, fontWeight: 600,
                color: tab === t ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.3)",
                background: "transparent", border: "none", outline: "none",
                borderBottom: tab === t ? "2px solid #3b82f6" : "2px solid transparent",
                cursor: "pointer", marginBottom: -1, textTransform: "capitalize", whiteSpace: "nowrap"
              }}>{t}</button>
            ))}
          </div>

          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            {tab === "summary"        && <SummaryPanel snap={snap} />}
            {tab === "selectors"      && <SelectorPanel results={snap.selectorResults} />}
            {tab === "patterns"       && <PatternsPanel patterns={snap.patterns} />}
            {tab === "nodes"          && <NodeList candidates={snap.candidates} onHover={handleHover} />}
            {tab === "snapshots"      && <SnapshotsPanel />}
            {tab === "assistant-scan" && <AssistantScanPanel />}
          </div>
        </>
      )}
    </div>
  )
}

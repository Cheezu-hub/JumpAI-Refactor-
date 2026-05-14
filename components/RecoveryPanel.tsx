import React, { useState, useCallback } from "react"
import type { RecoveryPacket, RecoverySection } from "../lib/recovery-packet-builder"
import type { RecoveryEngineResult } from "../lib/recovery-engine"

interface RecoveryPanelProps {
  recoveryResult: RecoveryEngineResult | null
  recoveryPacket: RecoveryPacket | null
  recoveryState: "idle" | "running" | "done" | "error"
  onRecover: () => void
  onJump: (platformId: "chatgpt" | "gemini", packetText: string) => void
  isParentLoading: boolean
}

// ─── Code Block Display ────────────────────────────────────────────────────────

function CodeBlockPreview({ code, language, file }: { code: string; language: string; file?: string }) {
  const [expanded, setExpanded] = useState(false)
  const preview = code.slice(0, expanded ? 600 : 160)
  return (
    <div style={{
      background: "rgba(0,0,0,0.4)", borderRadius: 6, border: "1px solid rgba(255,255,255,0.06)",
      overflow: "hidden", marginBottom: 6
    }}>
      {file && (
        <div style={{
          padding: "4px 10px", background: "rgba(255,255,255,0.04)",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
          fontSize: 9.5, color: "#60a5fa", fontFamily: "monospace"
        }}>
          {file}
        </div>
      )}
      <div style={{ padding: "8px 10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <span style={{
            fontSize: 9, color: "rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.05)",
            padding: "2px 5px", borderRadius: 3, fontFamily: "monospace"
          }}>{language}</span>
          {code.length > 160 && (
            <button onClick={() => setExpanded(v => !v)} style={{
              background: "none", border: "none", cursor: "pointer",
              fontSize: 9, color: "rgba(255,255,255,0.3)", padding: "2px 4px"
            }}>{expanded ? "▲ collapse" : "▼ expand"}</button>
          )}
        </div>
        <pre style={{
          margin: 0, fontSize: 10, lineHeight: 1.5, color: "rgba(255,255,255,0.75)",
          fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all",
          maxHeight: expanded ? 300 : "auto", overflowY: expanded ? "auto" : "hidden"
        }}>{preview}{!expanded && code.length > 160 ? "…" : ""}</pre>
      </div>
    </div>
  )
}

// ─── Section Display ──────────────────────────────────────────────────────────

function SectionBlock({ section }: { section: RecoverySection }) {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ marginBottom: 8 }}>
      <button onClick={() => setOpen(v => !v)} style={{
        width: "100%", display: "flex", alignItems: "center", gap: 6,
        background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 6, padding: "6px 10px", cursor: "pointer", textAlign: "left" as const
      }}>
        <span style={{ fontSize: 12 }}>{section.icon}</span>
        <span style={{ flex: 1, fontSize: 10.5, fontWeight: 600, color: "rgba(255,255,255,0.7)", letterSpacing: "0.03em" }}>
          {section.label}
        </span>
        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{
          padding: "8px 10px", background: "rgba(0,0,0,0.2)", borderRadius: "0 0 6px 6px",
          borderLeft: "1px solid rgba(255,255,255,0.04)", borderRight: "1px solid rgba(255,255,255,0.04)",
          borderBottom: "1px solid rgba(255,255,255,0.04)", marginTop: -1,
          fontSize: 10.5, color: "rgba(255,255,255,0.65)", lineHeight: 1.65, whiteSpace: "pre-wrap" as const
        }}>
          {section.content}
        </div>
      )}
    </div>
  )
}

// ─── Stats Bar ────────────────────────────────────────────────────────────────

function StatsBar({ result, packet }: { result: RecoveryEngineResult; packet: RecoveryPacket }) {
  const stats = [
    { label: "Code Blocks", val: result.codeBlocks.length, color: "#60a5fa" },
    { label: "Files", val: result.inferredFiles.length, color: "#34d399" },
    { label: "Incomplete", val: result.incompleteItems.length, color: "#fbbf24" },
    { label: "Tokens", val: `~${packet.tokenEstimate}`, color: "#a78bfa" },
  ]
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
      gap: 4, padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.05)"
    }}>
      {stats.map(s => (
        <div key={s.label} style={{
          background: "rgba(255,255,255,0.03)", borderRadius: 6, padding: "6px 4px",
          textAlign: "center" as const, border: "1px solid rgba(255,255,255,0.05)"
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: s.color }}>{s.val}</div>
          <div style={{ fontSize: 8.5, color: "rgba(255,255,255,0.3)", marginTop: 1 }}>{s.label}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Platform Jump Row ────────────────────────────────────────────────────────

function RecoveryJumpRow({ onJump, packetText, disabled }: {
  onJump: (platformId: "chatgpt" | "gemini", text: string) => void
  packetText: string
  disabled: boolean
}) {
  const [copied, setCopied] = useState(false)

  const copyText = async () => {
    await navigator.clipboard.writeText(packetText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const platforms = [
    { id: "chatgpt" as const, label: "ChatGPT", color: "#10a37f", bg: "rgba(16,163,127,0.12)", border: "rgba(16,163,127,0.3)" },
    { id: "gemini" as const, label: "Gemini", color: "#4285f4", bg: "rgba(66,133,244,0.12)", border: "rgba(66,133,244,0.3)" },
  ]

  return (
    <div style={{ padding: "10px", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: "rgba(255,255,255,0.25)", letterSpacing: "0.08em", textTransform: "uppercase" as const, marginBottom: 6 }}>
        Inject Recovery Packet
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {platforms.map(p => (
          <button key={p.id} onClick={() => onJump(p.id, packetText)} disabled={disabled} style={{
            flex: 1, padding: "7px 4px", borderRadius: 7, cursor: disabled ? "not-allowed" : "pointer",
            background: p.bg, border: `1px solid ${p.border}`, color: p.color,
            fontSize: 10, fontWeight: 700, outline: "none", opacity: disabled ? 0.5 : 1, transition: "all 0.15s"
          }}>
            {p.label} ↗
          </button>
        ))}
        <button onClick={copyText} disabled={disabled} style={{
          padding: "7px 10px", borderRadius: 7, cursor: disabled ? "not-allowed" : "pointer",
          background: copied ? "rgba(74,222,128,0.12)" : "rgba(255,255,255,0.05)",
          border: copied ? "1px solid rgba(74,222,128,0.35)" : "1px solid rgba(255,255,255,0.08)",
          color: copied ? "#4ade80" : "rgba(255,255,255,0.5)",
          fontSize: 10, fontWeight: 600, outline: "none", opacity: disabled ? 0.5 : 1
        }}>
          {copied ? "✓" : "Copy"}
        </button>
      </div>
      <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", marginTop: 6, lineHeight: 1.5 }}>
        Opens the platform in a new tab. Packet auto-fills the editor. <strong style={{ color: "rgba(255,255,255,0.35)" }}>Does not auto-send</strong> — you review first.
      </div>
    </div>
  )
}

// ─── Idle State ───────────────────────────────────────────────────────────────

function IdleState({ onRecover, isLoading }: { onRecover: () => void; isLoading: boolean }) {
  return (
    <div style={{ padding: "20px 14px", textAlign: "center" as const }}>
      <div style={{ fontSize: 28, marginBottom: 10 }}>🔄</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.7)", marginBottom: 6 }}>
        Recovery Mode
      </div>
      <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", lineHeight: 1.6, marginBottom: 14 }}>
        Extract structured workflow state — code blocks, file structure,
        incomplete tasks, and architecture decisions — so another AI can
        continue your session without losing context.
      </div>
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 14,
        textAlign: "left" as const
      }}>
        {[
          ["💻", "Code block recovery"],
          ["📁", "Hybrid file inference"],
          ["⚠️", "Incomplete detection"],
          ["🏗", "Architecture extraction"],
          ["⚙️", "Workflow state"],
          ["💬", "Recent transcript"],
        ].map(([icon, label]) => (
          <div key={label as string} style={{
            display: "flex", alignItems: "center", gap: 5,
            background: "rgba(255,255,255,0.02)", borderRadius: 6,
            padding: "5px 8px", fontSize: 9.5, color: "rgba(255,255,255,0.45)"
          }}>
            <span>{icon}</span>{label}
          </div>
        ))}
      </div>
      <button onClick={onRecover} disabled={isLoading} style={{
        width: "100%", padding: "9px", borderRadius: 8, cursor: isLoading ? "not-allowed" : "pointer",
        background: "linear-gradient(135deg, rgba(124,58,237,0.25), rgba(59,130,246,0.25))",
        border: "1px solid rgba(124,58,237,0.4)", color: "#a78bfa",
        fontSize: 11, fontWeight: 700, outline: "none", transition: "all 0.2s",
        opacity: isLoading ? 0.6 : 1, letterSpacing: "0.03em"
      }}>
        {isLoading ? "Recovering…" : "🔄 Recover Session"}
      </button>
    </div>
  )
}

// ─── Main Recovery Panel ──────────────────────────────────────────────────────

type RecoveryView = "overview" | "code" | "files"

export function RecoveryPanel({
  recoveryResult,
  recoveryPacket,
  recoveryState,
  onRecover,
  onJump,
  isParentLoading,
}: RecoveryPanelProps) {
  const [view, setView] = useState<RecoveryView>("overview")

  if (recoveryState === "idle" || recoveryState === "running") {
    return <IdleState onRecover={onRecover} isLoading={recoveryState === "running" || isParentLoading} />
  }

  if (recoveryState === "error" || !recoveryResult || !recoveryPacket) {
    return (
      <div style={{ padding: "20px 14px", textAlign: "center" as const }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>⚠️</div>
        <div style={{ fontSize: 11, color: "#f87171", marginBottom: 10 }}>Recovery failed — no messages extracted</div>
        <button onClick={onRecover} style={{
          padding: "7px 16px", borderRadius: 7, cursor: "pointer",
          background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.3)",
          color: "#f87171", fontSize: 10, fontWeight: 600, outline: "none"
        }}>Retry</button>
      </div>
    )
  }

  const subTabs: { id: RecoveryView; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "code", label: `Code (${recoveryResult.codeBlocks.length})` },
    { id: "files", label: `Files (${recoveryResult.inferredFiles.length})` },
  ]

  return (
    <div>
      {/* Stats bar */}
      <StatsBar result={recoveryResult} packet={recoveryPacket} />

      {/* Sub-tabs */}
      <div style={{
        display: "flex", borderBottom: "1px solid rgba(255,255,255,0.05)",
        padding: "0 10px", gap: 2
      }}>
        {subTabs.map(t => (
          <button key={t.id} onClick={() => setView(t.id)} style={{
            padding: "8px 10px", fontSize: 9.5, fontWeight: 700, letterSpacing: "0.04em",
            color: view === t.id ? "#a78bfa" : "rgba(255,255,255,0.3)",
            background: "transparent", border: "none", outline: "none", textTransform: "uppercase" as const,
            borderBottom: view === t.id ? "2px solid #a78bfa" : "2px solid transparent",
            cursor: "pointer", marginBottom: -1, whiteSpace: "nowrap" as const, transition: "all 0.15s"
          }}>{t.label}</button>
        ))}
        <button onClick={onRecover} title="Re-run recovery" style={{
          marginLeft: "auto", padding: "6px 8px", background: "none", border: "none",
          color: "rgba(255,255,255,0.3)", cursor: "pointer", fontSize: 11
        }}>↺</button>
      </div>

      {/* Content */}
      <div style={{ maxHeight: 280, overflowY: "auto", padding: "10px" }}>
        {view === "overview" && recoveryPacket.sections
          .filter(s => s.label !== "Recovered Code Blocks" && s.label !== "Generated Files")
          .map(s => <SectionBlock key={s.label} section={s} />)
        }

        {view === "code" && (
          recoveryResult.codeBlocks.length === 0
            ? <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.3)", textAlign: "center" as const, padding: "20px 0" }}>No code blocks recovered</div>
            : recoveryResult.codeBlocks.slice(0, 12).map((b, i) => (
              <CodeBlockPreview key={i} code={b.code} language={b.language} file={b.inferredFile || b.heading} />
            ))
        )}

        {view === "files" && (
          recoveryResult.inferredFiles.length === 0
            ? <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.3)", textAlign: "center" as const, padding: "20px 0" }}>No files inferred</div>
            : (
              <div>
                {(["explicit", "heuristic", "nlp"] as const).map(src => {
                  const group = recoveryResult.inferredFiles.filter(f => f.source === src)
                  if (group.length === 0) return null
                  const label = src === "explicit" ? "Explicitly Mentioned" : src === "heuristic" ? "Structurally Inferred" : "NLP Inferred"
                  const color = src === "explicit" ? "#34d399" : src === "heuristic" ? "#60a5fa" : "#fbbf24"
                  return (
                    <div key={src} style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color, letterSpacing: "0.07em", textTransform: "uppercase" as const, marginBottom: 5 }}>
                        {label}
                      </div>
                      {group.map(f => (
                        <div key={f.path} style={{
                          display: "flex", alignItems: "center", gap: 8, padding: "5px 8px",
                          background: "rgba(255,255,255,0.02)", borderRadius: 5, marginBottom: 3,
                          border: "1px solid rgba(255,255,255,0.04)"
                        }}>
                          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>📄</span>
                          <span style={{ fontSize: 10.5, fontFamily: "monospace", color: "rgba(255,255,255,0.7)", flex: 1 }}>{f.path}</span>
                          <span style={{
                            fontSize: 8, color: f.confidence === "high" ? "#34d399" : f.confidence === "medium" ? "#fbbf24" : "rgba(255,255,255,0.3)",
                            background: "rgba(255,255,255,0.04)", padding: "1px 4px", borderRadius: 3
                          }}>{f.confidence}</span>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )
        )}
      </div>

      {/* Jump row */}
      <RecoveryJumpRow
        onJump={onJump}
        packetText={recoveryPacket.text}
        disabled={isParentLoading}
      />
    </div>
  )
}

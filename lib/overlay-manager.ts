/**
 * JumpAI — DOM Overlay Manager
 *
 * Injects visual overlays directly onto Claude's DOM nodes:
 *  - Blue outline + label  → assistant candidates
 *  - Green outline + label → user candidates
 *  - Red outline + label   → rejected nodes
 *  - Gray outline + label  → unknown-role candidates
 *
 * All overlays are tracked and torn down cleanly via `clearAllOverlays()`.
 * Labels show: candidate type, text length, selector, detected role, node depth.
 */

import type { CandidateNode } from "./dom-debugger"

// ─── Config ───────────────────────────────────────────────────────────────────

const OVERLAY_ATTR = "data-jumpai-overlay"
const LABEL_ATTR   = "data-jumpai-label"

const COLORS: Record<string, { border: string; bg: string; text: string; dot: string }> = {
  assistant:       { border: "#3b82f6", bg: "rgba(59,130,246,0.08)", text: "#93c5fd", dot: "#3b82f6" },
  user:            { border: "#22c55e", bg: "rgba(34,197,94,0.07)",  text: "#86efac", dot: "#22c55e" },
  unknown:         { border: "#a78bfa", bg: "rgba(167,139,250,0.06)", text: "#c4b5fd", dot: "#a78bfa" },
  "rejected-noise":    { border: "#ef4444", bg: "rgba(239,68,68,0.05)",  text: "#fca5a5", dot: "#ef4444" },
  "rejected-hidden":   { border: "#6b7280", bg: "rgba(107,114,128,0.04)", text: "#9ca3af", dot: "#6b7280" },
  "rejected-sidebar":  { border: "#f59e0b", bg: "rgba(245,158,11,0.05)", text: "#fcd34d", dot: "#f59e0b" },
  "rejected-short":    { border: "#6b7280", bg: "rgba(107,114,128,0.03)", text: "#9ca3af", dot: "#6b7280" },
  "rejected-extension":{ border: "#6b7280", bg: "rgba(107,114,128,0.03)", text: "#9ca3af", dot: "#6b7280" },
}

// ─── Overlay State ────────────────────────────────────────────────────────────

const overlayedEls = new Set<Element>()
const injectedLabels: HTMLElement[] = []

// ─── Core Overlay Injection ───────────────────────────────────────────────────

function getRelativePos(el: Element): { top: number; left: number; width: number; height: number } {
  const rect = el.getBoundingClientRect()
  return {
    top:    rect.top    + window.scrollY,
    left:   rect.left   + window.scrollX,
    width:  rect.width,
    height: rect.height,
  }
}

function makeLabel(c: CandidateNode, colors: typeof COLORS[string]): HTMLElement {
  const label = document.createElement("div")
  label.setAttribute(LABEL_ATTR, "1")
  label.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    z-index: 2147483640;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 7px;
    border-radius: 0 0 6px 0;
    background: rgba(10,10,12,0.92);
    border-right: 1px solid ${colors.border}55;
    border-bottom: 1px solid ${colors.border}55;
    backdrop-filter: blur(8px);
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 9px;
    line-height: 1.5;
    max-width: 260px;
  `

  const typeRow = document.createElement("div")
  typeRow.style.cssText = `display:flex;align-items:center;gap:5px;`

  const dot = document.createElement("span")
  dot.style.cssText = `
    width:6px;height:6px;border-radius:50%;
    background:${colors.dot};
    box-shadow:0 0 5px ${colors.dot};
    flex-shrink:0;
  `
  const typeText = document.createElement("span")
  typeText.style.cssText = `color:${colors.text};font-weight:700;letter-spacing:0.04em;text-transform:uppercase;font-size:8px;`
  typeText.textContent = c.type.replace("rejected-", "✗ ")

  typeRow.appendChild(dot)
  typeRow.appendChild(typeText)
  label.appendChild(typeRow)

  const rows: Array<[string, string]> = [
    ["selector",  c.selectorUsed],
    ["depth",     String(c.nodeDepth)],
    ["text",      `${c.textLength} chars`],
    ["tag",       c.tagName],
  ]
  if (c.codeBlockCount > 0) rows.push(["code", `${c.codeBlockCount} block(s)`])
  if (c.isMarkdown) rows.push(["markdown", "✓"])
  if (c.rejectionReason) rows.push(["reason", c.rejectionReason.slice(0, 50)])

  for (const [k, v] of rows) {
    const row = document.createElement("div")
    row.style.cssText = `display:flex;gap:4px;`
    row.innerHTML = `
      <span style="color:rgba(255,255,255,0.25);min-width:52px;">${k}</span>
      <span style="color:rgba(255,255,255,0.65);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${v}</span>
    `
    label.appendChild(row)
  }

  return label
}

function applyOverlay(c: CandidateNode, showRejected: boolean): void {
  if (!c.el || overlayedEls.has(c.el)) return
  if (!c.accepted && !showRejected) return

  const colors = COLORS[c.type] ?? COLORS["unknown"]

  // Skip hidden/0-size nodes
  const rect = c.el.getBoundingClientRect()
  if (rect.width < 4 || rect.height < 4) return

  // Outline on the real element (non-destructive)
  const el = c.el as HTMLElement
  const prevOutline = el.style.outline
  const prevOutlineOffset = el.style.outlineOffset
  const prevPosition = el.style.position
  const prevZIndex = el.style.zIndex

  el.setAttribute(OVERLAY_ATTR, c.type)
  el.style.outline = `2px solid ${colors.border}`
  el.style.outlineOffset = "-1px"

  // Ensure relative/absolute positioning so label can anchor
  const computedPos = window.getComputedStyle(el).position
  if (computedPos === "static") {
    el.style.position = "relative"
  }

  // Label
  const label = makeLabel(c, colors)
  el.appendChild(label)
  injectedLabels.push(label)

  overlayedEls.add(c.el)

  // Restore on cleanup
  ;(c.el as any).__jumpai_prev_outline = prevOutline
  ;(c.el as any).__jumpai_prev_outline_offset = prevOutlineOffset
  ;(c.el as any).__jumpai_prev_position = prevPosition
  ;(c.el as any).__jumpai_prev_zindex = prevZIndex
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function applyOverlays(candidates: CandidateNode[], showRejected = false): void {
  clearAllOverlays()
  for (const c of candidates) {
    applyOverlay(c, showRejected)
  }
}

export function clearAllOverlays(): void {
  // Remove labels
  for (const label of injectedLabels) {
    label.parentElement?.removeChild(label)
  }
  injectedLabels.length = 0

  // Restore element styles
  for (const el of overlayedEls) {
    const h = el as HTMLElement
    h.removeAttribute(OVERLAY_ATTR)
    h.style.outline = (h as any).__jumpai_prev_outline ?? ""
    h.style.outlineOffset = (h as any).__jumpai_prev_outline_offset ?? ""
    h.style.position = (h as any).__jumpai_prev_position ?? ""
    h.style.zIndex = (h as any).__jumpai_prev_zindex ?? ""
    delete (h as any).__jumpai_prev_outline
    delete (h as any).__jumpai_prev_outline_offset
    delete (h as any).__jumpai_prev_position
    delete (h as any).__jumpai_prev_zindex
  }
  overlayedEls.clear()
}

export function highlightSingleNode(el: Element, color = "#f59e0b"): () => void {
  const h = el as HTMLElement
  const prev = h.style.outline
  h.style.outline = `3px solid ${color}`
  return () => { h.style.outline = prev }
}

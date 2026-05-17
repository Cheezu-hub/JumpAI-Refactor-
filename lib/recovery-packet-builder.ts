/**
 * Recovery Packet Builder
 *
 * Assembles a compact, structured Project Recovery Packet from
 * RecoveryEngineResult that feels like a natural continuation prompt —
 * not a report. The output should let another AI continue seamlessly.
 */

import type { RecoveryEngineResult } from "./recovery-engine"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecoveryPacket {
  /** Raw markdown text ready for injection into another AI */
  text: string
  /** Estimated token count */
  tokenEstimate: number
  /** Key sections for structured preview */
  sections: RecoverySection[]
  generatedAt: number
}

export interface RecoverySection {
  label: string
  content: string
  icon: string
}

// ─── Token Estimator ──────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8)
}

// ─── Section Builders ─────────────────────────────────────────────────────────

function buildGoalSection(result: RecoveryEngineResult): string {
  return result.projectGoal
}

function buildStackSection(result: RecoveryEngineResult): string {
  if (result.architectureDecisions.length === 0) return ""
  return result.architectureDecisions
    .slice(0, 10)
    .map(d => `- ${d.text}`)
    .join("\n")
}

function buildCompletedSection(result: RecoveryEngineResult): string {
  const { completedWork } = result.workflowState
  if (!completedWork || completedWork.length === 0) return ""
  return completedWork.map(w => `- ${w}`).join("\n")
}

function buildBlockerSection(result: RecoveryEngineResult): string {
  return result.workflowState.currentBlocker || ""
}

function buildPendingSection(result: RecoveryEngineResult): string {
  if (result.incompleteItems.length === 0) return ""
  return result.incompleteItems
    .slice(0, 8)
    .map(i => `- ${i.description}`)
    .join("\n")
}

function buildAffectedAreaSection(result: RecoveryEngineResult): string {
  return result.workflowState.likelyAffectedArea || ""
}

function buildNextStepSection(result: RecoveryEngineResult): string {
  return result.workflowState.nextImmediateStep || "Continue implementation from the last point in the transcript above."
}

function buildCodeSection(result: RecoveryEngineResult): string {
  if (result.codeBlocks.length === 0) return ""

  // Only include the most important code blocks (last 5 assistant-generated)
  // Prioritize blocks with inferred files or headings
  const ranked = [...result.codeBlocks]
    .filter(b => b.language !== "text" && b.code.length > 40)
    .slice(-5)

  return ranked.map(b => {
    const label = b.inferredFile
      ? `*${b.inferredFile}*`
      : b.heading
      ? `*${b.heading}*`
      : ""
    const header = label ? `${label}\n` : ""
    return `${header}\`\`\`${b.language}\n${b.code.slice(0, 500)}\n\`\`\``
  }).join("\n\n")
}

// ─── Main Formatter ───────────────────────────────────────────────────────────

export function buildRecoveryPacket(result: RecoveryEngineResult): RecoveryPacket {
  const goalContent = buildGoalSection(result)
  const stackContent = buildStackSection(result)
  const completedContent = buildCompletedSection(result)
  const blockerContent = buildBlockerSection(result)
  const pendingContent = buildPendingSection(result)
  const affectedAreaContent = buildAffectedAreaSection(result)
  const nextStepContent = buildNextStepSection(result)
  const codeContent = buildCodeSection(result)
  const transcriptContent = result.recentTranscript

  const sections: RecoverySection[] = []
  const add = (label: string, icon: string, content: string) => {
    if (content.trim()) sections.push({ label, icon, content: content.trim() })
  }

  add("Current Project", "🎯", goalContent)
  add("Stack / Architecture", "🏗", stackContent)
  add("Completed Work", "✅", completedContent)
  add("Current Blocker", "⛔", blockerContent)
  add("Incomplete / Pending Work", "⚠️", pendingContent)
  add("Likely Affected Area", "🔍", affectedAreaContent)
  add("Recovered Code Context", "💻", codeContent)
  add("Next Immediate Step", "➡", nextStepContent)
  add("Compressed Recent Transcript", "💬", transcriptContent)

  // Build the final natural-continuation text
  const lines: string[] = []

  if (goalContent) lines.push(`Current Project:\n${goalContent}`)
  if (stackContent) lines.push(`Stack / Architecture:\n${stackContent}`)
  if (completedContent) lines.push(`Completed Work:\n${completedContent}`)
  if (blockerContent) lines.push(`Current Blocker:\n${blockerContent}`)
  if (pendingContent) lines.push(`Incomplete / Pending Work:\n${pendingContent}`)
  if (affectedAreaContent) lines.push(`Likely Affected Area:\n${affectedAreaContent}`)
  if (codeContent) lines.push(`Recovered Code Context:\n${codeContent}`)
  if (nextStepContent) lines.push(`Next Immediate Step:\n${nextStepContent}`)
  if (transcriptContent) lines.push(`Recent Transcript Context:\n${transcriptContent}`)

  const text = lines.join("\n\n").trim()

  return {
    text,
    tokenEstimate: estimateTokens(text),
    sections,
    generatedAt: Date.now(),
  }
}

/** Format recovery packet for a specific platform (keeps it natural, no branding) */
export function formatRecoveryPacketForPlatform(
  packet: RecoveryPacket,
  _platformId: string
): string {
  // Currently the format is platform-agnostic and universally compatible.
  // Platform-specific tuning can be added here in future iterations.
  return packet.text
}

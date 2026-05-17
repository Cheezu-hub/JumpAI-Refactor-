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
  const filesContent = buildFilesSection(result)
  const archContent = buildArchSection(result)
  const incompleteContent = buildIncompleteSection(result)
  const workflowContent = buildWorkflowSection(result)
  const codeContent = buildCodeSection(result)
  const transcriptContent = result.recentTranscript

  const sections: RecoverySection[] = []
  const add = (label: string, icon: string, content: string) => {
    if (content.trim()) sections.push({ label, icon, content: content.trim() })
  }

  add("Current Project", "🎯", goalContent)
  add("Generated Files", "📁", filesContent)
  add("Architecture Decisions", "🏗", archContent)
  add("Incomplete Implementations", "⚠️", incompleteContent)
  add("Current Progress", "⚙️", workflowContent)
  add("Recovered Code Blocks", "💻", codeContent)
  add("Recent Transcript", "💬", transcriptContent)

  // Build the final natural-continuation text
  const lines: string[] = []

  if (goalContent) {
    lines.push(`## Current Project\n${goalContent}`)
  }
  if (filesContent) {
    lines.push(`## Generated Files\n${filesContent}`)
  }
  if (archContent) {
    lines.push(`## Architecture Decisions\n${archContent}`)
  }
  if (workflowContent) {
    lines.push(`## Current Progress\n${workflowContent}`)
  }
  if (incompleteContent) {
    lines.push(`## Incomplete Implementations\n${incompleteContent}`)
  }
  if (result.workflowState.activeBlocker) {
    // Surface as top-level blocker for extra visibility
    lines.push(`## Current Blocker\n${result.workflowState.activeBlocker}`)
  }
  if (codeContent) {
    lines.push(`## Recovered Code Blocks\n${codeContent}`)
  }
  if (transcriptContent) {
    lines.push(`## Recent Transcript\n${transcriptContent}`)
  }

  // Next suggested step — synthesised from incomplete + blocker
  const nextStep = result.incompleteItems[0]?.description
    || result.workflowState.activeBlocker
    || "Continue implementation from the last point in the transcript above."
  lines.push(`## Next Suggested Step\n${nextStep}`)

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

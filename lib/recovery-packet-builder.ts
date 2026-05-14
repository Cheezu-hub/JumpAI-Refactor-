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

function buildFilesSection(result: RecoveryEngineResult): string {
  if (result.inferredFiles.length === 0) return ""
  const lines: string[] = []
  const bySource = {
    explicit: result.inferredFiles.filter(f => f.source === "explicit"),
    heuristic: result.inferredFiles.filter(f => f.source === "heuristic"),
    nlp: result.inferredFiles.filter(f => f.source === "nlp"),
  }
  if (bySource.explicit.length > 0) {
    lines.push(...bySource.explicit.slice(0, 12).map(f => `- ${f.path}`))
  }
  if (bySource.heuristic.length > 0) {
    const suffix = bySource.heuristic.map(f => `- ${f.path} *(inferred)*`)
    lines.push(...suffix.slice(0, 8))
  }
  if (bySource.nlp.length > 0 && lines.length < 15) {
    lines.push(...bySource.nlp.slice(0, 4).map(f => `- ${f.path} *(likely)*`))
  }
  return lines.join("\n")
}

function buildArchSection(result: RecoveryEngineResult): string {
  if (result.architectureDecisions.length === 0) return ""
  return result.architectureDecisions
    .slice(0, 8)
    .map(d => `- ${d.text}`)
    .join("\n")
}

function buildIncompleteSection(result: RecoveryEngineResult): string {
  if (result.incompleteItems.length === 0) return ""
  return result.incompleteItems
    .slice(0, 6)
    .map(i => `- ${i.description}`)
    .join("\n")
}

function buildWorkflowSection(result: RecoveryEngineResult): string {
  const { workflowState } = result
  const parts: string[] = []

  if (workflowState.recentActivity.length > 0) {
    parts.push("**Recently completed:**")
    parts.push(...workflowState.recentActivity.slice(0, 3).map(a => `- ${a}`))
  }

  if (workflowState.activeBlocker) {
    parts.push(`\n**Active blocker:** ${workflowState.activeBlocker}`)
  }

  if (workflowState.lastDebugAttempt) {
    parts.push(`\n**Last debug attempt:** ${workflowState.lastDebugAttempt}`)
  }

  if (workflowState.unresolvedIssues.length > 0) {
    parts.push("\n**Unresolved issues:**")
    parts.push(...workflowState.unresolvedIssues.slice(0, 3).map(e => `- ${e}`))
  }

  return parts.join("\n")
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

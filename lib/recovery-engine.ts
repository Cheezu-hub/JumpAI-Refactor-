/**
 * JumpAI Recovery Engine
 *
 * Core pipeline for recovering interrupted AI coding sessions.
 * Implements: code block recovery, hybrid file inference (3 layers),
 * incomplete detection, architecture extraction, workflow state reconstruction.
 *
 * Performance: deterministic extraction + lightweight NLP only.
 * No embeddings, no vector databases, no cloud AI.
 */

import type { RawMessage } from "./extractor"
import {
  filterNoiseMessages,
  extractObjectiveFromUser,
  extractAccomplishments,
  detectCurrentBlocker,
} from "./workflow-engine"

// ─── NOISE GATE ───────────────────────────────────────────────────────────────
// Delegated entirely to workflow-engine.ts (filterNoiseMessages).
// isRecoveryNoise is kept as a local alias for legacy code paths below.

const UI_CHROME_RE = /^(Copy|Edit|Retry|Regenerate|Like|Dislike|Share|Export|Help|Feedback|Publish|Artifacts?|Preview|Run|Download|Code)\s*$/gim
const SEPARATOR_RE = /^\s*[-–—]{3,}\s*$/gm

function isRecoveryNoise(text: string): boolean {
  const t = text.trim()
  if (t.length < 3) return true
  const lo = t.toLowerCase()
  const UI_LABELS = new Set([
    "free plan", "pro plan", "upgrade", "new chat", "new conversation",
    "projects", "share", "artifacts", "artifact", "copy code", "download",
    "sign out", "log in", "settings", "keyboard shortcuts",
  ])
  if (UI_LABELS.has(lo)) return true
  if (/^[\d,]+\s*tokens?$/i.test(t)) return true
  if (/^\d+:\d+\s*(am|pm)?$/i.test(t)) return true
  if (t.length < 40 && /^[A-Z0-9\s.,!?]+$/.test(t) && t.split(" ").length < 4) return true
  return false
}

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface RecoveredCodeBlock {
  language: string
  code: string
  inferredFile?: string
  heading?: string       // nearest markdown heading above this block
  intentSignal?: string  // create / implement / update / fix / etc.
}

export interface InferredFile {
  path: string
  confidence: "high" | "medium" | "low"
  source: "explicit" | "heuristic" | "nlp"
  associatedCode?: string
}

export interface ArchitectureDecision {
  text: string
  category: "framework" | "library" | "auth" | "database" | "state" | "deployment" | "other"
}

export interface IncompleteItem {
  description: string
  signal: string // the phrase that triggered detection
}

export interface WorkflowState {
  completedWork: string[]
  currentBlocker?: string
  unresolvedIssues: string[]
  likelyAffectedArea?: string
  nextImmediateStep?: string
}

export interface RecoveryEngineResult {
  codeBlocks: RecoveredCodeBlock[]
  inferredFiles: InferredFile[]
  architectureDecisions: ArchitectureDecision[]
  incompleteItems: IncompleteItem[]
  workflowState: WorkflowState
  projectGoal: string
  recentTranscript: string
  processingMs: number
}

// ─── CODE BLOCK RECOVERY ENGINE ───────────────────────────────────────────────

const FENCED_BLOCK_RE = /```([\w+-]*)\n([\s\S]*?)```/g

const SUPPORTED_LANGS = new Set([
  "typescript","javascript","tsx","jsx","json","python","py",
  "shell","sh","bash","markdown","md","html","css","scss",
  "sql","yaml","yml","graphql","prisma","go","rust","java","kt"
])

function parseCodeBlocks(content: string, heading?: string): RecoveredCodeBlock[] {
  const blocks: RecoveredCodeBlock[] = []
  let m: RegExpExecArray | null
  const re = new RegExp(FENCED_BLOCK_RE.source, "g")
  while ((m = re.exec(content)) !== null) {
    const rawLang = (m[1] || "").toLowerCase().trim()
    const lang = SUPPORTED_LANGS.has(rawLang) ? rawLang : rawLang || "text"
    const code = m[2]
    if (!code || code.trim().length < 10) continue
    blocks.push({ language: lang, code: code.trim(), heading })
  }
  return blocks
}

function extractNearestHeading(content: string, blockOffset: number): string | undefined {
  const before = content.slice(0, blockOffset)
  const lines = before.split("\n").reverse()
  for (const line of lines) {
    const hm = line.match(/^#{1,3}\s+(.+)/)
    if (hm) return hm[1].trim()
  }
  return undefined
}

// ─── LAYER 1 — Deterministic File Detection ───────────────────────────────────

// PRIORITY 4: Technology/library blocklist — these look like files but are NOT
const TECH_NAMES = new Set([
  "node.js", "nodejs", "react", "vue", "angular", "svelte", "solid",
  "next.js", "nextjs", "nuxt", "remix", "astro", "vite",
  "express", "fastify", "nest.js", "nestjs",
  "prisma", "drizzle", "mongoose", "sequelize", "typeorm",
  "supabase", "firebase", "planetscale", "neon",
  "postgresql", "mysql", "sqlite", "mongodb",
  "tailwindcss", "tailwind", "bootstrap", "shadcn",
  "zustand", "redux", "jotai", "recoil",
  "nextauth", "auth.js", "clerk", "lucia",
  "vercel", "netlify", "railway", "fly.io",
  "typescript", "javascript", "python", "rust", "golang",
  "webpack", "esbuild", "turbopack", "parcel",
  "jest", "vitest", "playwright", "cypress",
  "eslint", "prettier", "husky",
])

// Requires either a path separator OR a known project-relative prefix
// to avoid matching bare words that happen to have extensions
const EXPLICIT_FILE_RE = /\b([\w.\-/]+\.(?:tsx?|jsx?|py|rs|go|java|kt|swift|rb|php|css|scss|html|json|yaml|yml|toml|env|md|sql|sh|bash|prisma|graphql|vue|svelte))\b/g

function isLikelyTechName(f: string): boolean {
  const base = f.split("/").pop()?.toLowerCase() ?? ""
  // reject bare single-segment entries that match known tech names
  if (!f.includes("/") && TECH_NAMES.has(base.replace(/\.(ts|js|tsx|jsx|py)$/, ""))) return true
  // reject suspiciously short bare filenames with no directory context
  if (!f.includes("/") && f.length < 6) return true
  return false
}

function extractExplicitFiles(text: string): string[] {
  const files: string[] = []
  const seen = new Set<string>()
  const re = new RegExp(EXPLICIT_FILE_RE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const f = m[1]
    if (seen.has(f)) continue
    if (f.includes("node_modules")) continue
    if (f.split("/").length > 6) continue
    if (isLikelyTechName(f)) continue
    seen.add(f)
    files.push(f)
  }
  return files
}

// ─── LAYER 2 — Structural Heuristics ─────────────────────────────────────────

const COMPONENT_NAME_RE = /(?:function|const|class)\s+([A-Z][A-Za-z0-9]+)/

interface HeadingCodePair {
  heading: string
  code: RecoveredCodeBlock
}

function inferFilesFromHeadingCodePairs(pairs: HeadingCodePair[]): InferredFile[] {
  const files: InferredFile[] = []
  for (const { heading, code } of pairs) {
    const h = heading.toLowerCase()
    // Next.js page
    if (/\bpage\b/.test(h) && (code.language === "tsx" || code.language === "jsx")) {
      files.push({ path: "app/page.tsx", confidence: "medium", source: "heuristic", associatedCode: code.code.slice(0, 200) })
      continue
    }
    // Layout
    if (/\blayout\b/.test(h)) {
      files.push({ path: "app/layout.tsx", confidence: "medium", source: "heuristic", associatedCode: code.code.slice(0, 200) })
      continue
    }
    // Try to extract component name from code
    const nm = code.code.match(COMPONENT_NAME_RE)
    if (nm) {
      const name = nm[1]
      const ext = code.language === "tsx" || code.language === "jsx" ? ".tsx" : ".ts"
      // Infer folder from heading keywords
      const folder = /\bcomponent\b/.test(h) ? "components"
        : /\bhook\b/.test(h) ? "hooks"
        : /\butil\b|\bhelper\b/.test(h) ? "lib"
        : /\broute\b|\bapi\b/.test(h) ? "app/api"
        : "components"
      files.push({ path: `${folder}/${name}${ext}`, confidence: "medium", source: "heuristic", associatedCode: code.code.slice(0, 200) })
    }
  }
  return files
}

// ─── LAYER 3 — Lightweight NLP Intent Detection ───────────────────────────────

const INTENT_PATTERNS: Array<{ re: RegExp; intent: string }> = [
  { re: /(?:let(?:'s|us)|now|going to|will)\s+(?:create|build|implement|write|add)\s+(?:the\s+)?(?:auth|authentication)\s+(?:util|helper|service|middleware)/i, intent: "create" },
  { re: /(?:let(?:'s|us)|now|going to|will)\s+(?:create|build|implement|write)\s+(?:the\s+)?login\s+(?:component|page|form)/i, intent: "create" },
  { re: /(?:let(?:'s|us)|now|going to|will)\s+(?:create|build|implement|write)\s+(?:the\s+)?(?:navbar|navigation|header)/i, intent: "create" },
  { re: /(?:let(?:'s|us)|now|going to|will)\s+(?:create|build|implement|write)\s+(?:the\s+)?(?:dashboard|home)\s+(?:page|component)/i, intent: "create" },
  { re: /(?:let(?:'s|us)|now|going to|will)\s+(?:create|build|set\s+up)\s+(?:the\s+)?(?:database|db|prisma|schema)/i, intent: "create" },
  { re: /(?:let(?:'s|us)|now|going to|will)\s+(?:create|build|implement|write)\s+(?:the\s+)?(?:api\s+route|endpoint|handler)/i, intent: "create" },
  { re: /(?:update|modify|refactor|fix)\s+(?:the\s+)?(?:[\w/]+\.(?:ts|tsx|js|jsx|py))/i, intent: "update" },
]

const FRAMEWORK_FILE_MAP: Array<{ pattern: RegExp; file: string; confidence: "high" | "medium" }> = [
  // Next.js
  { pattern: /export\s+default\s+function\s+(?:Page|Home|RootPage)\b/, file: "app/page.tsx", confidence: "high" },
  { pattern: /export\s+default\s+function\s+Layout\b/, file: "app/layout.tsx", confidence: "high" },
  { pattern: /export\s+default\s+function\s+Loading\b/, file: "app/loading.tsx", confidence: "high" },
  { pattern: /export\s+default\s+function\s+Error\b/, file: "app/error.tsx", confidence: "high" },
  { pattern: /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|DELETE|PATCH)\b/, file: "app/api/route.ts", confidence: "high" },
  // React components (named)
  { pattern: /(?:export\s+(?:default\s+)?function|export\s+const)\s+([A-Z][A-Za-z]+)\b/, file: "components/[name].tsx", confidence: "medium" },
  // Express router
  { pattern: /router\.(?:get|post|put|delete|patch)\s*\(/, file: "routes/index.ts", confidence: "medium" },
  // Prisma
  { pattern: /model\s+[A-Z]\w+\s+\{/, file: "prisma/schema.prisma", confidence: "high" },
  // Config files
  { pattern: /(?:module\.exports|export\s+default)\s*=\s*\{[\s\S]*?(?:plugins|theme|content)\s*:/, file: "tailwind.config.ts", confidence: "medium" },
  // Hooks
  { pattern: /(?:export\s+(?:default\s+)?function|export\s+const)\s+(use[A-Z]\w+)\b/, file: "hooks/[name].ts", confidence: "medium" },
  // Auth
  { pattern: /NextAuth\s*\(|authOptions|getServerSession/, file: "app/api/auth/[...nextauth]/route.ts", confidence: "high" },
]

function inferFileFromCode(block: RecoveredCodeBlock): InferredFile | null {
  const { code, language } = block
  for (const rule of FRAMEWORK_FILE_MAP) {
    const m = rule.pattern.exec(code)
    if (!m) continue
    let path = rule.file
    // Substitute [name] placeholder with extracted name
    if (path.includes("[name]") && m[1]) {
      path = path.replace("[name]", m[1])
    }
    return { path, confidence: rule.confidence, source: "heuristic", associatedCode: code.slice(0, 200) }
  }
  return null
}

function inferFilesFromNLP(text: string): InferredFile[] {
  const files: InferredFile[] = []
  for (const { re } of INTENT_PATTERNS) {
    re.lastIndex = 0
    if (!re.test(text)) continue
    // Map intent text to probable file
    const lower = text.toLowerCase()
    if (/auth(?:entication)?\s+(?:util|helper|service|middleware)/.test(lower)) {
      files.push({ path: "lib/auth.ts", confidence: "low", source: "nlp" })
    } else if (/login\s+(?:component|page|form)/.test(lower)) {
      files.push({ path: "components/Login.tsx", confidence: "low", source: "nlp" })
    } else if (/(?:navbar|navigation|header)/.test(lower)) {
      files.push({ path: "components/Navbar.tsx", confidence: "low", source: "nlp" })
    } else if (/dashboard\s+(?:page|component)/.test(lower)) {
      files.push({ path: "app/dashboard/page.tsx", confidence: "low", source: "nlp" })
    } else if (/(?:database|prisma|schema)/.test(lower)) {
      files.push({ path: "prisma/schema.prisma", confidence: "low", source: "nlp" })
    } else if (/api\s+route|endpoint|handler/.test(lower)) {
      files.push({ path: "app/api/route.ts", confidence: "low", source: "nlp" })
    }
  }
  return files
}

// ─── INCOMPLETE IMPLEMENTATION DETECTION ──────────────────────────────────────

const INCOMPLETE_SIGNALS: Array<{ re: RegExp; signal: string }> = [
  { re: /\bTODO\b[:\s].{5,150}/gi, signal: "TODO marker" },
  { re: /\bFIXME\b[:\s].{5,150}/gi, signal: "FIXME marker" },
  { re: /\bstill\s+need(?:s)?\s+to\s+implement\b.{0,120}/gi, signal: "implementation debt" },
  { re: /\bremaining\s+implementation\b.{0,120}/gi, signal: "unimplemented logic" },
  { re: /\bnext\s+(?:we\s+need\s+to|step\s+is)\b.{0,120}/gi, signal: "next step detected" },
  { re: /\bpartial\s+implementation\b.{0,120}/gi, signal: "partially complete" },
  { re: /\bunfinished\b.{0,100}/gi, signal: "unfinished work" },
  { re: /\bnot\s+(?:yet\s+)?implemented\b.{0,100}/gi, signal: "placeholder / stub" },
  { re: /\b(?:continue|continuing)\s+(?:from|with)\b.{0,120}/gi, signal: "continuation anchor" },
  { re: /\/\/\s*TODO.{0,150}/gi, signal: "source comment (todo)" },
  { re: /\/\/\s*FIXME.{0,150}/gi, signal: "source comment (fixme)" },
  { re: /throw\s+new\s+Error\s*\(\s*['"`](?:not\s+implemented|todo)/gi, signal: "runtime exception stub" },
  { re: /\bneeds\s+(?:to\s+be\s+)?refactored\b.{0,120}/gi, signal: "refactor pending" },
]

// PRIORITY 3: Extract structured pending module lists
// Detects patterns like:
//   "Pending:\n- calculations\n- simulations\n- reports"
//   "Still need to implement: X, Y, Z"

const PENDING_LIST_HEADER = /(?:pending|still\s+need|remaining|not\s+yet\s+done|todo\s+list|incomplete|left\s+to\s+implement|haven't\s+(?:done|built|implemented))[:\s]{0,10}/gi

function extractPendingLists(text: string): IncompleteItem[] {
  const items: IncompleteItem[] = []
  const seen = new Set<string>()

  // Find headers and grab the bulleted/numbered list that follows
  const re = new RegExp(PENDING_LIST_HEADER.source, "gi")
  let hm: RegExpExecArray | null
  while ((hm = re.exec(text)) !== null) {
    const after = text.slice(hm.index + hm[0].length, hm.index + hm[0].length + 800)
    // Extract list items (-, *, numbered)
    const listItems = after.match(/^[\s]*(?:[-*•]|\d+\.)[\s]+.{3,120}$/gm) || []
    for (const li of listItems.slice(0, 8)) {
      const desc = li.trim().replace(/^[-*•\d.]+\s+/, "").trim()
      if (desc.length > 3 && !seen.has(desc)) {
        seen.add(desc)
        items.push({ description: desc, signal: "pending list" })
      }
    }
    // Also grab inline comma-separated items after the header
    if (listItems.length === 0) {
      const inline = after.match(/^(.{5,200})$/m)
      if (inline) {
        const parts = inline[1].split(/,|;/).map(s => s.trim()).filter(s => s.length > 3)
        for (const p of parts.slice(0, 6)) {
          if (!seen.has(p)) {
            seen.add(p)
            items.push({ description: p, signal: "inline pending" })
          }
        }
      }
    }
  }
  return items
}

function detectIncompleteItems(messages: RawMessage[]): IncompleteItem[] {
  const items: IncompleteItem[] = []
  const seen = new Set<string>()

  // Bias heavily toward recent messages (last 60%)
  const cutoff = Math.floor(messages.length * 0.4)
  const recent = messages.slice(cutoff)

  // Pass 1: structured pending lists (highest value)
  for (const msg of recent) {
    const text = msg.content.slice(0, 4000)
    for (const item of extractPendingLists(text)) {
      if (!seen.has(item.description)) {
        seen.add(item.description)
        items.push(item)
      }
    }
  }

  // Pass 2: signal-based detection
  for (const msg of recent) {
    const text = msg.content.slice(0, 3000)
    for (const { re, signal } of INCOMPLETE_SIGNALS) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const desc = m[0].trim().replace(/\s+/g, " ").slice(0, 180)
        if (!seen.has(desc) && desc.length > 10) {
          seen.add(desc)
          items.push({ description: desc, signal })
        }
        if (items.length >= 15) break
      }
      if (items.length >= 15) break
    }
    if (items.length >= 15) break
  }
  return items
}

// ─── ARCHITECTURE DECISION EXTRACTION ────────────────────────────────────────

const ARCH_PATTERNS: Array<{ re: RegExp; category: ArchitectureDecision["category"] }> = [
  { re: /(?:using|using\s+the|built\s+with|we(?:'re|re)\s+using)\s+(?:Next\.?js|Nuxt|Remix|Astro|Vite|Create\s+React\s+App|SvelteKit|Qwik|SolidStart)\b.{0,150}/gi, category: "framework" },
  { re: /(?:using|using\s+the|built\s+with)\s+(?:React|Vue|Angular|Svelte|Solid(?:JS)?|Preact|Alpine(?:JS)?)\b.{0,100}/gi, category: "framework" },
  { re: /(?:using|with)\s+(?:Prisma|Drizzle|TypeORM|Mongoose|Sequelize|Kysely|MikroORM)\b.{0,100}/gi, category: "database" },
  { re: /(?:using|with)\s+(?:Supabase|PlanetScale|Neon|Firebase|MongoDB|PostgreSQL|MySQL|SQLite|Redis|Upstash|Turso)\b.{0,100}/gi, category: "database" },
  { re: /(?:using|with)\s+(?:NextAuth|Auth\.?js|Clerk|Lucia|Passport\.?js|Auth0|Kinde)\b.{0,100}/gi, category: "auth" },
  { re: /(?:using|with)\s+(?:JWT|session\s+cookies|OAuth|Magic\s+links)\b.{0,100}/gi, category: "auth" },
  { re: /(?:using|with)\s+(?:Zustand|Redux|Jotai|Recoil|Context\s+API|Valtio|Nanostores|XState|Signals)\b.{0,100}/gi, category: "state" },
  { re: /(?:deploying|hosted\s+on|deployed\s+to)\s+(?:Vercel|Netlify|Railway|Fly\.io|AWS|GCP|Azure|Cloudflare\s+Pages|DigitalOcean)\b.{0,100}/gi, category: "deployment" },
  { re: /(?:using|with)\s+(?:Tailwind(?:CSS)?|Bootstrap|Shadcn|UnoCSS|PandaCSS|Styled\s+Components|Emotion)\b.{0,100}/gi, category: "other" },
  { re: /(?:switched\s+(?:from|to)|decided\s+(?:to\s+use|against)|going\s+with|opting\s+for)\s+.{10,150}/gi, category: "other" },
]

function extractArchitectureDecisions(messages: RawMessage[]): ArchitectureDecision[] {
  const decisions: ArchitectureDecision[] = []
  const seen = new Set<string>()
  const allText = messages.map(m => m.content.slice(0, 600)).join("\n")

  for (const { re, category } of ARCH_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(allText)) !== null) {
      const text = m[0].trim().replace(/\s+/g, " ").slice(0, 200)
      if (!seen.has(text) && text.length > 8) {
        seen.add(text)
        decisions.push({ text, category })
      }
      if (decisions.length >= 15) break
    }
    if (decisions.length >= 15) break
  }
  return decisions
}

// ─── WORKFLOW STATE RECONSTRUCTION ────────────────────────────────────────────

const BLOCKER_RE = /(?:blocked\s+(?:by|on)|can(?:'t|not)\s+(?:proceed|continue|get\s+this\s+to\s+work)|stuck\s+(?:on|with|at)|this\s+is\s+preventing|not\s+sure\s+why|keeps?\s+(?:failing|breaking|throwing)).{0,250}/gi
const DEBUG_ATTEMPT_RE = /(?:i\s+tried|tried\s+(?:adding|changing|using|removing|setting)|i\s+checked|looked\s+at|inspected|console\.log(?:ged)?).{0,200}/gi
const INTERRUPTION_RE = /(?:generation|response)\s+(?:interrupted|cut\s+off|stopped|halted)|(?:interrupted\s+during).{0,150}/gi

// ─── SEMANTIC DEDUPLICATION ENGINE ───────────────────────────────────────────

function computeSimilarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 2))
  const wb = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 2))
  if (wa.size === 0 && wb.size === 0) return 1
  let intersection = 0
  for (const w of wa) if (wb.has(w)) intersection++
  return intersection / (wa.size + wb.size - intersection)
}

function deduplicateSemantically(strings: string[], threshold = 0.45): string[] {
  const result: string[] = []
  for (const s of strings) {
    const clean = s.trim()
    if (!clean) continue
    if (!result.some(r => computeSimilarity(r, clean) > threshold)) {
      result.push(clean)
    }
  }
  return result
}


function reconstructWorkflowState(messages: RawMessage[], fileMap: Map<string, InferredFile>): WorkflowState {
  const recent = messages.slice(-8)
  const allRecent = recent.map(m => m.content.slice(0, 800)).join("\n")

  // ── Completed work — delegated to workflow-engine (planning-chatter-free)
  const completedWork = extractAccomplishments(messages)

  // ── Blocker detection — delegated to workflow-engine (expanded patterns)
  const currentBlocker = detectCurrentBlocker(messages)

  // ── Likely affected area — from file map
  let likelyAffectedArea: string | undefined
  if (fileMap.size > 0) {
    const files = [...fileMap.values()]
    likelyAffectedArea = files.find(f => f.confidence === "high")?.path || files[0].path
  }

  // ── Next step inference
  let nextImmediateStep: string | undefined
  if (currentBlocker && /interrupted|cut.?off|max.?length|context.?limit/i.test(currentBlocker)) {
    nextImmediateStep = "Resume the interrupted generation and deliver the complete output."
  } else if (currentBlocker && /error|failed|crash|exception/i.test(currentBlocker)) {
    nextImmediateStep = "Resolve the error and verify the fix before continuing."
  } else if (currentBlocker) {
    nextImmediateStep = "Resolve the current blocker and continue implementation."
  } else {
    nextImmediateStep = "Continue implementing the pending tasks."
  }

  // ── Unresolved issues from recent text
  const unresolvedIssues: string[] = []
  const ERROR_BRIEF_RE = /(?:TypeError|SyntaxError|Error|failed|cannot\s+resolve|ENOENT|WARN)\b.{0,120}/gi
  let em: RegExpExecArray | null
  const seenIssues = new Set<string>()
  while ((em = ERROR_BRIEF_RE.exec(allRecent)) !== null) {
    const t = em[0].trim().slice(0, 150)
    if (!seenIssues.has(t)) { seenIssues.add(t); unresolvedIssues.push(t) }
    if (unresolvedIssues.length >= 4) break
  }

  return {
    completedWork,
    currentBlocker,
    unresolvedIssues: deduplicateSemantically(unresolvedIssues),
    likelyAffectedArea,
    nextImmediateStep
  }
}

// ─── PROJECT GOAL EXTRACTION ──────────────────────────────────────────────────
// Delegated to workflow-engine.ts (extractObjectiveFromUser — user-only, length-sorted).
// This local wrapper keeps the existing call-site in runRecoveryEngine unchanged.

function extractProjectGoal(messages: RawMessage[]): string {
  return extractObjectiveFromUser(messages)
}

// ─── RECENT TRANSCRIPT ────────────────────────────────────────────────────────

function buildRecentTranscript(messages: RawMessage[], maxMessages = 5, maxChars = 350): string {
  // PRIORITY 5: Aggressively compress transcript. It's just supporting context now.
  const tail = messages.slice(-maxMessages)
  return tail.map(m => {
    const role = m.role === "user" ? "User" : "Assistant"
    
    // Strip code blocks entirely from transcript to save space (they are captured elsewhere)
    let text = m.content.replace(/```[\s\S]*?```/g, "[Code Block Extracted]").trim()
    
    // Aggressive truncate
    if (text.length > maxChars) text = text.slice(0, maxChars) + "..."
    
    return `**${role}:** ${text}`
  }).join("\n\n")
}

// ─── MAIN ENTRY POINT ─────────────────────────────────────────────────────────

export function runRecoveryEngine(messages: RawMessage[]): RecoveryEngineResult {
  const t0 = performance.now()

  if (messages.length === 0) {
    return {
      codeBlocks: [],
      inferredFiles: [],
      architectureDecisions: [],
      incompleteItems: [],
      workflowState: { completedWork: [], unresolvedIssues: [] },
      projectGoal: "No messages extracted.",
      recentTranscript: "",
      processingMs: 0,
    }
  }

  // Stage 1: Filter noise FIRST using the new workflow-engine noise gate
  const clean = filterNoiseMessages(messages)

  // ── 1. Code Block Recovery ─────────────────────────────────────────────────
  const codeBlocks: RecoveredCodeBlock[] = []
  for (const msg of messages) {
    // Find nearest heading for each block using offset
    const re = new RegExp(FENCED_BLOCK_RE.source, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(msg.content)) !== null) {
      const heading = extractNearestHeading(msg.content, m.index)
      const blocks = parseCodeBlocks(m[0], heading)
      codeBlocks.push(...blocks)
    }
  }

  // ── 2. Hybrid File Inference (uses cleaned messages) ──────────────────────
  const fileMap = new Map<string, InferredFile>()

  // Layer 1 — Deterministic (run on cleaned text to avoid tech-name false positives)
  const allText = clean.map(m => m.content.slice(0, 1000)).join("\n")
  for (const path of extractExplicitFiles(allText)) {
    fileMap.set(path, { path, confidence: "high", source: "explicit" })
  }

  // Layer 2 — Structural heuristics: heading+code pairs
  const headingCodePairs: HeadingCodePair[] = []
  for (const block of codeBlocks) {
    if (block.heading) headingCodePairs.push({ heading: block.heading, code: block })
  }
  for (const f of inferFilesFromHeadingCodePairs(headingCodePairs)) {
    if (!fileMap.has(f.path)) fileMap.set(f.path, f)
  }

  // Layer 2b — Framework convention from code content
  for (const block of codeBlocks) {
    const inferred = inferFileFromCode(block)
    if (inferred && !fileMap.has(inferred.path)) {
      fileMap.set(inferred.path, inferred)
    }
    if (inferred && !block.inferredFile) block.inferredFile = inferred.path
  }

  // Layer 3 — NLP intent (only recent cleaned messages)
  for (const msg of clean.slice(-10)) {
    for (const f of inferFilesFromNLP(msg.content)) {
      if (!fileMap.has(f.path)) fileMap.set(f.path, f)
    }
  }

  // ── 3. Incomplete Detection (on cleaned messages) ──────────────────────────
  // Filter out any incomplete items that semantically overlap with accomplishments
  const rawIncomplete = detectIncompleteItems(clean)
  const incompleteItems = rawIncomplete.filter(item => {
    // Interruption should be a blocker, not an incomplete item
    if (INTERRUPTION_RE.test(item.description)) return false
    return true
  })

  // ── 4. Architecture Decisions (on cleaned messages) ───────────────────────
  const architectureDecisions = extractArchitectureDecisions(clean)

  // ── 5. Workflow State (on cleaned messages) ────────────────────────────────
  const workflowState = reconstructWorkflowState(clean, fileMap)

  // Semantic cross-section deduplication
  const allCompleted = workflowState.completedWork.join(" ")
  const finalIncomplete = incompleteItems.filter(item => computeSimilarity(item.description, allCompleted) < 0.3)

  // ── 6. Goal + Transcript (goal from raw, transcript from clean) ───────────
  const projectGoal = extractProjectGoal(messages)
  const recentTranscript = buildRecentTranscript(clean)

  return {
    codeBlocks: codeBlocks.slice(0, 30),
    inferredFiles: [...fileMap.values()].slice(0, 25),
    architectureDecisions,
    incompleteItems: finalIncomplete,
    workflowState,
    projectGoal,
    recentTranscript,
    processingMs: Math.round(performance.now() - t0),
  }
}

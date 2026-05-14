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
  recentActivity: string[]   // last N things done
  activeBlocker?: string
  lastDebugAttempt?: string
  unresolvedIssues: string[]
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

const EXPLICIT_FILE_RE = /\b([\w.\-/]+\.(?:tsx?|jsx?|py|rs|go|java|kt|swift|rb|php|css|scss|html|json|yaml|yml|toml|env|md|sql|sh|bash|prisma|graphql|vue|svelte))\b/g

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
  { re: /\bstill\s+need(?:s)?\s+to\s+implement\b.{0,120}/gi, signal: "still needs implementation" },
  { re: /\bremaining\s+implementation\b.{0,120}/gi, signal: "remaining implementation" },
  { re: /\bnext\s+we\s+need\s+to\b.{0,120}/gi, signal: "next step needed" },
  { re: /\bpartial\s+implementation\b.{0,120}/gi, signal: "partial implementation" },
  { re: /\bunfinished\b.{0,100}/gi, signal: "unfinished" },
  { re: /\bnot\s+(?:yet\s+)?implemented\b.{0,100}/gi, signal: "not implemented" },
  { re: /\b(?:continue|continuing)\s+(?:from|with)\b.{0,120}/gi, signal: "continuation point" },
  { re: /\/\/\s*TODO.{0,150}/gi, signal: "inline TODO comment" },
  { re: /\/\/\s*FIXME.{0,150}/gi, signal: "inline FIXME comment" },
  { re: /throw\s+new\s+Error\s*\(\s*['"`](?:not\s+implemented|todo)/gi, signal: "not-implemented stub" },
]

function detectIncompleteItems(messages: RawMessage[]): IncompleteItem[] {
  const items: IncompleteItem[] = []
  const seen = new Set<string>()

  // Focus on last 60% of conversation for recency
  const recent = messages.slice(-Math.max(messages.length, 1))
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
        if (items.length >= 12) break
      }
      if (items.length >= 12) break
    }
    if (items.length >= 12) break
  }
  return items
}

// ─── ARCHITECTURE DECISION EXTRACTION ────────────────────────────────────────

const ARCH_PATTERNS: Array<{ re: RegExp; category: ArchitectureDecision["category"] }> = [
  { re: /(?:using|using\s+the|built\s+with|we(?:'re|re)\s+using)\s+(?:Next\.?js|Nuxt|Remix|Astro|Vite|Create\s+React\s+App|SvelteKit)\b.{0,150}/gi, category: "framework" },
  { re: /(?:using|using\s+the|built\s+with)\s+(?:React|Vue|Angular|Svelte|Solid(?:JS)?)\b.{0,100}/gi, category: "framework" },
  { re: /(?:using|with)\s+(?:Prisma|Drizzle|TypeORM|Mongoose|Sequelize)\b.{0,100}/gi, category: "database" },
  { re: /(?:using|with)\s+(?:Supabase|PlanetScale|Neon|Firebase|MongoDB|PostgreSQL|MySQL|SQLite)\b.{0,100}/gi, category: "database" },
  { re: /(?:using|with)\s+(?:NextAuth|Auth\.?js|Clerk|Lucia|Passport\.?js)\b.{0,100}/gi, category: "auth" },
  { re: /(?:using|with)\s+(?:JWT|session\s+cookies|OAuth)\b.{0,100}/gi, category: "auth" },
  { re: /(?:using|with)\s+(?:Zustand|Redux|Jotai|Recoil|Context\s+API|Valtio|Nanostores)\b.{0,100}/gi, category: "state" },
  { re: /(?:deploying|hosted\s+on|deployed\s+to)\s+(?:Vercel|Netlify|Railway|Fly\.io|AWS|GCP|Azure)\b.{0,100}/gi, category: "deployment" },
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

function reconstructWorkflowState(messages: RawMessage[]): WorkflowState {
  const recent = messages.slice(-8)
  const allRecent = recent.map(m => m.content.slice(0, 800)).join("\n")

  // Recent activity = last 5 meaningful assistant snippets
  const recentActivity: string[] = []
  for (const msg of [...messages].reverse().slice(0, 6)) {
    if (msg.role !== "assistant") continue
    const lines = msg.content.split("\n").filter(l => l.trim().length > 30)
    if (lines[0]) recentActivity.push(lines[0].trim().slice(0, 200))
    if (recentActivity.length >= 4) break
  }

  // Active blocker
  let activeBlocker: string | undefined
  const bm = BLOCKER_RE.exec(allRecent)
  if (bm) activeBlocker = bm[0].trim().slice(0, 250)
  BLOCKER_RE.lastIndex = 0

  // Last debug attempt
  let lastDebugAttempt: string | undefined
  const dm = DEBUG_ATTEMPT_RE.exec(allRecent)
  if (dm) lastDebugAttempt = dm[0].trim().slice(0, 250)
  DEBUG_ATTEMPT_RE.lastIndex = 0

  // Unresolved issues — look for error patterns in recent messages
  const unresolvedIssues: string[] = []
  const ERROR_BRIEF_RE = /(?:TypeError|SyntaxError|Error|failed|cannot\s+resolve|ENOENT)\b.{0,120}/gi
  let em: RegExpExecArray | null
  const seen = new Set<string>()
  while ((em = ERROR_BRIEF_RE.exec(allRecent)) !== null) {
    const t = em[0].trim().slice(0, 150)
    if (!seen.has(t)) { seen.add(t); unresolvedIssues.push(t) }
    if (unresolvedIssues.length >= 4) break
  }

  return { recentActivity, activeBlocker, lastDebugAttempt, unresolvedIssues }
}

// ─── PROJECT GOAL EXTRACTION ──────────────────────────────────────────────────

function extractProjectGoal(messages: RawMessage[]): string {
  const GOAL_RE = /(?:i(?:'m|\s+am)\s+(?:building|creating|making|working\s+on)|we(?:'re|\s+are)\s+(?:building|creating)|the\s+goal\s+is\s+(?:to\s+)?|let(?:'s|us)\s+build)\s+(.{20,400})/i
  for (const msg of messages.slice(0, 8)) {
    if (msg.role !== "user") continue
    const m = GOAL_RE.exec(msg.content)
    if (m) return m[1].trim().replace(/\n+/g, " ").slice(0, 400)
  }
  // Fallback: first user message
  const first = messages.find(m => m.role === "user")
  if (first) return first.content.replace(/\n+/g, " ").trim().slice(0, 400)
  return "Project goal not explicitly stated — infer from conversation context."
}

// ─── RECENT TRANSCRIPT ────────────────────────────────────────────────────────

function buildRecentTranscript(messages: RawMessage[], maxMessages = 8, maxChars = 700): string {
  const tail = messages.slice(-maxMessages)
  return tail.map(m => {
    const role = m.role === "user" ? "User" : "Assistant"
    const text = m.content.trim()
    const trimmed = text.length > maxChars ? text.slice(0, maxChars) + "…" : text
    return `**${role}:** ${trimmed}`
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
      workflowState: { recentActivity: [], unresolvedIssues: [] },
      projectGoal: "No messages extracted.",
      recentTranscript: "",
      processingMs: 0,
    }
  }

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

  // ── 2. Hybrid File Inference ───────────────────────────────────────────────
  const fileMap = new Map<string, InferredFile>()

  // Layer 1 — Deterministic
  const allText = messages.map(m => m.content.slice(0, 1000)).join("\n")
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
    // Attach inferred file back to block
    if (inferred && !block.inferredFile) block.inferredFile = inferred.path
  }

  // Layer 3 — NLP intent
  for (const msg of messages.slice(-10)) {
    for (const f of inferFilesFromNLP(msg.content)) {
      if (!fileMap.has(f.path)) fileMap.set(f.path, f)
    }
  }

  // ── 3. Incomplete Detection ────────────────────────────────────────────────
  const incompleteItems = detectIncompleteItems(messages)

  // ── 4. Architecture Decisions ─────────────────────────────────────────────
  const architectureDecisions = extractArchitectureDecisions(messages)

  // ── 5. Workflow State ──────────────────────────────────────────────────────
  const workflowState = reconstructWorkflowState(messages)

  // ── 6. Goal + Transcript ───────────────────────────────────────────────────
  const projectGoal = extractProjectGoal(messages)
  const recentTranscript = buildRecentTranscript(messages)

  return {
    codeBlocks: codeBlocks.slice(0, 30),
    inferredFiles: [...fileMap.values()].slice(0, 25),
    architectureDecisions,
    incompleteItems,
    workflowState,
    projectGoal,
    recentTranscript,
    processingMs: Math.round(performance.now() - t0),
  }
}

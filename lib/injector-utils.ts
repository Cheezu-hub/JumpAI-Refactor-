/**
 * JumpAI — Destination Platform Injection Utilities
 *
 * Shared helpers used by ChatGPT and Gemini content scripts to:
 *  - Read and consume pending packets from session storage (with retry)
 *  - Wait for the target AI editor element to become available (with exponential backoff)
 *  - Inject text reliably into contenteditable (ProseMirror / Quill)
 *    and legacy textarea editors
 *  - Show a non-intrusive confirmation toast on the destination page
 *
 * KEY RELIABILITY CHANGES:
 *  - consumePendingPacket: retries for up to 8s so the content script can receive
 *    the NLP packet even if it arrives after the page loads (race-free).
 *  - waitForAnyElement: exponential backoff instead of fixed polling.
 *  - withTimeout: every async operation is guarded against hanging forever.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Packets older than 5 min are considered stale and are discarded. */
const STORAGE_TTL_MS = 5 * 60 * 1000

/** How long to retry polling storage before giving up. */
const PACKET_POLL_TIMEOUT_MS = 8000

/** How often to poll storage while waiting for the packet. */
const PACKET_POLL_INTERVAL_MS = 150

// ─── Timeout Guard ────────────────────────────────────────────────────────────

/**
 * Races a promise against a timeout. If the promise doesn't settle within
 * `ms` milliseconds, resolves with `fallback` instead of hanging forever.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label?: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve =>
      setTimeout(() => {
        if (label) console.warn(`[JumpAI] withTimeout: "${label}" timed out after ${ms}ms`)
        resolve(fallback)
      }, ms)
    )
  ])
}

// ─── Storage Handoff ──────────────────────────────────────────────────────────

export interface PendingPacket {
  text: string
  timestamp: number
  platform: string
}

/**
 * Reads and immediately removes a pending packet for the given platform
 * from chrome.storage.session.
 *
 * RETRY LOGIC: In the background-first architecture, the tab opens before
 * the NLP packet has been written to storage. This function polls for up to
 * `PACKET_POLL_TIMEOUT_MS` milliseconds so the content script can receive
 * the packet even if it arrives a moment after the page loads.
 *
 * Returns null if nothing arrives within the timeout or the packet has expired.
 */
export async function consumePendingPacket(platform: string): Promise<string | null> {
  const key = `jumpai_pending_${platform}`
  const startMs = Date.now()
  let attempts = 0

  console.time(`[JumpAI] storage:read(${platform})`)
  console.log(`[JumpAI] Waiting for packet — platform: ${platform} (up to ${PACKET_POLL_TIMEOUT_MS}ms)`)

  // Safety check: session storage might not be available
  if (!chrome.storage?.session) {
    console.warn("[JumpAI] chrome.storage.session is unavailable in this context.")
    return null
  }

  while (Date.now() - startMs < PACKET_POLL_TIMEOUT_MS) {
    attempts++
    try {
      const result = await chrome.storage.session.get(key)
      const packet = result[key] as PendingPacket | undefined

      if (packet) {
        if (Date.now() - packet.timestamp > STORAGE_TTL_MS) {
          await chrome.storage.session.remove(key)
          console.warn("[JumpAI] Packet expired, discarding.")
          console.timeEnd(`[JumpAI] storage:read(${platform})`)
          return null
        }

        // Remove immediately so a page refresh doesn't re-inject
        await chrome.storage.session.remove(key)
        const elapsedMs = Date.now() - startMs
        console.log(`[JumpAI] Packet consumed after ${attempts} attempt(s) in ${elapsedMs}ms — ${packet.text.length} chars`)
        console.timeEnd(`[JumpAI] storage:read(${platform})`)
        return packet.text
      }
    } catch (err) {
      // Only log if it's not a standard "extension context invalidated" error
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes("context invalidated")) {
        console.error("[JumpAI] storage.session read failed:", err)
      }
      console.timeEnd(`[JumpAI] storage:read(${platform})`)
      return null
    }

    // Packet not yet available — wait and retry
    await sleep(PACKET_POLL_INTERVAL_MS)
  }

  const elapsed = Date.now() - startMs
  console.warn(`[JumpAI] No packet found after ${elapsed}ms and ${attempts} attempts — packet may never have been written`)
  console.timeEnd(`[JumpAI] storage:read(${platform})`)
  return null
}

// ─── DOM Polling ──────────────────────────────────────────────────────────────

/**
 * Polls until one of the given CSS selectors matches an element in the DOM.
 * Uses exponential backoff: starts at 100ms, doubles each miss up to 1000ms.
 * Hard cap of ~20 seconds total (configurable via `maxWaitMs`).
 *
 * Returns the first match found along with the selector that matched,
 * or null after the timeout.
 */
export async function waitForAnyElement(
  selectors: string[],
  _maxAttempts = 40,         // kept for API compatibility but maxWaitMs is the real limit
  _intervalMs = 500,         // kept for API compatibility
  maxWaitMs = 20_000
): Promise<{ element: Element; selector: string } | null> {
  const startMs = Date.now()
  let delay = 100             // initial poll interval
  const MAX_DELAY = 1000      // cap at 1s
  let attempt = 0

  console.log(`[JumpAI] Polling for editor (${selectors.length} selectors, up to ${maxWaitMs}ms)`)

  while (Date.now() - startMs < maxWaitMs) {
    attempt++
    for (const selector of selectors) {
      const el = document.querySelector(selector)
      if (el) {
        const elapsed = Date.now() - startMs
        console.log(`[JumpAI] Editor found: "${selector}" after ${attempt} attempt(s), ${elapsed}ms`)
        return { element: el, selector }
      }
    }

    await sleep(delay)
    delay = Math.min(Math.round(delay * 1.5), MAX_DELAY) // exponential backoff
  }

  console.warn(`[JumpAI] Editor not found after ${Date.now() - startMs}ms — tried: ${selectors.join(", ")}`)
  return null
}

// ─── Text Injection ───────────────────────────────────────────────────────────

/**
 * Injects text into a DOM element, handling both plain `<textarea>` inputs and
 * `contenteditable` rich editors (ProseMirror used by ChatGPT, Quill used by
 * Gemini). Three methods are tried in order so that at least one succeeds
 * regardless of how the framework intercepts DOM events.
 *
 * @returns true if the editor appears to contain the injected text afterwards.
 */
export function injectTextIntoEditor(element: HTMLElement, text: string): boolean {
  const tag = element.tagName.toLowerCase()
  const isTextarea = tag === "textarea"
  const isContentEditable =
    element.isContentEditable ||
    element.getAttribute("contenteditable") === "true"

  if (isTextarea) {
    return injectIntoTextarea(element as HTMLTextAreaElement, text)
  }

  if (isContentEditable) {
    return injectIntoContentEditable(element, text)
  }

  // Unknown element type — attempt contenteditable path anyway
  console.warn("[JumpAI] Element is neither textarea nor contenteditable; attempting generic injection.")
  return injectIntoContentEditable(element, text)
}

// ─── Textarea Injection ───────────────────────────────────────────────────────

function injectIntoTextarea(ta: HTMLTextAreaElement, text: string): boolean {
  try {
    // Use the native value setter so React's synthetic event system picks it up
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set

    if (nativeSetter) {
      nativeSetter.call(ta, text)
    } else {
      ta.value = text
    }

    ta.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }))
    ta.dispatchEvent(new Event("change", { bubbles: true }))
    ta.focus()
    console.log("[JumpAI] Injected via textarea native setter.")
    return true
  } catch (err) {
    console.error("[JumpAI] Textarea injection failed:", err)
    return false
  }
}

// ─── ContentEditable Injection ────────────────────────────────────────────────

function injectIntoContentEditable(el: HTMLElement, text: string): boolean {
  el.focus()

  // ── Method 1: execCommand ─────────────────────────────────────────────────
  try {
    document.execCommand("selectAll", false)
    const inserted = document.execCommand("insertText", false, text)

    if (inserted && el.textContent && el.textContent.trim().length > 0) {
      el.dispatchEvent(new InputEvent("input", { bubbles: true }))
      console.log("[JumpAI] Injected via execCommand(insertText).")
      return true
    }
  } catch (_) { /* fall through */ }

  // ── Method 2: Clipboard paste simulation ─────────────────────────────────
  try {
    el.focus()
    document.execCommand("selectAll", false)
    document.execCommand("delete", false)

    const dt = new DataTransfer()
    dt.setData("text/plain", text)

    const pasteEvent = new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true
    })

    el.dispatchEvent(pasteEvent)

    if (el.textContent && el.textContent.trim().length > 0) {
      console.log("[JumpAI] Injected via ClipboardEvent(paste).")
      return true
    }
  } catch (_) { /* fall through */ }

  // ── Method 3: Direct DOM mutation + synthetic input event ────────────────
  try {
    el.focus()
    el.innerHTML = ""
    el.textContent = text
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text
      })
    )
    el.dispatchEvent(new Event("change", { bubbles: true }))
    console.log("[JumpAI] Injected via textContent mutation.")
    return el.textContent.trim().length > 0
  } catch (err) {
    console.error("[JumpAI] All injection methods exhausted:", err)
    return false
  }
}

// ─── Toast Notification ───────────────────────────────────────────────────────

/**
 * Shows a brief branded toast in the top-right corner of the destination page
 * confirming that the JumpAI context packet was loaded.
 * Auto-dismisses after 4 seconds.
 */
export function showInjectionToast(platformLabel: string): void {
  // Prevent duplicate toasts
  if (document.getElementById("jumpai-toast")) return

  const style = document.createElement("style")
  style.textContent = `
    @keyframes jumpai-in  { from { opacity:0; transform:translateY(-8px) scale(0.97) } to { opacity:1; transform:none } }
    @keyframes jumpai-out { from { opacity:1; transform:none } to { opacity:0; transform:translateY(-8px) scale(0.97) } }
    #jumpai-toast { animation: jumpai-in 0.28s cubic-bezier(0.16,1,0.3,1) both; }
    #jumpai-toast.leaving { animation: jumpai-out 0.22s ease forwards; }
  `
  document.head.appendChild(style)

  const toast = document.createElement("div")
  toast.id = "jumpai-toast"
  Object.assign(toast.style, {
    position: "fixed",
    top: "18px",
    right: "18px",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 16px",
    background: "rgba(12,12,14,0.97)",
    border: "1px solid rgba(204,120,92,0.45)",
    borderRadius: "10px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.6), 0 0 16px rgba(204,120,92,0.08)",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: "13px",
    fontWeight: "500",
    color: "rgba(255,255,255,0.9)",
    userSelect: "none",
    pointerEvents: "none"
  })

  toast.innerHTML = `
    <div style="width:7px;height:7px;border-radius:50%;background:#4ade80;box-shadow:0 0 7px #4ade80;flex-shrink:0"></div>
    <div>
      Context loaded for <strong>${platformLabel}</strong>.
      <span style="color:rgba(255,255,255,0.4);font-size:11px;margin-left:6px">Review &amp; send when ready.</span>
    </div>
  `

  document.body.appendChild(toast)

  setTimeout(() => {
    toast.classList.add("leaving")
    setTimeout(() => toast.remove(), 300)
  }, 4000)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

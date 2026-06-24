/**
 * JumpAI — Gemini Destination Injector
 *
 * Responsibilities (destination platform only):
 *  - On every gemini.google.com page load, check chrome.storage.session for a
 *    pending JumpAI packet addressed to "gemini"
 *  - Wait for Gemini's Quill editor to become interactive
 *  - Inject the continuation packet into the input WITHOUT auto-sending
 *  - Show a confirmation toast and let the user review before sending
 *
 * RELIABILITY: consumePendingPacket now retries for up to 8 seconds, so this
 * script handles the race where the content script fires before the background
 * has written the NLP packet to storage. The tab opens immediately and the
 * content script waits patiently for the processed packet to arrive.
 *
 * Gemini Composer Architecture (as of 2024–2025):
 *  - Gemini's input is a Quill-based rich text editor hosted inside the
 *    <rich-textarea> custom web component.
 *  - Primary selector:  rich-textarea .ql-editor
 *  - The Quill editor is a <div contenteditable="true" class="ql-editor"> and
 *    responds well to execCommand('insertText') and ClipboardEvent('paste').
 *  - Gemini wraps this in Angular, so the injection pipeline must dispatch
 *    native DOM events that Angular's event listeners will pick up.
 *
 * This script performs NO extraction and generates NO packets. It is a pure
 * consumer of whatever claude.tsx produced and the background stored.
 */

import type { PlasmoCSConfig } from "plasmo"
import {
  consumePendingPacket,
  waitForAnyElement,
  injectTextIntoEditor,
  showInjectionToast,
  sleep
} from "~lib/injector-utils"

// ─── Plasmo Config ────────────────────────────────────────────────────────────

export const config: PlasmoCSConfig = {
  matches: ["https://gemini.google.com/*"],
  run_at: "document_idle",
  all_frames: false
}

// ─── Gemini Editor Selectors ──────────────────────────────────────────────────
// Ordered by specificity / recency. The first match wins.

const GEMINI_SELECTORS = [
  // Primary — Quill editor inside Gemini's custom rich-textarea component
  "rich-textarea .ql-editor",
  // Direct Quill editor fallback (if the custom element shadow is flattened)
  "div.ql-editor[contenteditable='true']",
  // Generic contenteditable inside rich-textarea
  "rich-textarea div[contenteditable='true']",
  // Broader contenteditable with placeholder (pre-Quill Gemini builds)
  "div[contenteditable='true'][data-placeholder]",
  // Angular Material textarea fallback
  "textarea.input-area",
]

// ─── Initialisation ───────────────────────────────────────────────────────────

async function init(): Promise<void> {
  console.log("[JumpAI:gemini] Content script loaded — checking for pending packet")
  console.time("[JumpAI:gemini] total")

  // Step 1 — Check session storage (with retry for up to 8s).
  // The background-first architecture opens the tab before the NLP packet is
  // ready. consumePendingPacket polls storage until the packet arrives.
  console.time("[JumpAI:gemini] storage:consume")
  const packetText = await consumePendingPacket("gemini")
  console.timeEnd("[JumpAI:gemini] storage:consume")

  if (!packetText) {
    console.log("[JumpAI:gemini] No packet found — content script exiting")
    console.timeEnd("[JumpAI:gemini] total")
    return
  }

  console.log(`[JumpAI:gemini] Packet received — ${packetText.length} chars. Waiting for composer…`)

  // Step 2 — Gemini is an Angular SPA with lazy-loaded components. The
  //          rich-textarea and its Quill child may not appear in the DOM for
  //          several seconds after initial navigation. Poll with exponential backoff.
  console.time("[JumpAI:gemini] editorWait")
  const found = await waitForAnyElement(GEMINI_SELECTORS, 40, 500, 20_000)
  console.timeEnd("[JumpAI:gemini] editorWait")

  if (!found) {
    console.warn("[JumpAI:gemini] Composer not found after 20s — packet dropped. Tried:", GEMINI_SELECTORS)
    console.timeEnd("[JumpAI:gemini] total")
    return
  }

  const { element, selector } = found
  console.log(`[JumpAI:gemini] Composer found — selector: "${selector}"`)

  // Step 3 — Gemini's Angular change detection + Quill initialisation needs
  //          slightly more warm-up time than ChatGPT's React app.
  await sleep(450)
  console.log("[JumpAI:gemini] Hydration delay complete — injecting")

  // Step 4 — Inject using the shared utility (execCommand → ClipboardEvent
  //          → textContent fallback chain).
  console.time("[JumpAI:gemini] injection")
  const success = injectTextIntoEditor(element as HTMLElement, packetText)
  console.timeEnd("[JumpAI:gemini] injection")

  if (success) {
    showInjectionToast("Gemini")
    console.log("[JumpAI:gemini] Packet injected successfully.")
  } else {
    console.error("[JumpAI:gemini] All injection methods failed.")
  }

  console.timeEnd("[JumpAI:gemini] total")
}

init()

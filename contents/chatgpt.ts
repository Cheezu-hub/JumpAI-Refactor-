/**
 * JumpAI — ChatGPT Destination Injector
 *
 * Responsibilities (destination platform only):
 *  - On every chatgpt.com page load, check chrome.storage.session for a
 *    pending JumpAI packet addressed to "chatgpt"
 *  - Wait for ChatGPT's composer element to become interactive
 *  - Inject the continuation packet into the input WITHOUT auto-sending
 *  - Show a confirmation toast and let the user review before sending
 *
 * RELIABILITY: consumePendingPacket now retries for up to 8 seconds, so this
 * script handles the race where the content script fires before the background
 * has written the NLP packet to storage. The tab opens immediately and the
 * content script waits patiently for the processed packet to arrive.
 *
 * ChatGPT Composer Architecture (as of 2024–2025):
 *  - Primary:  <div id="prompt-textarea" contenteditable="true" ...>
 *              This is a ProseMirror editor; execCommand('insertText') is the
 *              most reliable injection path.
 *  - Fallback: Older builds used a <textarea data-id="root"> element.
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
  matches: ["https://chatgpt.com/*"],
  run_at: "document_idle",
  all_frames: false
}

// ─── ChatGPT Editor Selectors ─────────────────────────────────────────────────
// Ordered by specificity / recency. The first match wins.

const CHATGPT_SELECTORS = [
  // Primary — ProseMirror-based composer (2024+ ChatGPT)
  "#prompt-textarea",
  // Lexical-based builds (some A/B experiments)
  "div[contenteditable='true'][data-lexical-editor='true']",
  // Generic ProseMirror fallback
  "div.ProseMirror[contenteditable='true']",
  // Legacy textarea (pre-2024)
  "textarea[data-id='root']",
  // Last-resort placeholder-based selector
  "textarea[placeholder*='Message']",
]

// ─── Initialisation ───────────────────────────────────────────────────────────

async function init(): Promise<void> {
  console.log("[JumpAI:chatgpt] Content script loaded — checking for pending packet")
  console.time("[JumpAI:chatgpt] total")

  // Step 1 — Check session storage (with retry for up to 8s).
  // The background-first architecture opens the tab before the NLP packet is
  // ready. consumePendingPacket polls storage until the packet arrives.
  console.time("[JumpAI:chatgpt] storage:consume")
  const packetText = await consumePendingPacket("chatgpt")
  console.timeEnd("[JumpAI:chatgpt] storage:consume")

  if (!packetText) {
    console.log("[JumpAI:chatgpt] No packet found — content script exiting")
    console.timeEnd("[JumpAI:chatgpt] total")
    return
  }

  console.log(`[JumpAI:chatgpt] Packet received — ${packetText.length} chars. Waiting for composer…`)

  // Step 2 — ChatGPT is a React SPA. The composer may not exist in the DOM
  //          immediately after document_idle fires. Poll with exponential backoff.
  console.time("[JumpAI:chatgpt] editorWait")
  const found = await waitForAnyElement(CHATGPT_SELECTORS, 40, 500, 20_000)
  console.timeEnd("[JumpAI:chatgpt] editorWait")

  if (!found) {
    console.warn("[JumpAI:chatgpt] Composer not found after 20s — packet dropped. Tried:", CHATGPT_SELECTORS)
    console.timeEnd("[JumpAI:chatgpt] total")
    return
  }

  const { element, selector } = found
  console.log(`[JumpAI:chatgpt] Composer found — selector: "${selector}"`)

  // Step 3 — Give React/ProseMirror a moment to finish hydrating the editor
  //          instance so that execCommand is properly wired up.
  await sleep(350)
  console.log("[JumpAI:chatgpt] Hydration delay complete — injecting")

  // Step 4 — Inject. injectTextIntoEditor handles contenteditable vs textarea
  //          and tries three methods (execCommand → ClipboardEvent → textContent).
  console.time("[JumpAI:chatgpt] injection")
  const success = injectTextIntoEditor(element as HTMLElement, packetText)
  console.timeEnd("[JumpAI:chatgpt] injection")

  if (success) {
    showInjectionToast("ChatGPT")
    console.log("[JumpAI:chatgpt] Packet injected successfully.")
  } else {
    console.error("[JumpAI:chatgpt] All injection methods failed.")
  }

  console.timeEnd("[JumpAI:chatgpt] total")
}

init()

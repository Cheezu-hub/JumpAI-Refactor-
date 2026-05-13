/**
 * JumpAI Background Service Worker
 *
 * Responsibilities:
 *  - Receive OPEN_TAB messages from the Claude source content script
 *  - Store the continuation packet in chrome.storage.session keyed by
 *    destination platform ("jumpai_pending_<platform>")
 *  - Open the target AI platform in a new tab
 *
 * Storage-first handoff (vs. message-passing):
 *  The previous approach sent a PASTE_PACKET message after detecting
 *  tab completion, but this was a race condition on SPAs: the `complete`
 *  status fires before React/Angular has rendered the editor. Using
 *  chrome.storage.session instead means the destination content script
 *  reads the packet on its own schedule, after the page has fully hydrated.
 *
 * The storage entry is consumed (deleted) by the destination content script
 * the first time it runs, so a page refresh will not re-inject the packet.
 * Entries expire after 5 minutes (TTL enforced in injector-utils.ts).
 */

import type { MessageType } from "../lib/types"

// ─── Installation Hook ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log("[JumpAI] Extension installed / updated.")
  ensureSessionAccess()
})

// Also run on browser startup in case the extension was already installed
chrome.runtime.onStartup.addListener(() => {
  ensureSessionAccess()
})

function ensureSessionAccess() {
  // CRITICAL: Allow content scripts to access session storage.
  // By default, storage.session is only accessible to extension contexts.
  if (chrome.storage?.session?.setAccessLevel) {
    chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS"
    }).catch(err => console.error("[JumpAI] Failed to set session access level:", err))
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: MessageType, _sender, sendResponse) => {
    if (message.type !== "OPEN_TAB") return

    const { url, platform, packetText } = message

    handleOpenTab(url, platform, packetText)
      .then((tabId) => sendResponse({ success: true, tabId }))
      .catch((err: Error) => {
        console.error("[JumpAI] handleOpenTab failed:", err)
        sendResponse({ success: false, error: err.message })
      })

    // Return true to keep the message channel open for the async response
    return true
  }
)

// ─── Core Handler ─────────────────────────────────────────────────────────────

async function handleOpenTab(
  url: string,
  platform: string | undefined,
  packetText: string | undefined
): Promise<number | undefined> {
  // Persist the packet BEFORE opening the tab so it is already in storage
  // when the destination content script begins polling.
  if (packetText && platform) {
    const storageKey = `jumpai_pending_${platform}`
    await chrome.storage.session.set({
      [storageKey]: {
        text: packetText,
        timestamp: Date.now(),
        platform
      }
    })
    console.log(`[JumpAI] Packet stored in session for platform: ${platform}`)
  }

  const tab = await chrome.tabs.create({ url, active: true })
  console.log(`[JumpAI] Opened tab ${tab.id} → ${url}`)
  return tab.id
}

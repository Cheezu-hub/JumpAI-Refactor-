/**
 * JumpAI Background Service Worker
 *
 * Responsibilities:
 *  - Receive OPEN_TAB messages from the Claude source content script
 *  - Store the continuation packet in chrome.storage.session keyed by
 *    destination platform ("jumpai_pending_<platform>")
 *  - Open the target AI platform in a new tab
 *  - Handle UPDATE_PACKET to overwrite storage with the processed NLP packet
 *    (used by the background-first architecture where the tab opens before NLP completes)
 *
 * Storage-first handoff (vs. message-passing):
 *  The destination content script reads the packet on its own schedule,
 *  after the page has fully hydrated. It retries for up to 8 seconds so
 *  it can receive the processed packet even if NLP takes a moment to finish.
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
  // This MUST be called every time the service worker wakes up (not just on install)
  // because Chrome can kill and restart the SW between events.
  if (chrome.storage?.session?.setAccessLevel) {
    chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS"
    }).catch(err => console.error("[JumpAI] Failed to set session access level:", err))
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: MessageType, _sender, sendResponse) => {
    // Re-assert session access every time the SW receives a message.
    // This handles the case where the SW was killed and restarted (access level resets).
    ensureSessionAccess()

    if (message.type === "OPEN_TAB") {
      const { url, platform, packetText } = message
      console.log(`[JumpAI] OPEN_TAB received — platform: ${platform}`)

      handleOpenTab(url, platform, packetText)
        .then((tabId) => sendResponse({ success: true, tabId }))
        .catch((err: Error) => {
          console.error("[JumpAI] handleOpenTab failed:", err)
          sendResponse({ success: false, error: err.message })
        })

      return true // keep channel open for async response
    }

    if (message.type === "UPDATE_PACKET") {
      const { platform, packetText } = message
      console.log(`[JumpAI] UPDATE_PACKET received — platform: ${platform}`)
      console.time(`[JumpAI:bg] updatePacket(${platform})`)

      handleUpdatePacket(platform, packetText)
        .then(() => {
          console.timeEnd(`[JumpAI:bg] updatePacket(${platform})`)
          console.log(`[JumpAI] Storage updated for platform: ${platform}`)
          sendResponse({ success: true })
        })
        .catch((err: Error) => {
          console.error("[JumpAI] handleUpdatePacket failed:", err)
          sendResponse({ success: false, error: err.message })
        })

      return true
    }
  }
)

// ─── Core Handlers ────────────────────────────────────────────────────────────

async function handleOpenTab(
  url: string,
  platform: string | undefined,
  packetText: string | undefined
): Promise<number | undefined> {
  // If a packet is provided (raw fallback or pre-built), store it before opening.
  // If omitted, the tab opens without storage — the content script will wait for
  // an UPDATE_PACKET to arrive via the retry loop in consumePendingPacket.
  if (packetText && platform) {
    const storageKey = `jumpai_pending_${platform}`
    console.time(`[JumpAI:bg] storageWrite(${platform})`)
    await chrome.storage.session.set({
      [storageKey]: {
        text: packetText,
        timestamp: Date.now(),
        platform
      }
    })
    console.timeEnd(`[JumpAI:bg] storageWrite(${platform})`)
    console.log(`[JumpAI] Packet stored in session for platform: ${platform}`)
  }

  console.time(`[JumpAI:bg] tabCreate`)
  const tab = await chrome.tabs.create({ url, active: true })
  console.timeEnd(`[JumpAI:bg] tabCreate`)
  console.log(`[JumpAI] Opened tab ${tab.id} → ${url}`)
  return tab.id
}

async function handleUpdatePacket(
  platform: string,
  packetText: string
): Promise<void> {
  const storageKey = `jumpai_pending_${platform}`
  await chrome.storage.session.set({
    [storageKey]: {
      text: packetText,
      timestamp: Date.now(),
      platform
    }
  })
  console.log(`[JumpAI] Packet updated in storage — platform: ${platform}, length: ${packetText.length} chars`)
}

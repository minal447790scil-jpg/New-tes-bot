// REDX TEST BOT — isolated diagnostic bot. Main bot is NOT touched by this.
// Purpose: (1) does the RedxBaileys fork pair successfully under its default
// androidPhone identity? (2) does a fresh incoming view-once arrive WITH a
// mediaKey (keyLen>0) and download? Every arrival is logged with keyLen so
// the Railway logs alone give the verdict.
import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
  Browsers,
  DEFAULT_CONNECTION_CONFIG
} from 'redxbailays-v1'
import pino from 'pino'
import fs from 'fs'

const PHONE = (process.env.PAIR_NUMBER || '').replace(/\D/g, '')
const AUTH_DIR = process.env.AUTH_DIR || './auth'
const logger = pino({ level: 'silent' })

console.log('[BOOT] redx-test-bot starting')
console.log('[BOOT] fork default browser =', JSON.stringify(DEFAULT_CONNECTION_CONFIG.browser), '| override in use =', JSON.stringify(Browsers.macOS('Safari')))
console.log('[BOOT] pair number =', PHONE || '(PAIR_NUMBER not set!)')

let sock = null
let destroyed = false
let pairingRequested = false
let closeCount = 0
let wipeOnBoot = false

// Delete the CONTENTS of the auth dir (the dir itself may be a volume
// mount point that cannot be removed).
function wipeAuthContents() {
  try {
    for (const entry of fs.readdirSync(AUTH_DIR)) {
      try { fs.rmSync(`${AUTH_DIR}/${entry}`, { recursive: true, force: true }) } catch {}
    }
    console.log('[AUTH] contents wiped')
  } catch (e) {
    console.log('[AUTH] wipe failed:', e?.message || e)
  }
}

// Recursively find image/video/audio media anywhere in a message tree,
// without descending into contextInfo (quoted messages are not arrivals).
function findMedia(obj, path = '', depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'contextInfo') continue
    if ((k === 'imageMessage' || k === 'videoMessage' || k === 'audioMessage') && v && typeof v === 'object') {
      return { type: k, media: v, path: path || '(top)' }
    }
    if (v && typeof v === 'object') {
      const r = findMedia(v, path ? `${path}.${k}` : k, depth + 1)
      if (r) return r
    }
  }
  return null
}

async function start() {
  if (destroyed) return
  if (wipeOnBoot) { wipeOnBoot = false; wipeAuthContents() }
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  sock = makeWASocket({
    auth: state,
    logger,
    // User's call (2026-11-22): fork's androidPhone identity seems to block
    // pairing on this account — use the macOS Safari identity instead,
    // the one that pairs fine on the main bot.
    browser: Browsers.macOS('Safari')
  })

  sock.ev.on('creds.update', saveCreds)

  if (!state.creds.registered && PHONE && !pairingRequested) {
    pairingRequested = true
    const mySock = sock
    setTimeout(async () => {
      if (sock !== mySock) { console.log('[PAIR] stale timer skipped'); return }
      try {
        const code = await mySock.requestPairingCode(PHONE)
        console.log(`[PAIR] PAIRING_CODE=${code} for ${PHONE}`)
      } catch (e) {
        console.log('[PAIR] requestPairingCode failed:', e?.message || e)
        pairingRequested = false
      }
    }, 3000)
  }

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect } = u
    if (connection) {
      const code = lastDisconnect?.error?.output?.statusCode
      console.log('[CONN]', connection, code ? `lastClose=${code}` : '')
    }
    if (connection === 'open') {
      closeCount = 0
      console.log('[CONN] OPEN me=', sock.user?.id || '?')
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut
      console.log('[CONN] CLOSE statusCode=', statusCode, loggedOut ? '(loggedOut)' : '')
      if (loggedOut) {
        if (!state.creds.registered) {
          // Half-paired junk creds rejected. Kill THIS socket first so its
          // saveCreds cannot rewrite the rejected creds after the wipe,
          // then wipe on next boot and start over with a fresh code.
          console.log('[CONN] logged out while UNPAIRED — ending socket, wipe on reboot')
          try { sock.end(undefined) } catch {}
          wipeOnBoot = true
          pairingRequested = false
          closeCount = 0
          setTimeout(() => { if (!destroyed) start().catch(e => console.log('[ERR] restart', e?.message || e)) }, 3000)
          return
        }
        destroyed = true
        wipeAuthContents()
        console.log('[CONN] logged out — auth cleared, not reconnecting')
        return
      }
      closeCount++
      if (!state.creds.registered && closeCount > 12) {
        console.log('[CONN] too many closes while unpaired — stopping')
        destroyed = true
        return
      }
      setTimeout(() => { if (!destroyed) start().catch(e => console.log('[ERR] restart', e?.message || e)) }, 4000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[UPSERT] type=${type} count=${messages.length}`)
    for (const msg of messages) {
      try {
        if (!msg.message) {
          if (msg.key?.isViewOnce) console.log('[MEDIA] view-once UNAVAILABLE stub, id=', msg.key.id)
          continue
        }
        const found = findMedia(msg.message)
        if (!found) continue
        const m = found.media
        const keyLen = m.mediaKey ? Buffer.from(m.mediaKey).length : 0
        console.log(`[MEDIA] id=${msg.key.id} chat=${msg.key.remoteJid} fromMe=${!!msg.key.fromMe} type=${found.type} wrapper=${found.path} keyIsViewOnce=${!!msg.key.isViewOnce} mediaViewOnce=${!!m.viewOnce} keyLen=${keyLen} path=${m.directPath ? 'hai' : 'nahi'} url=${m.url ? 'hai' : 'nahi'}`)
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
          console.log(`[DOWNLOAD] OK id=${msg.key.id} bytes=${buf.length}`)
          if (!msg.key.fromMe && (found.type === 'imageMessage' || found.type === 'videoMessage')) {
            const payload = found.type === 'imageMessage'
              ? { image: buf, caption: 'REDX TEST: media recovered by fork bot' }
              : { video: buf, caption: 'REDX TEST: media recovered by fork bot' }
            await sock.sendMessage(msg.key.remoteJid, payload)
            console.log(`[DOWNLOAD] SENT_BACK id=${msg.key.id}`)
          }
        } catch (e) {
          console.log(`[DOWNLOAD] FAIL id=${msg.key.id} err=${e?.message || e}`)
        }
      } catch (e) {
        console.log('[MSG] handler error:', e?.message || e)
      }
    }
  })
}

start().catch(e => console.log('[ERR] boot', e?.message || e))

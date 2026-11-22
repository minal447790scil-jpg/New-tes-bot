// TEST BOT v2 — isolated diagnostic bot. Main bot is NOT touched by this.
// Question: the Qadeer panel bot (which demonstrably recovers view-once on
// the owner's account) belongs to a bot family whose public code pins
// STOCK Baileys 6.7.18 / 7.0.0-rc9 — older generations than the rc13/rc16
// that receive view-once keyless or as unavailable stubs. Does stock
// 6.7.18, with its own default identity/version, receive a fresh incoming
// view-once WITH a mediaKey (keyLen>0) that downloads? Logs give the verdict.
import baileys from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'

const makeWASocket = baileys.default || baileys.makeWASocket || baileys
const {
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
  Browsers,
  DEFAULT_CONNECTION_CONFIG,
  fetchLatestBaileysVersion
} = baileys

const PHONE = (process.env.PAIR_NUMBER || '').replace(/\D/g, '')
const AUTH_DIR = process.env.AUTH_DIR || './auth'
const logger = pino({ level: 'silent' })

console.log('[BOOT] redx-test-bot starting')
console.log('[BOOT] baileys 6.7.18 default browser =', JSON.stringify(DEFAULT_CONNECTION_CONFIG.browser), '| wa version =', JSON.stringify(DEFAULT_CONNECTION_CONFIG.version))
console.log('[BOOT] pair number =', PHONE || '(PAIR_NUMBER not set!)')

let sock = null
let destroyed = false
let pairingRequested = false
let closeCount = 0
let wipeOnBoot = false
const resendTried = new Set()

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

  // 6.7.18's bundled WA version is below WhatsApp's current minimum
  // (server closes with 405). Every real 6.7 bot fetches the live version
  // at boot — do exactly that; identity stays the stock Ubuntu/Chrome.
  let version = DEFAULT_CONNECTION_CONFIG.version
  try {
    const latest = await fetchLatestBaileysVersion()
    if (latest?.version) version = latest.version
  } catch (e) {
    console.log('[BOOT] fetchLatestBaileysVersion failed, using default:', e?.message || e)
  }
  console.log('[BOOT] using wa version =', JSON.stringify(version))

  sock = makeWASocket({
    auth: state,
    logger,
    version
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
        console.log(`[SHAPE] id=${msg.key.id} chat=${msg.key.remoteJid} fromMe=${!!msg.key.fromMe} stubType=${msg.messageStubType ?? '-'} stubParams=${JSON.stringify(msg.messageStubParameters || [])} msgKeys=${msg.message ? Object.keys(msg.message).join(',') : '(none)'} keyIsViewOnce=${!!msg.key?.isViewOnce}`)
        if (!msg.message) {
          if (msg.key?.isViewOnce) console.log('[MEDIA] view-once UNAVAILABLE stub, id=', msg.key.id)
          // ACTIVE step never tried on any build: if the server delivered an
          // "absent from node" placeholder, ask the primary phone to resend
          // the full message via placeholder resend, once per message id.
          const absent = (msg.messageStubParameters || []).some(p => String(p).toLowerCase().includes('absent'))
          const jid = msg.key.remoteJid || ''
          if (absent && !msg.key.fromMe && !jid.endsWith('@newsletter') && jid !== 'status@broadcast' && !resendTried.has(msg.key.id)) {
            resendTried.add(msg.key.id)
            try {
              const r = await sock.requestPlaceholderResend(msg.key)
              console.log(`[RESEND] placeholder resend requested id=${msg.key.id} result=${r}`)
            } catch (e) {
              console.log(`[RESEND] failed id=${msg.key.id} err=${e?.message || e}`)
            }
          }
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

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode";
import path from "path";
import fs from "fs";
import { Writable } from "stream";
import axios from "axios";
import pino from "pino";

// ─── Config ───────────────────────────────────────────────────────────────────

const SESSIONS_DIR    = process.env.SESSIONS_DIR    ?? "/data/sessions";
const BRIDGE_SECRET   = process.env.BRIDGE_SECRET   ?? "";
const WEBHOOK_URL     = process.env.VITRYN_WEBHOOK_URL ?? "";

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionStatus = "disconnected" | "qr_pending" | "connected";

interface SessionState {
  socket:         WASocket | null;
  status:         SessionStatus;
  qr:             string | null; // base64 PNG data URL for display
  phone:          string | null; // connected phone number (digits only)
  retries:        number;
  repairSession?: (jid: string) => Promise<void>;
}

// ─── In-memory registry ───────────────────────────────────────────────────────

const sessions = new Map<string, SessionState>();

function getOrCreate(merchantId: string): SessionState {
  if (!sessions.has(merchantId)) {
    sessions.set(merchantId, {
      socket:  null,
      status:  "disconnected",
      qr:      null,
      phone:   null,
      retries: 0,
    });
  }
  return sessions.get(merchantId)!;
}

// ─── Webhook helper ───────────────────────────────────────────────────────────

async function notify(
  merchantId: string,
  event: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (!WEBHOOK_URL) return;
  try {
    await axios.post(
      `${WEBHOOK_URL}/api/wa/webhook`,
      { secret: BRIDGE_SECRET, merchantId, event, ...extra },
      { timeout: 8000 },
    );
  } catch {
    // Non-blocking — Vitryn may be temporarily unavailable
  }
}

// ─── Bad MAC auto-repair ──────────────────────────────────────────────────────
// Tracks Signal decryption failures per (merchantId, jid).
// After BAD_MAC_THRESHOLD failures, clears the corrupted Signal session keys
// so Baileys renegotiates them on the next message — NO QR rescan needed.

const macFailures   = new Map<string, number>(); // key: "merchantId:jid"
const macRepairedAt = new Map<string, number>(); // value: unix timestamp ms

const BAD_MAC_THRESHOLD   = 3;
const BAD_MAC_COOLDOWN_MS = 60_000;

async function handleBadMac(merchantId: string, jid: string): Promise<void> {
  const key   = `${merchantId}:${jid}`;
  const count = (macFailures.get(key) ?? 0) + 1;
  macFailures.set(key, count);

  const now        = Date.now();
  const repairedAt = macRepairedAt.get(key) ?? 0;
  if (now - repairedAt < BAD_MAC_COOLDOWN_MS) return; // still in cooldown

  console.warn(`[bad-mac] ${key} — failure #${count}`);

  if (count >= BAD_MAC_THRESHOLD) {
    const state = sessions.get(merchantId);
    if (state?.repairSession) {
      console.warn(`[bad-mac] Threshold reached — repairing Signal session for ${jid}...`);
      try {
        await state.repairSession(jid);
        macFailures.set(key, 0);
        macRepairedAt.set(key, now);
        console.log(`[bad-mac] Session repaired for ${jid}. Baileys will renegotiate on next exchange.`);
      } catch (err) {
        console.error(`[bad-mac] Repair failed for ${jid}:`, err);
      }
    }
  }
}

// ─── Baileys logger with Bad MAC interception ─────────────────────────────────
// Logs Baileys errors to stdout AND watches for Bad MAC patterns so we can
// trigger auto-repair without requiring a new QR scan.

function makeBaileysLogger(merchantId: string): ReturnType<typeof pino> {
  const dest = new Writable({
    write(chunk: Buffer, _encoding: string, done: () => void) {
      // Write to stdout so Railway captures it
      process.stdout.write(chunk);

      const line = chunk.toString().trimEnd();
      if (!line) { done(); return; }

      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const msg   = String(entry.msg ?? "");

        // Detect Bad MAC / decrypt failure patterns in Baileys log output
        if (
          msg.toLowerCase().includes("bad mac") ||
          msg.toLowerCase().includes("failed to decrypt") ||
          msg.toLowerCase().includes("error in signal decrypt")
        ) {
          // Baileys may log remoteJid at top level or nested under msgKey
          const jid =
            (entry.remoteJid as string | undefined) ??
            (entry.jid       as string | undefined) ??
            ((entry.msgKey as Record<string, unknown> | undefined)?.remoteJid as string | undefined) ??
            null;

          if (jid && jid.endsWith("@s.whatsapp.net")) {
            handleBadMac(merchantId, jid).catch(console.error);
          }
        }
      } catch {
        // Non-JSON line — ignore
      }

      done();
    },
  });

  return pino({ level: "error" }, dest);
}

// ─── Session initialisation ───────────────────────────────────────────────────

const MAX_RETRIES  = 5;
const RETRY_DELAYS = [5_000, 10_000, 20_000, 40_000, 60_000];

export async function initSession(merchantId: string): Promise<void> {
  const state = getOrCreate(merchantId);

  if (state.status === "connected" || state.status === "qr_pending") return;

  const dir = path.join(SESSIONS_DIR, merchantId);
  fs.mkdirSync(dir, { recursive: true });

  state.status = "qr_pending";
  state.qr     = null;
  state.phone  = null;

  const { state: authState, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  // Register Signal session repair closure so handleBadMac() can call it
  state.repairSession = async (jid: string) => {
    // Setting a key to null removes the Signal session file for that JID,
    // forcing Baileys to perform a fresh key exchange on the next message.
    // This does NOT require a new QR scan — only affects E2E keys with this contact.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (authState.keys as any).set({ session: { [jid]: null } });
    await saveCreds();
  };

  const sock = makeWASocket({
    version,
    auth:               authState,
    browser:            Browsers.ubuntu("Chrome"),
    printQRInTerminal:  false,
    logger:             makeBaileysLogger(merchantId),
    // Human-like: don't mark messages as read automatically
    markOnlineOnConnect: false,
  });

  state.socket = sock;

  // Persist credentials on every update
  sock.ev.on("creds.update", saveCreds);

  // ── Connection state changes ──────────────────────────────────────────────

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr: qrStr } = update;

    // New QR code available
    if (qrStr) {
      try {
        state.qr     = await qrcode.toDataURL(qrStr);
        state.status = "qr_pending";
      } catch {
        state.qr = null;
      }
    }

    if (connection === "open") {
      state.status  = "connected";
      state.qr      = null;
      state.retries = 0;

      // Parse connected phone from JID e.g. "221XXXXXXXX:42@s.whatsapp.net"
      const jidPhone = sock.user?.id?.split(":")[0] ?? null;
      state.phone = jidPhone;

      await notify(merchantId, "connected", { phone: jidPhone ?? "" });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom | undefined)
        ?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      state.socket = null;
      state.qr     = null;

      if (loggedOut) {
        // Clear session files — user logged out on phone
        state.status        = "disconnected";
        state.phone         = null;
        state.repairSession = undefined;
        clearSessionDir(dir);
        await notify(merchantId, "disconnected", {});
        sessions.delete(merchantId);
      } else if (state.retries < MAX_RETRIES) {
        // Transient disconnect — reconnect with backoff
        const delay = RETRY_DELAYS[Math.min(state.retries, RETRY_DELAYS.length - 1)];
        state.retries++;
        state.status = "disconnected";
        setTimeout(() => initSession(merchantId).catch(console.error), delay);
      } else {
        // Too many retries — give up
        state.status        = "disconnected";
        state.phone         = null;
        state.repairSession = undefined;
        await notify(merchantId, "disconnected", {});
      }
    }
  });

  // ── Incoming messages ─────────────────────────────────────────────────────

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Skip outbound and status messages
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid ?? "";
      // Only handle direct user chats (not groups or broadcast)
      if (!remoteJid.endsWith("@s.whatsapp.net")) continue;

      const phone = remoteJid.replace("@s.whatsapp.net", "");
      const body  =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        "";

      if (!body || !phone) continue;

      await notify(merchantId, "message", {
        from:      phone,
        body,
        timestamp: Number(msg.messageTimestamp ?? 0),
      });
    }
  });

  // ── Delivery ACK tracking ─────────────────────────────────────────────────
  // status 2 = DELIVERY_ACK (message reached recipient's device)
  // status 3 = READ          (recipient opened the message)

  sock.ev.on("messages.update", (updates) => {
    for (const { key, update } of updates) {
      if (!key.fromMe) continue; // Only track our outbound messages
      const jid    = key.remoteJid ?? "";
      if (!jid.endsWith("@s.whatsapp.net")) continue;

      const status = update.status;
      if (status !== 2 && status !== 3) continue;

      const baileysMessageId = key.id;
      if (!baileysMessageId) continue;

      const statusStr = status === 2 ? "delivered" : "read";
      notify(merchantId, "status_update", { baileysMessageId, status: statusStr }).catch(() => {});
    }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getStatus(
  merchantId: string,
): { status: SessionStatus; qr: string | null; phone: string | null } {
  const state = sessions.get(merchantId);
  return {
    status: state?.status ?? "disconnected",
    qr:     state?.qr     ?? null,
    phone:  state?.phone  ?? null,
  };
}

/**
 * Send a text message with a human-like delay (2–7 s).
 * Returns the Baileys message ID (for delivery tracking), or null on failure.
 * Throws if the session is not connected.
 */
export async function sendMessage(
  merchantId: string,
  phone: string,
  text: string,
): Promise<string | null> {
  const state = sessions.get(merchantId);
  if (!state || state.status !== "connected" || !state.socket) {
    throw new Error("Session not connected");
  }

  // Random delay to avoid bot-detection heuristics
  const delay = 2_000 + Math.random() * 5_000;
  await new Promise<void>((r) => setTimeout(r, delay));

  const jid    = phone.replace(/\D/g, "") + "@s.whatsapp.net";
  const result = await state.socket.sendMessage(jid, { text });
  return result?.key?.id ?? null;
}

/**
 * Disconnect a session and clean up all state + files.
 */
export async function disconnectSession(merchantId: string): Promise<void> {
  const state = sessions.get(merchantId);
  if (!state) return;

  try {
    await state.socket?.logout();
  } catch { /* ignore */ }

  state.socket        = null;
  state.status        = "disconnected";
  state.qr            = null;
  state.phone         = null;
  state.repairSession = undefined;

  const dir = path.join(SESSIONS_DIR, merchantId);
  clearSessionDir(dir);
  sessions.delete(merchantId);
}

/**
 * Gracefully close all active WhatsApp sessions.
 * Called on SIGTERM so Railway's rolling deploy doesn't corrupt Signal sessions.
 * Does NOT log out — sessions are preserved on disk for the next start.
 */
export async function gracefulShutdown(): Promise<void> {
  console.log("[shutdown] Closing all WhatsApp sessions gracefully…");

  for (const [merchantId, state] of sessions) {
    if (!state.socket) continue;
    console.log(`[shutdown] Closing session for merchantId=${merchantId}`);
    try {
      // Remove all listeners first so the reconnect handler doesn't fire
      state.socket.ev.removeAllListeners();
      // Close the underlying WebSocket cleanly (code 1000 = Normal Closure)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (state.socket as any).ws?.close(1000, "Server shutdown");
    } catch {
      /* ignore */
    }
    state.socket = null;
    state.status = "disconnected";
  }

  sessions.clear();
  macFailures.clear();
  macRepairedAt.clear();

  // Allow 2 s for the WS close frame to flush
  await new Promise<void>((r) => setTimeout(r, 2_000));
  console.log("[shutdown] Done.");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearSessionDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

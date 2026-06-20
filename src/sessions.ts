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

// ─── Startup validation ──────────────────────────────────────────────────────

if (!WEBHOOK_URL) {
  console.warn("[config] VITRYN_WEBHOOK_URL is not set — inbound messages and status updates will NOT be forwarded");
}

try {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.accessSync(SESSIONS_DIR, fs.constants.W_OK);
  console.log(`[config] Sessions directory OK: ${SESSIONS_DIR}`);
} catch (err) {
  console.error(`[config] FATAL — Sessions directory ${SESSIONS_DIR} is not writable:`, err);
  process.exit(1);
}

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionStatus = "disconnected" | "qr_pending" | "connected";

interface SessionState {
  socket:         WASocket | null;
  status:         SessionStatus;
  qr:             string | null;
  phone:          string | null;
  retries:        number;
  lastActivity:   number; // Date.now() of last connect/message
  repairSession?: (jid: string) => Promise<void>;
}

// ─── In-memory registry ───────────────────────────────────────────────────────

const sessions = new Map<string, SessionState>();

function getOrCreate(merchantId: string): SessionState {
  if (!sessions.has(merchantId)) {
    sessions.set(merchantId, {
      socket:       null,
      status:       "disconnected",
      qr:           null,
      phone:        null,
      retries:      0,
      lastActivity: Date.now(),
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
  } catch (err) {
    // Log webhook failures so they're visible in Railway logs
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[webhook] Failed to notify event=${event} merchant=${merchantId}: ${msg}`);
  }
}

// ─── Bad MAC auto-repair ──────────────────────────────────────────────────────

const macFailures   = new Map<string, number>();
const macRepairedAt = new Map<string, number>();

const BAD_MAC_THRESHOLD   = 3;
const BAD_MAC_COOLDOWN_MS = 60_000;

async function handleBadMac(merchantId: string, jid: string): Promise<void> {
  const key   = `${merchantId}:${jid}`;
  const count = (macFailures.get(key) ?? 0) + 1;
  macFailures.set(key, count);

  const now        = Date.now();
  const repairedAt = macRepairedAt.get(key) ?? 0;
  if (now - repairedAt < BAD_MAC_COOLDOWN_MS) return;

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

function makeBaileysLogger(merchantId: string): ReturnType<typeof pino> {
  const dest = new Writable({
    write(chunk: Buffer, _encoding: string, done: () => void) {
      process.stdout.write(chunk);

      const line = chunk.toString().trimEnd();
      if (!line) { done(); return; }

      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const msg   = String(entry.msg ?? "");

        if (
          msg.toLowerCase().includes("bad mac") ||
          msg.toLowerCase().includes("failed to decrypt") ||
          msg.toLowerCase().includes("error in signal decrypt")
        ) {
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
        // Non-JSON line
      }

      done();
    },
  });

  return pino({ level: "error" }, dest);
}

// ─── Session initialisation ───────────────────────────────────────────────────

const MAX_RETRIES  = 8;
const RETRY_DELAYS = [3_000, 5_000, 10_000, 20_000, 40_000, 60_000, 90_000, 120_000];

/** Add jitter ±30% to a delay to prevent thundering herd */
function jitter(delay: number): number {
  const factor = 0.7 + Math.random() * 0.6; // 0.7 – 1.3
  return Math.round(delay * factor);
}

export async function initSession(merchantId: string): Promise<void> {
  const state = getOrCreate(merchantId);

  if (state.status === "connected" || state.status === "qr_pending") return;

  const dir = path.join(SESSIONS_DIR, merchantId);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(`[session] Failed to create session dir for ${merchantId}:`, err);
    return;
  }

  state.status = "qr_pending";
  state.qr     = null;
  state.phone  = null;

  const { state: authState, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  state.repairSession = async (jid: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (authState.keys as any).set({ session: { [jid]: null } });
    await saveCreds();
  };

  const sock = makeWASocket({
    version,
    auth:                authState,
    // Use macOS Safari — much less likely to be flagged than ubuntu/Chrome
    browser:             Browsers.macOS("Safari"),
    printQRInTerminal:   false,
    logger:              makeBaileysLogger(merchantId),
    markOnlineOnConnect: false,
    // Sync a minimal message history to reduce bandwidth & session complexity
    syncFullHistory:     false,
  });

  state.socket = sock;

  sock.ev.on("creds.update", saveCreds);

  // ── Connection state changes ──────────────────────────────────────────────

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr: qrStr } = update;

    if (qrStr) {
      try {
        state.qr     = await qrcode.toDataURL(qrStr);
        state.status = "qr_pending";
        console.log(`[session] QR generated for merchantId=${merchantId}`);
      } catch {
        state.qr = null;
      }
    }

    if (connection === "open") {
      state.status       = "connected";
      state.qr           = null;
      state.retries      = 0;
      state.lastActivity = Date.now();

      const jidPhone = sock.user?.id?.split(":")[0] ?? null;
      state.phone = jidPhone;

      console.log(`[session] Connected: merchantId=${merchantId} phone=${jidPhone}`);
      await notify(merchantId, "connected", { phone: jidPhone ?? "" });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom | undefined)
        ?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`[session] Disconnected: merchantId=${merchantId} statusCode=${statusCode} loggedOut=${loggedOut}`);

      state.socket = null;
      state.qr     = null;

      if (loggedOut) {
        state.status        = "disconnected";
        state.phone         = null;
        state.repairSession = undefined;
        clearSessionDir(dir);
        await notify(merchantId, "disconnected", {});
        sessions.delete(merchantId);
      } else if (state.retries < MAX_RETRIES) {
        const baseDelay = RETRY_DELAYS[Math.min(state.retries, RETRY_DELAYS.length - 1)];
        const delay = jitter(baseDelay);
        state.retries++;
        state.status = "disconnected";
        console.log(`[session] Reconnecting merchantId=${merchantId} in ${delay}ms (retry ${state.retries}/${MAX_RETRIES})`);
        setTimeout(() => initSession(merchantId).catch(console.error), delay);
      } else {
        state.status        = "disconnected";
        state.phone         = null;
        state.repairSession = undefined;
        console.error(`[session] Max retries exhausted for merchantId=${merchantId}`);
        await notify(merchantId, "disconnected", {});
      }
    }
  });

  // ── Incoming messages ─────────────────────────────────────────────────────

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid ?? "";
      if (!remoteJid.endsWith("@s.whatsapp.net")) continue;

      const phone = remoteJid.replace("@s.whatsapp.net", "");
      const body  =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        "";

      if (!body || !phone) continue;

      state.lastActivity = Date.now();
      console.log(`[message] Inbound from=${phone} merchant=${merchantId} len=${body.length}`);
      await notify(merchantId, "message", {
        from:      phone,
        body,
        timestamp: Number(msg.messageTimestamp ?? 0),
      });
    }
  });

  // ── Delivery ACK tracking ─────────────────────────────────────────────────

  sock.ev.on("messages.update", (updates) => {
    for (const { key, update } of updates) {
      if (!key.fromMe) continue;
      const jid = key.remoteJid ?? "";
      if (!jid.endsWith("@s.whatsapp.net")) continue;

      const status = update.status;
      if (status !== 2 && status !== 3) continue;

      const baileysMessageId = key.id;
      if (!baileysMessageId) continue;

      const statusStr = status === 2 ? "delivered" : "read";
      console.log(`[ack] ${statusStr}: messageId=${baileysMessageId} merchant=${merchantId}`);
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

/** Validate phone number format before building JID */
function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
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

  const cleanPhone = phone.replace(/\D/g, "");
  if (!isValidPhone(cleanPhone)) {
    throw new Error(`Invalid phone number: ${phone}`);
  }

  // Random delay to avoid bot-detection heuristics
  const delay = 2_000 + Math.random() * 5_000;
  await new Promise<void>((r) => setTimeout(r, delay));

  const jid = cleanPhone + "@s.whatsapp.net";
  console.log(`[message] Outbound to=${cleanPhone} merchant=${merchantId} len=${text.length}`);
  const result = await state.socket.sendMessage(jid, { text });
  state.lastActivity = Date.now();
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

  // Always clean up session files, even if logout failed
  const dir = path.join(SESSIONS_DIR, merchantId);
  clearSessionDir(dir);

  state.socket        = null;
  state.status        = "disconnected";
  state.qr            = null;
  state.phone         = null;
  state.repairSession = undefined;
  sessions.delete(merchantId);

  console.log(`[session] Disconnected and cleaned: merchantId=${merchantId}`);
}

/**
 * Gracefully close all active WhatsApp sessions.
 * Called on SIGTERM so Railway's rolling deploy doesn't corrupt Signal sessions.
 * Does NOT log out — sessions are preserved on disk for the next start.
 */
export async function gracefulShutdown(): Promise<void> {
  console.log(`[shutdown] Closing ${sessions.size} session(s) gracefully…`);

  const SHUTDOWN_TIMEOUT_MS = 5_000;
  const closePromises: Promise<void>[] = [];

  for (const [merchantId, state] of sessions) {
    if (!state.socket) continue;

    const closeOne = new Promise<void>((resolve) => {
      console.log(`[shutdown] Closing session for merchantId=${merchantId}`);
      try {
        state.socket!.ev.removeAllListeners();

        // Close the underlying WebSocket cleanly
        const ws = (state.socket as Record<string, unknown>).ws;
        if (ws && typeof (ws as { close?: Function }).close === "function") {
          (ws as { close: Function }).close(1000, "Server shutdown");
        }
      } catch (err) {
        console.error(`[shutdown] Error closing ${merchantId}:`, err);
      }
      state.socket = null;
      state.status = "disconnected";
      resolve();
    });

    closePromises.push(closeOne);
  }

  // Race: either all sessions close or we timeout
  await Promise.race([
    Promise.allSettled(closePromises),
    new Promise<void>((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS)),
  ]);

  sessions.clear();
  macFailures.clear();
  macRepairedAt.clear();

  console.log("[shutdown] Done.");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearSessionDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

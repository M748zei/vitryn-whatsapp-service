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
import axios from "axios";
import pino from "pino";

// ─── Config ───────────────────────────────────────────────────────────────────

const SESSIONS_DIR    = process.env.SESSIONS_DIR    ?? "/data/sessions";
const BRIDGE_SECRET   = process.env.BRIDGE_SECRET   ?? "";
const WEBHOOK_URL     = process.env.VITRYN_WEBHOOK_URL ?? "";

const silentLogger = pino({ level: "silent" });

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionStatus = "disconnected" | "qr_pending" | "connected";

interface SessionState {
  socket:  WASocket | null;
  status:  SessionStatus;
  qr:      string | null; // base64 PNG data URL for display
  phone:   string | null; // connected phone number (digits only)
  retries: number;
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

// ─── Session initialisation ───────────────────────────────────────────────────

const MAX_RETRIES = 5;
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

  const sock = makeWASocket({
    version,
    auth:               authState,
    browser:            Browsers.ubuntu("Chrome"),
    printQRInTerminal:  false,
    logger:             silentLogger,
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
        state.status = "disconnected";
        state.phone  = null;
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
        state.status = "disconnected";
        state.phone  = null;
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
 * Throws if the session is not connected.
 */
export async function sendMessage(
  merchantId: string,
  phone: string,
  text: string,
): Promise<void> {
  const state = sessions.get(merchantId);
  if (!state || state.status !== "connected" || !state.socket) {
    throw new Error("Session not connected");
  }

  // Random delay to avoid bot-detection heuristics
  const delay = 2_000 + Math.random() * 5_000;
  await new Promise<void>((r) => setTimeout(r, delay));

  const jid = phone.replace(/\D/g, "") + "@s.whatsapp.net";
  await state.socket.sendMessage(jid, { text });
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

  state.socket = null;
  state.status = "disconnected";
  state.qr     = null;
  state.phone  = null;

  const dir = path.join(SESSIONS_DIR, merchantId);
  clearSessionDir(dir);
  sessions.delete(merchantId);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearSessionDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

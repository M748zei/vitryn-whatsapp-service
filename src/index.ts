import express from "express";
import { initSession, getStatus, sendMessage, disconnectSession, gracefulShutdown } from "./sessions";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT          = parseInt(process.env.PORT ?? "3001");
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? "";

if (!BRIDGE_SECRET) {
  console.error("BRIDGE_SECRET env var is required");
  process.exit(1);
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "512kb" }));

// ── Auth middleware ────────────────────────────────────────────────────────────

function requireSecret(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const secret = req.headers["x-bridge-secret"];
  if (secret !== BRIDGE_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check (no auth required)
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/**
 * GET /sessions/:merchantId/status
 * Returns current session status + QR (if pending) + connected phone.
 * Auto-initialises a disconnected session if ?init=1 is passed.
 */
app.get("/sessions/:merchantId/status", requireSecret, async (req, res) => {
  const { merchantId } = req.params;
  const shouldInit = req.query["init"] === "1";

  const current = getStatus(merchantId);

  if (current.status === "disconnected" && shouldInit) {
    // Kick off session init (non-blocking)
    initSession(merchantId).catch(console.error);

    // Wait briefly for QR to be generated
    await new Promise<void>((r) => setTimeout(r, 800));
    return res.json(getStatus(merchantId));
  }

  res.json(current);
});

/**
 * POST /sessions/:merchantId/send
 * Send a text message from this merchant's connected session.
 * Body: { phone: string, text: string }
 * Returns: { ok: true, messageId: string | null }
 */
app.post("/sessions/:merchantId/send", requireSecret, async (req, res) => {
  const { merchantId } = req.params;
  const { phone, text } = req.body as { phone?: string; text?: string };

  if (!phone || !text) {
    res.status(400).json({ error: "phone and text are required" });
    return;
  }

  try {
    const messageId = await sendMessage(merchantId, phone, text);
    res.json({ ok: true, messageId: messageId ?? null });
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

/**
 * DELETE /sessions/:merchantId
 * Disconnect and clean up the session.
 */
app.delete("/sessions/:merchantId", requireSecret, async (req, res) => {
  const { merchantId } = req.params;
  await disconnectSession(merchantId);
  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`WhatsApp bridge listening on :${PORT}`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Railway sends SIGTERM before killing the container on redeploy.
// We intercept it, close all WA WebSocket connections cleanly (no QR rescan
// needed on next start because we do NOT call logout()), then exit.

async function onSigterm(): Promise<void> {
  console.log("[shutdown] SIGTERM received — initiating graceful shutdown");

  // Stop accepting new HTTP requests
  server.close(() => {
    console.log("[shutdown] HTTP server closed");
  });

  try {
    await gracefulShutdown();
  } catch (err) {
    console.error("[shutdown] Error during graceful shutdown:", err);
  }

  process.exit(0);
}

process.on("SIGTERM", () => { onSigterm().catch(console.error); });
// Also handle SIGINT (Ctrl-C in dev)
process.on("SIGINT",  () => { onSigterm().catch(console.error); });

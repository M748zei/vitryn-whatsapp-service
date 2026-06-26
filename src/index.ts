import express from "express";
import { initSession, getStatus, sendMessage, disconnectSession, gracefulShutdown } from "./sessions";
import { enqueueMessage } from "./send-queue";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT          = parseInt(process.env.PORT ?? "3001");
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? "";

if (!BRIDGE_SECRET) {
  console.error("[config] FATAL — BRIDGE_SECRET env var is required");
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

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/**
 * GET /sessions/:merchantId/status
 * Returns current session status + QR (if pending) + connected phone.
 * Auto-initialises a disconnected session if ?init=1 is passed.
 *
 * Uses polling with up to 3s wait for QR generation (instead of a fixed 800ms).
 */
app.get("/sessions/:merchantId/status", requireSecret, async (req, res) => {
  const { merchantId } = req.params;
  const shouldInit = req.query["init"] === "1";

  const current = getStatus(merchantId);

  if (current.status === "disconnected" && shouldInit) {
    initSession(merchantId).catch(console.error);

    // Poll for QR up to 3s (300ms intervals × 10 tries)
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((r) => setTimeout(r, 300));
      const s = getStatus(merchantId);
      if (s.qr || s.status === "connected") {
        return res.json(s);
      }
    }

    return res.json(getStatus(merchantId));
  }

  res.json(current);
});

/**
 * POST /sessions/:merchantId/send
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
    const messageId = await enqueueMessage(merchantId, phone, text, sendMessage);
    res.json({ ok: true, messageId: messageId ?? null });
  } catch (err) {
    const errMsg = (err as Error).message;
    console.error(`[send] Error for merchant=${merchantId}: ${errMsg}`);
    res.status(409).json({ error: errMsg });
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
  console.log(`[bridge] WhatsApp bridge listening on :${PORT}`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

async function onSigterm(): Promise<void> {
  if (shuttingDown) return; // Prevent double shutdown
  shuttingDown = true;

  console.log("[shutdown] SIGTERM received — initiating graceful shutdown");

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
process.on("SIGINT",  () => { onSigterm().catch(console.error); });

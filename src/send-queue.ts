import fs from "fs";
import path from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const SESSIONS_DIR = process.env.SESSIONS_DIR ?? "/data/sessions";
const COUNTS_FILE  = path.join(SESSIONS_DIR, "daily-counts.json");
const COUNTS_TMP   = COUNTS_FILE + ".tmp";

const DAILY_CAP        = 150;
const GAP_MIN_MS       = 8_000;
const GAP_MAX_MS       = 15_000;
const QUEUE_TIMEOUT_MS = 28_000;

// ─── Persistent daily counter ────────────────────────────────────────────────

type DailyCounts = Record<string, { date: string; count: number }>;

let counts: DailyCounts = {};

function loadCounts(): void {
  try {
    const raw = fs.readFileSync(COUNTS_FILE, "utf-8");
    counts = JSON.parse(raw) as DailyCounts;
  } catch {
    counts = {};
  }
}

loadCounts();

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function getCount(merchantId: string): number {
  const entry = counts[merchantId];
  if (!entry || entry.date !== todayStr()) return 0;
  return entry.count;
}

function saveCounts(): void {
  try {
    fs.writeFileSync(COUNTS_TMP, JSON.stringify(counts), "utf-8");
    fs.renameSync(COUNTS_TMP, COUNTS_FILE);
  } catch (err) {
    console.error("[send-queue] Failed to persist daily counts:", err);
  }
}

function incrementCount(merchantId: string): void {
  const today = todayStr();
  const entry = counts[merchantId];
  if (!entry || entry.date !== today) {
    counts[merchantId] = { date: today, count: 1 };
  } else {
    entry.count += 1;
  }
  saveCounts();
}

// ─── Per-merchant sequential queue ───────────────────────────────────────────

const queues:       Map<string, Promise<unknown>> = new Map();
const lastSentAt:   Map<string, number>           = new Map();
const pendingCount: Map<string, number>           = new Map();

type DoSend = (merchantId: string, phone: string, text: string) => Promise<string | null>;

async function runOne(
  merchantId: string,
  phone: string,
  text: string,
  doSend: DoSend,
): Promise<string | null> {
  if (getCount(merchantId) >= DAILY_CAP) {
    throw new Error("DAILY_LIMIT_REACHED");
  }

  const since  = Date.now() - (lastSentAt.get(merchantId) ?? 0);
  const target = GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS);
  if (since < target) {
    await new Promise<void>((r) => setTimeout(r, target - since));
  }

  const id = await doSend(merchantId, phone, text);
  lastSentAt.set(merchantId, Date.now());
  incrementCount(merchantId);
  return id;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function enqueueMessage(
  merchantId: string,
  phone: string,
  text: string,
  doSend: DoSend,
): Promise<string | null> {
  const pending = pendingCount.get(merchantId) ?? 0;
  if (pending * GAP_MAX_MS > QUEUE_TIMEOUT_MS) {
    return Promise.reject(new Error("QUEUE_FULL"));
  }

  if (getCount(merchantId) >= DAILY_CAP) {
    return Promise.reject(new Error("DAILY_LIMIT_REACHED"));
  }

  pendingCount.set(merchantId, pending + 1);

  const prev = queues.get(merchantId) ?? Promise.resolve();

  const task = prev.then(() => runOne(merchantId, phone, text, doSend));

  // Store a non-rejecting chain so one failure doesn't break subsequent messages
  queues.set(merchantId, task.catch(() => {}));

  // Decrement pending regardless of success/failure
  const result = task.finally(() => {
    const cur = pendingCount.get(merchantId) ?? 1;
    if (cur <= 1) {
      pendingCount.delete(merchantId);
    } else {
      pendingCount.set(merchantId, cur - 1);
    }
  });

  return result;
}

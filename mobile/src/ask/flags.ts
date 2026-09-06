/**
 * Flagged answers — the phone half of the Ask Tusk review log.
 *
 * A 👍/👎 under a Tusk reply is captured here with everything a later
 * review needs: the exact question, the exact answer, which brain answered
 * (laptop or this phone), the intent/provenance if known, an optional note,
 * and when it was shown. Flags are queued in the SQLite `meta` table so a
 * rating given in a store with no Wi-Fi isn't lost, and flushed to
 * `POST /api/mobile/ask/feedback` after each sync (or immediately when
 * the laptop is reachable). On the laptop they land in the same
 * `var/assistant_feedback` log as the web app's thumbs, tagged
 * device='phone', so one review list covers both apps.
 *
 * This is a note about an answer, not a change to any financial record —
 * the read-only contract on the ledger is untouched.
 */
import { create } from 'zustand';
import { getMeta, setMeta } from '../db/sqlite';
import { sendAskFeedback } from '../sync/api';
import type { AskFeedbackItemWire } from '../sync/types';

const META_QUEUE = 'ask_flags_v1';
const META_SENT = 'ask_flags_sent_count';

export interface Flag extends AskFeedbackItemWire {
  /** Local id so the UI can mark the bubble as rated. */
  id: string;
}

interface FlagsState {
  pending: number;
  sent: number;
  set(p: number, s: number): void;
}

export const useFlagsStore = create<FlagsState>((set) => ({
  pending: 0,
  sent: 0,
  set: (pending, sent) => set({ pending, sent }),
}));

async function loadQueue(): Promise<Flag[]> {
  try {
    const raw = await getMeta(META_QUEUE);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Flag[]) : [];
  } catch {
    return [];
  }
}

async function saveQueue(q: Flag[]): Promise<void> {
  await setMeta(META_QUEUE, JSON.stringify(q));
  useFlagsStore.getState().set(q.length, useFlagsStore.getState().sent);
}

async function loadSent(): Promise<number> {
  try {
    return parseInt((await getMeta(META_SENT)) || '0', 10) || 0;
  } catch {
    return 0;
  }
}

/** Fill the store at boot so Settings shows the counts without a round-trip. */
export async function hydrateFlags(): Promise<void> {
  const [q, sent] = await Promise.all([loadQueue(), loadSent()]);
  useFlagsStore.getState().set(q.length, sent);
}

/** Queue a rating and try to send right away. Returns the local id. */
export async function flagAnswer(item: AskFeedbackItemWire): Promise<string> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const q = await loadQueue();
  q.push({ id, ...item, asked_at: item.asked_at ?? Date.now() / 1000 });
  await saveQueue(q);
  flushFlags().catch(() => {});
  return id;
}

let flushing = false;

/**
 * Send everything queued. Best-effort and single-flight: called after each
 * sync and after each new flag. Items are removed only once the laptop has
 * acknowledged them, so a failed send just retries next time.
 */
export async function flushFlags(): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  try {
    const q = await loadQueue();
    if (!q.length) return 0;
    const batch = q.slice(0, 50);
    const res = await sendAskFeedback(batch.map(({ id: _id, ...rest }) => rest));
    if (!res) return 0;                              // older backend (404): keep queued
    const rest = q.slice(batch.length);
    const sent = (await loadSent()) + res.recorded;
    await setMeta(META_SENT, String(sent));
    await setMeta(META_QUEUE, JSON.stringify(rest));
    useFlagsStore.getState().set(rest.length, sent);
    return res.recorded;
  } catch {
    return 0;                                        // offline — stays queued
  } finally {
    flushing = false;
  }
}

/** Forget queued flags (unpair). Sent ones already live on the laptop. */
export async function clearFlags(): Promise<void> {
  try {
    await setMeta(META_QUEUE, '');
    await setMeta(META_SENT, '0');
  } catch {
    // ignore
  }
  useFlagsStore.getState().set(0, 0);
}

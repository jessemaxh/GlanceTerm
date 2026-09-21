import * as fs from 'fs/promises'

/**
 * Incremental, size-safe reading of append-only agent logs.
 *
 * Both usage readers (the sidebar's live token chip and the Token Usage page)
 * walk the same JSONL transcripts by byte offset. Both used to pull the whole
 * unread range into one buffer and call `toString()` on it, and both broke the
 * same way: V8 caps a string at ~512 MB (`Cannot create a string longer than
 * 0x1fffffe8 characters`), so once a session passed that size the read threw,
 * the throw was swallowed as "unreadable file", and that session's tokens
 * vanished — permanently, since the next attempt restarts at offset 0 and
 * fails on the same allocation. Observed on a real 830 MB Claude transcript.
 *
 * Shared rather than duplicated so the two readers cannot drift: the first fix
 * repaired only the sidebar and left the Token Usage page silently dropping the
 * very session that motivated it.
 */

/**
 * Largest slice ever turned into a single JS string.
 *
 * 4 MB rather than something larger because throughput is flat across chunk
 * sizes while jank is linear in them. Measured over a fixed 128 MB budget on
 * the 830 MB transcript:
 *
 *     chunk    wall     worst single block    peak RSS
 *      1 MB   339 ms                 3.5 ms          —
 *      4 MB   333 ms                11.8 ms      141 MB
 *      8 MB   333 ms                21.5 ms          —
 *     32 MB   340 ms                84.7 ms      386 MB
 *
 * 84.7 ms is ~5 dropped frames, and this runs on the RENDERER thread with up
 * to 8 tabs scanning concurrently (1179 MB peak RSS at 32 MB, ~400 MB at 4 MB).
 * 4 MB keeps every block under a frame for the same wall time.
 */
export const READ_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Most bytes ONE POLL may consume, across every file that poll touches.
 *
 * Has to be a shared, decrementing allowance rather than a per-call cap: the
 * Claude reader folds in one file per subagent, and a real session has 906 of
 * them. Capped per call, that poll consumed 969 MB and held the renderer for
 * 3.2 s — and because TabMonitor serialises ticks behind a `busy` flag, that
 * stalls EVERY tab's status, not just the one being read.
 */
export const READ_BUDGET_BYTES = 128 * 1024 * 1024

/**
 * Ceiling for readers that must parse a whole file at once (a Gemini chat is
 * one JSON document, not JSONL, so it cannot be sliced). Just under V8's cap,
 * so the refusal is an explicit skip rather than an exception that reads like
 * "no data".
 */
export const MAX_WHOLE_FILE_BYTES = 480 * 1024 * 1024

/** A poll's remaining read allowance, shared across every file it touches. */
export interface ReadBudget { left: number }

/** Fresh allowance for one poll. */
export function makeReadBudget (bytes: number = READ_BUDGET_BYTES): ReadBudget {
    return { left: bytes }
}

/**
 * Feed `onChunk` the COMPLETE lines in `[offset, size)`, in slices small enough
 * to survive V8's string cap, and return the offset reached. Only ever advances
 * past a newline, so a file being appended to mid-read is never half-parsed.
 *
 * Newlines are located and bytes counted ON THE BUFFER, never by re-encoding a
 * decoded string. A slice can begin mid-character — the oversized-line branch
 * below advances by raw bytes — and those orphan continuation bytes decode to
 * U+FFFD at 3 bytes each, so `Buffer.byteLength(text.slice(...))` reports MORE
 * bytes than were consumed. The offset then walks past EOF, callers see
 * `size < offset`, read it as "the file was truncated" and zero the session's
 * totals — on every poll, forever. A sweep over 361 chunk sizes on CJK content
 * produced wrong totals for 175 of them and an offset past EOF for 9. Byte-side
 * accounting is exact by construction; a leading fragment simply fails to
 * parse, which costs that one record and nothing else.
 *
 * The returned offset always matches what was actually handed to `onChunk`,
 * including when a read fails partway: progress is KEPT rather than discarded,
 * since a caller that already folded those deltas in would otherwise re-read
 * the same bytes and double-count them.
 */
export async function scanFileLines (
    filePath: string,
    offset: number,
    size: number,
    onChunk: (completeLines: string) => void,
    budget: ReadBudget = makeReadBudget(),
    /** Overridable so tests can exercise chunk-boundary behaviour without
     *  writing a multi-megabyte fixture. Production uses the constant. */
    chunkBytes: number = READ_CHUNK_BYTES,
): Promise<number> {
    let cur = offset
    let fh: fs.FileHandle | undefined = undefined
    try {
        fh = await fs.open(filePath, 'r')
        while (cur < size && budget.left > 0) {
            const len = Math.min(chunkBytes, size - cur, budget.left)
            // Zero-filled deliberately. `allocUnsafe` hands back recycled
            // memory, and a short read leaves a previous read's bytes — real
            // transcript text, newlines included — sitting past `bytesRead`.
            // The bounded `slice` below is the actual guard, but that guard is
            // one dropped argument away from silently emitting stale content
            // and over-advancing the offset, and no test can catch it
            // deterministically (a fresh pool allocation is usually clean).
            // Measured cost of zeroing a full 128 MB budget: 4.0 ms vs 0.9 ms,
            // against ~330 ms of parsing in the same poll.
            const buf = Buffer.alloc(len)
            const { bytesRead } = await fh.read(buf, 0, len, cur)
            if (bytesRead <= 0) {
                break
            }
            budget.left -= bytesRead
            // Take the bounded view ONCE and work only through it. allocUnsafe
            // hands back recycled memory, so bytes past bytesRead are a
            // previous read's leftovers — and they contain newlines often
            // enough to corrupt both the emitted text and the offset. Keeping
            // the bound in the view rather than in a search argument means
            // nothing downstream can quietly drop it.
            const slice = buf.subarray(0, bytesRead)
            const nl = slice.lastIndexOf(0x0A)
            if (nl < 0) {
                if (bytesRead < len || len < chunkBytes) {
                    // Short of a full chunk — the end of the range, or the
                    // budget running out. What is left is a record still being
                    // written; the offset must not pass it, or it is lost once
                    // the rest of the line lands.
                    break
                }
                // A FULL chunk with no newline at all: one line longer than the
                // chunk. Skip it rather than stall here forever.
                cur += bytesRead
                continue
            }
            onChunk(slice.subarray(0, nl).toString('utf8'))
            cur += nl + 1
        }
    } catch {
        /* unreadable or a transient error — keep the progress made, if any, and
           retry on the next interval */
    } finally {
        try {
            await fh?.close()
        } catch { /* already gone */ }
    }
    return cur
}

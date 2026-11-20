import { classifySheetsError, type SheetsFailure } from './sheets-errors';

/**
 * Server-side limit of successful PDF downloads per submission, with no database and no stored PDF.
 *
 * The durable counter is an APPEND-ONLY ledger tab in the same Google spreadsheet (one row per
 * delivered PDF: a timestamp and an opaque keyed hash, no email, name, answers or token). Google
 * Sheets appends are atomic and ordered, which gives a correct count even when requests race:
 *
 *   render PDF -> append one ledger row -> read the key column up to that row
 *   -> the row's ordinal (how many rows carry this key, itself included) decides:
 *        ordinal <= limit  -> deliver the PDF
 *        ordinal  > limit  -> withhold it (429)
 *
 * Every concurrent request gets a distinct row, so exactly the first `limit` of them are delivered
 * no matter how many instances run in parallel. A render that fails never appends, so only
 * deliveries count. The price of render-then-record is that a burst of N parallel requests renders
 * up to N PDFs before the excess is withheld; the per-key lock below removes that waste inside one
 * instance, and once an instance sees a key exhausted it refuses further attempts without
 * touching Google at all.
 *
 * In-memory state here (the lock and the "exhausted" memo) is only an optimization. The ledger is
 * the enforcement, so a cold or different instance still applies the same limit.
 */
export const MAX_DOWNLOADS_PER_SUBMISSION = 5;

/** The two spreadsheet operations the ledger needs. */
export interface LedgerGateway {
  /** Appends one row and returns its 1-based row number. */
  append(row: string[]): Promise<number>;
  /** Values of the key column (B) for rows 1..upToRow. */
  readKeys(upToRow: number): Promise<string[]>;
}

export interface DownloadLedger {
  /**
   * Records one delivered download for `key` and returns its ordinal: how many ledger rows carry
   * this key up to and including the one just written. Throws if the write cannot be confirmed.
   */
  record(key: string, now: Date): Promise<number>;
}

export function createSheetLedger(gateway: LedgerGateway): DownloadLedger {
  return {
    async record(key, now) {
      const row = await gateway.append([now.toISOString(), key]);
      const keys = await gateway.readKeys(row);
      // Never trust an unconfirmed write: if the row is not there with our key, fail closed.
      if (keys[row - 1] !== key) throw new Error('Download ledger write could not be confirmed');
      return keys.filter((value) => value === key).length;
    },
  };
}

export type DeliverOutcome<T> =
  | { kind: 'ok'; value: T; ordinal: number }
  | { kind: 'limit' }
  | { kind: 'unavailable'; reason: SheetsFailure };

export type DownloadLimiter = {
  /**
   * Runs `render` and delivers its result only if this key still has a free slot.
   * `render` errors propagate to the caller untouched (and never use a slot).
   */
  deliver<T>(
    key: string,
    expiresAtMs: number,
    now: Date,
    render: () => Promise<T>,
  ): Promise<DeliverOutcome<T>>;
};

export function createDownloadLimiter(
  ledger: DownloadLedger,
  limit: number = MAX_DOWNLOADS_PER_SUBMISSION,
): DownloadLimiter {
  /** Keys this instance already saw over the limit, until their grant would have expired anyway. */
  const exhausted = new Map<string, number>();
  /** Tail of the per-key queue: same-key requests on this instance run one at a time. */
  const queues = new Map<string, Promise<unknown>>();

  function forget(nowMs: number) {
    for (const [key, until] of exhausted) if (until <= nowMs) exhausted.delete(key);
  }

  async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    queues.set(key, run);
    try {
      return await run;
    } finally {
      if (queues.get(key) === run) queues.delete(key);
    }
  }

  return {
    deliver(key, expiresAtMs, now, render) {
      return serialized(key, async () => {
        forget(now.getTime());
        if (exhausted.has(key)) return { kind: 'limit' } as const;
        const value = await render();
        let ordinal: number;
        try {
          ordinal = await ledger.record(key, now);
        } catch (error) {
          return { kind: 'unavailable', reason: classifySheetsError(error) } as const;
        }
        // Once `limit` rows carry this key the budget is spent for everyone, so every later attempt
        // on this instance is refused from memory: no render and no Google call.
        if (ordinal >= limit) exhausted.set(key, expiresAtMs);
        if (ordinal > limit) return { kind: 'limit' } as const;
        return { kind: 'ok', value, ordinal } as const;
      });
    },
  };
}

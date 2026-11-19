import { createDownloadLimiter, createSheetLedger } from '../../src/lib/download-ledger.ts';

const turn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * In-memory stand-in for the "Control de descargas" tab. Like Google Sheets, an append is atomic
 * (the row number is fixed at the moment of the write) but everything yields to other requests,
 * so concurrent callers genuinely interleave.
 */
export function fakeLedgerGateway({ failAppend = false, failRead = false } = {}) {
  const rows = [['Fecha (UTC)', 'Concesión de descarga']];
  const calls = { append: 0, read: 0 };
  return {
    rows,
    calls,
    failAppend,
    failRead,
    async append(row) {
      calls.append += 1;
      await turn();
      if (this.failAppend) throw new Error('append failed');
      rows.push(row);
      const rowNumber = rows.length;
      await turn();
      return rowNumber;
    },
    async readKeys(upToRow) {
      calls.read += 1;
      await turn();
      if (this.failRead) throw new Error('read failed');
      return rows.slice(0, upToRow).map((row) => row[1]);
    },
  };
}

/** A limiter over a fresh ledger (or over a shared one, to model several function instances). */
export function freshLimiter(gateway = fakeLedgerGateway()) {
  return { gateway, limiter: createDownloadLimiter(createSheetLedger(gateway)) };
}

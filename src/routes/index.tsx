import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { getClient, NETWORK, dropsToXrp, shortHash } from "@/lib/xrpl";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "XRP Ledger Explorer — Live Ledger Stream (Testnet)" },
      {
        name: "description",
        content:
          "Watch the XRP Ledger testnet close ledgers in real time: ledger indexes, hashes, transaction counts, fees, and full transaction contents of each ledger.",
      },
      { property: "og:title", content: "XRP Ledger Explorer — Live Ledger Stream (Testnet)" },
      {
        property: "og:description",
        content: "Live view of every validated ledger on the XRP Ledger testnet.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LedgerPage,
});

interface LedgerSummary {
  index: number;
  hash: string;
  closeTime: string;
  txCount: number;
  totalFees?: string | undefined;
}

interface LedgerTx {
  hash: string;
  type: string;
  account?: string | undefined;
  destination?: string | undefined;
  amount?: string | undefined;
  fee?: string | undefined;
  result?: string | undefined;
}

function amountToText(amount: unknown): string | undefined {
  if (!amount) return undefined;
  if (typeof amount === "string") return `${dropsToXrp(amount)} XRP`;
  if (typeof amount === "object" && amount !== null) {
    const a = amount as { value?: string; currency?: string; issuer?: string };
    return `${a.value} ${a.currency}${a.issuer ? ` (${shortHash(a.issuer)})` : ""}`;
  }
  return undefined;
}

function rippleTimeToDate(t: number): Date {
  return new Date((t + 946684800) * 1000);
}

const LEDGER_WINDOW = 15;

function LedgerPage() {
  const [connected, setConnected] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [ledgers, setLedgers] = useState<LedgerSummary[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [expandedTxs, setExpandedTxs] = useState<LedgerTx[]>([]);
  const [expandedLoading, setExpandedLoading] = useState(false);
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const seenRef = useRef<Set<number>>(new Set());

  const pushLedger = useCallback((entry: LedgerSummary) => {
    if (seenRef.current.has(entry.index)) return;
    seenRef.current.add(entry.index);
    setLedgers((prev) => {
      const next = [entry, ...prev].sort((a, b) => b.index - a.index);
      for (const l of next.slice(LEDGER_WINDOW)) seenRef.current.delete(l.index);
      return next.slice(0, LEDGER_WINDOW);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let sub: (() => void) | undefined;
    (async () => {
      try {
        const client = await getClient();
        if (cancelled) return;
        setConnected(true);

        // Seed with the most recent validated ledgers so the page isn't empty.
        const latest = await client.request({
          command: "ledger",
          ledger_index: "validated",
          transactions: false,
        });
        const latestIndex = latest.result.ledger.ledger_index;
        const batch = await Promise.all(
          Array.from({ length: 6 }, (_, i) => latestIndex - i).map((idx) =>
            client
              .request({ command: "ledger", ledger_index: idx, transactions: false })
              .then((r) => r.result.ledger)
              .catch(() => null),
          ),
        );
        if (cancelled) return;
        for (const l of batch) {
          if (!l) continue;
          pushLedger({
            index: l.ledger_index,
            hash: l.ledger_hash,
            closeTime: rippleTimeToDate(l.close_time).toLocaleTimeString(),
            txCount: l.transaction_count ?? (l as any).transactions?.length ?? 0,
            totalFees: (l as any).total_coins ? undefined : undefined,
          });
        }

        client.on("ledgerClosed", (lc) => {
          pushLedger({
            index: lc.ledger_index,
            hash: lc.ledger_hash,
            closeTime: new Date().toLocaleTimeString(),
            txCount: lc.txn_count,
          });
        });
        await client.request({ command: "subscribe", streams: ["ledger"] });
        sub = () => {
          client.request({ command: "unsubscribe", streams: ["ledger"] }).catch(() => {});
        };
      } catch (e: any) {
        if (!cancelled) setConnError(e?.message ?? "Failed to connect");
      }
    })();
    return () => {
      cancelled = true;
      sub?.();
    };
  }, [pushLedger]);

  const toggleLedger = useCallback(
    async (index: number) => {
      if (expanded === index) {
        setExpanded(null);
        setExpandedTxs([]);
        return;
      }
      setExpanded(index);
      setExpandedTxs([]);
      setExpandedError(null);
      setExpandedLoading(true);
      try {
        const client = await getClient();
        const res = await client.request({
          command: "ledger",
          ledger_index: index,
          transactions: true,
          expand: true,
        });
        const txs = ((res.result.ledger as any).transactions ?? []) as any[];
        setExpandedTxs(
          txs.map((tx) => ({
            hash: tx.hash,
            type: tx.TransactionType,
            account: tx.Account,
            destination: tx.Destination,
            amount: amountToText(tx.Amount),
            fee: tx.Fee ? `${dropsToXrp(tx.Fee)} XRP` : undefined,
            result: typeof tx.metaData === "object" ? tx.metaData?.TransactionResult : undefined,
          })),
        );
      } catch (e: any) {
        setExpandedError(e?.data?.error_message ?? e?.message ?? "Failed to load ledger");
      } finally {
        setExpandedLoading(false);
      }
    },
    [expanded],
  );

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      {connError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {connError}
        </div>
      )}

      <section className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Live ledger stream</h2>
          <p className="text-sm text-muted-foreground">
            Every validated ledger on the {NETWORK}, as it closes. Click a ledger to see its
            transactions.
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
            connected
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-border bg-muted text-muted-foreground"
          }`}
        >
          <span
            className={`size-2 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"}`}
          />
          {connected ? "Streaming" : connError ? "Error" : "Connecting…"}
        </span>
      </section>

      <section className="overflow-hidden rounded-lg border border-border bg-card">
        {ledgers.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">
            {connError ? "Unable to load ledgers." : "Waiting for the first ledger to close…"}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {ledgers.map((l) => (
              <div key={l.index}>
                <button
                  onClick={() => toggleLedger(l.index)}
                  className="flex w-full flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                >
                  <span className="font-mono text-sm font-semibold">
                    #{l.index.toLocaleString()}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {shortHash(l.hash, 10)}
                  </span>
                  <span className="text-xs text-muted-foreground">{l.closeTime}</span>
                  <span className="ml-auto rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">
                    {l.txCount} txn{l.txCount === 1 ? "" : "s"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {expanded === l.index ? "▲" : "▼"}
                  </span>
                </button>
                {expanded === l.index && (
                  <div className="border-t border-border/60 bg-muted/30 px-4 py-3">
                    {expandedLoading ? (
                      <p className="text-sm text-muted-foreground">Loading transactions…</p>
                    ) : expandedError ? (
                      <p className="text-sm text-destructive">{expandedError}</p>
                    ) : expandedTxs.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No transactions in this ledger.
                      </p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead>
                            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                              <th className="py-1.5 pr-4 font-medium">Hash</th>
                              <th className="py-1.5 pr-4 font-medium">Type</th>
                              <th className="py-1.5 pr-4 font-medium">From</th>
                              <th className="py-1.5 pr-4 font-medium">To</th>
                              <th className="py-1.5 pr-4 font-medium">Amount</th>
                              <th className="py-1.5 font-medium">Result</th>
                            </tr>
                          </thead>
                          <tbody>
                            {expandedTxs.map((t) => (
                              <tr key={t.hash} className="border-t border-border/40">
                                <td className="py-2 pr-4 font-mono text-xs" title={t.hash}>
                                  {shortHash(t.hash)}
                                </td>
                                <td className="py-2 pr-4">{t.type}</td>
                                <td className="py-2 pr-4 font-mono text-xs">
                                  {shortHash(t.account)}
                                </td>
                                <td className="py-2 pr-4 font-mono text-xs">
                                  {t.destination ? shortHash(t.destination) : "—"}
                                </td>
                                <td className="py-2 pr-4">{t.amount ?? "—"}</td>
                                <td className="py-2">
                                  <span
                                    className={
                                      t.result === "tesSUCCESS"
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : "text-destructive"
                                    }
                                  >
                                    {t.result ?? "—"}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

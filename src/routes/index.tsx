import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { isValidClassicAddress, isValidXAddress } from "xrpl";
import { getClient, NETWORK, DEFAULT_ADDRESS, dropsToXrp, shortHash } from "@/lib/xrpl";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "XRP Ledger Explorer — Testnet" },
      {
        name: "description",
        content:
          "Live XRP Ledger testnet explorer: account balances, transaction history, and ledger stats over the public testnet.",
      },
      { property: "og:title", content: "XRP Ledger Explorer — Testnet" },
      {
        property: "og:description",
        content: "Look up accounts and transactions on the XRP Ledger testnet.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

interface AccountState {
  address: string;
  balance: string;
  sequence: number;
  ownerCount: number;
  previousTxId: string;
}

interface TxRow {
  hash: string;
  type: string;
  account: string;
  destination?: string;
  amount?: string;
  fee?: string;
  result?: string;
  date?: number;
  ledger?: number;
}

interface LedgerState {
  index: number;
  hash: string;
  closeTime: string;
  txCount: number;
  feeBase: string;
  reserveBase: string;
  reserveInc: string;
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

function Index() {
  const [connected, setConnected] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [ledger, setLedger] = useState<LedgerState | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [txs, setTxs] = useState<TxRow[]>([]);
  const [query, setQuery] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupTx, setLookupTx] = useState<TxRow | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAccount = useCallback(async (address: string) => {
    const client = await getClient();
    setAccountError(null);
    try {
      const info = await client.request({
        command: "account_info",
        account: address,
        ledger_index: "validated",
      });
      const d = info.result.account_data;
      setAccount({
        address,
        balance: dropsToXrp(d.Balance),
        sequence: d.Sequence,
        ownerCount: d.OwnerCount,
        previousTxId: d.PreviousTxnID,
      });
      const hist = await client.request({
        command: "account_tx",
        account: address,
        ledger_index_min: -1,
        ledger_index_max: -1,
        limit: 20,
      });
      const rows: TxRow[] = hist.result.transactions
        .map((w) => {
          const tx = (w as any).tx ?? (w as any).tx_json;
          const meta = (w as any).meta;
          if (!tx) return null;
          return {
            hash: tx.hash,
            type: tx.TransactionType,
            account: tx.Account,
            destination: tx.Destination,
            amount: amountToText(tx.Amount),
            fee: tx.Fee ? `${dropsToXrp(tx.Fee)} XRP` : undefined,
            result: typeof meta === "object" ? meta?.TransactionResult : undefined,
            date: tx.date,
            ledger: tx.ledger_index ?? (w as any).ledger_index,
          } as TxRow;
        })
        .filter(Boolean) as TxRow[];
      setTxs(rows);
    } catch (e: any) {
      setAccount(null);
      setTxs([]);
      setAccountError(e?.data?.error_message ?? e?.message ?? "Account not found (unfunded?)");
    }
  }, []);

  useEffect(() => {
    let sub: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const client = await getClient();
        if (cancelled) return;
        setConnected(true);

        const fee = await client.request({ command: "fee" });
        const ledgerRes = await client.request({
          command: "ledger",
          ledger_index: "validated",
          transactions: false,
        });
        const l = ledgerRes.result.ledger;
        setLedger({
          index: l.ledger_index,
          hash: l.ledger_hash,
          closeTime: rippleTimeToDate(l.close_time).toLocaleTimeString(),
          txCount: (l as any).transactions?.length ?? 0,
          feeBase: dropsToXrp(fee.result.drops.base_fee),
          reserveBase: dropsToXrp(fee.result.drops.reserve_base),
          reserveInc: dropsToXrp(fee.result.drops.reserve_inc),
        });

        if (DEFAULT_ADDRESS) await loadAccount(DEFAULT_ADDRESS);

        client.on("ledgerClosed", (lc) => {
          setLedger((prev) =>
            prev
              ? { ...prev, index: lc.ledger_index, hash: lc.ledger_hash, closeTime: new Date().toLocaleTimeString() }
              : prev,
          );
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
  }, [loadAccount]);

  const onLookup = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setLookupError(null);
    setLookupTx(null);
    setBusy(true);
    try {
      const client = await getClient();
      if (isValidClassicAddress(q) || isValidXAddress(q)) {
        await loadAccount(q);
        return;
      }
      if (/^[0-9A-Fa-f]{64}$/.test(q)) {
        const res = await client.request({ command: "tx", transaction: q });
        const tx = res.result as any;
        setLookupTx({
          hash: tx.hash ?? q,
          type: tx.TransactionType,
          account: tx.Account,
          destination: tx.Destination,
          amount: amountToText(tx.Amount),
          fee: tx.Fee ? `${dropsToXrp(tx.Fee)} XRP` : undefined,
          result: typeof tx.meta === "object" ? tx.meta?.TransactionResult : undefined,
          date: tx.date,
          ledger: tx.ledger_index,
        });
        return;
      }
      setLookupError("Enter a classic address (r…) or a 64-char transaction hash.");
    } catch (e: any) {
      setLookupError(e?.data?.error_message ?? e?.message ?? "Lookup failed");
    } finally {
      setBusy(false);
    }
  }, [query, loadAccount]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5">
          <div>
            <h1 className="text-xl font-bold tracking-tight">XRP Ledger Explorer</h1>
            <p className="text-xs text-muted-foreground capitalize">{NETWORK}</p>
          </div>
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
              connected
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-border bg-muted text-muted-foreground"
            }`}
          >
            <span className={`size-2 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"}`} />
            {connected ? "Connected" : connError ? "Error" : "Connecting…"}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        {connError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {connError}
          </div>
        )}

        {/* Ledger stats */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { label: "Ledger index", value: ledger ? `#${ledger.index.toLocaleString()}` : "—" },
            { label: "Ledger hash", value: ledger ? shortHash(ledger.hash, 6) : "—", mono: true },
            { label: "Last close", value: ledger?.closeTime ?? "—" },
            { label: "Base fee", value: ledger ? `${ledger.feeBase} XRP` : "—" },
            { label: "Base reserve", value: ledger ? `${ledger.reserveBase} XRP` : "—" },
            { label: "Owner reserve", value: ledger ? `${ledger.reserveInc} XRP` : "—" },
          ].map((s) => (
            <div key={s.label} className="rounded-lg border border-border bg-card p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{s.label}</p>
              <p className={`mt-1 truncate text-sm font-semibold ${s.mono ? "font-mono" : ""}`}>{s.value}</p>
            </div>
          ))}
        </section>

        {/* Search */}
        <section className="rounded-lg border border-border bg-card p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onLookup();
            }}
            className="flex gap-2"
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search address (r…) or transaction hash…"
              className="h-10 flex-1 rounded-md border border-input bg-background px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="submit"
              disabled={busy}
              className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? "Searching…" : "Search"}
            </button>
          </form>
          {lookupError && <p className="mt-2 text-sm text-destructive">{lookupError}</p>}
        </section>

        {/* Single tx lookup result */}
        {lookupTx && (
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Transaction {shortHash(lookupTx.hash)}</h2>
            <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <Detail label="Type" value={lookupTx.type} />
              <Detail label="Result" value={lookupTx.result} />
              <Detail label="Account" value={lookupTx.account} mono />
              {lookupTx.destination && <Detail label="Destination" value={lookupTx.destination} mono />}
              {lookupTx.amount && <Detail label="Amount" value={lookupTx.amount} />}
              {lookupTx.fee && <Detail label="Fee" value={lookupTx.fee} />}
              {lookupTx.ledger && <Detail label="Ledger" value={`#${lookupTx.ledger.toLocaleString()}`} />}
              {lookupTx.date && <Detail label="Date" value={rippleTimeToDate(lookupTx.date).toLocaleString()} />}
            </dl>
          </section>
        )}

        {/* Account */}
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Account</h2>
            {account && (
              <button
                onClick={() => loadAccount(account.address)}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
              >
                Refresh
              </button>
            )}
          </div>
          {accountError && <p className="mt-3 text-sm text-destructive">{accountError}</p>}
          {account ? (
            <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <Detail label="Address" value={account.address} mono />
              <Detail label="Balance" value={`${account.balance} XRP`} highlight />
              <Detail label="Sequence" value={account.sequence.toLocaleString()} />
              <Detail label="Owner count" value={String(account.ownerCount)} />
            </dl>
          ) : (
            !accountError && <p className="mt-3 text-sm text-muted-foreground">Loading default account…</p>
          )}
        </section>

        {/* Transactions */}
        {account && (
          <section className="overflow-hidden rounded-lg border border-border bg-card">
            <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Recent transactions</h2>
            {txs.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">No transactions found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Hash</th>
                      <th className="px-4 py-2 font-medium">Type</th>
                      <th className="px-4 py-2 font-medium">Amount</th>
                      <th className="px-4 py-2 font-medium">Counterparty</th>
                      <th className="px-4 py-2 font-medium">Result</th>
                      <th className="px-4 py-2 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {txs.map((t) => (
                      <tr key={t.hash} className="border-b border-border/60 last:border-0 hover:bg-muted/50">
                        <td className="px-4 py-2.5 font-mono text-xs">
                          <button
                            className="text-primary underline-offset-2 hover:underline"
                            onClick={() => {
                              setQuery(t.hash);
                              setLookupTx(null);
                              setLookupError(null);
                            }}
                            title={t.hash}
                          >
                            {shortHash(t.hash)}
                          </button>
                        </td>
                        <td className="px-4 py-2.5">{t.type}</td>
                        <td className="px-4 py-2.5">{t.amount ?? "—"}</td>
                        <td className="px-4 py-2.5 font-mono text-xs">
                          {t.destination
                            ? shortHash(t.destination)
                            : t.account !== account.address
                              ? shortHash(t.account)
                              : "—"}
                        </td>
                        <td className="px-4 py-2.5">
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
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">
                          {t.date ? rippleTimeToDate(t.date).toLocaleString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd
        className={`mt-0.5 break-all ${mono ? "font-mono text-xs" : "text-sm"} ${
          highlight ? "text-base font-bold" : "font-medium"
        }`}
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}

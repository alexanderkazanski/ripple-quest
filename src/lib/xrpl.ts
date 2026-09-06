import { Client } from "xrpl";

let clientPromise: Promise<Client> | null = null;

export function getClient(): Promise<Client> {
  if (typeof window === "undefined") throw new Error("client-only");
  if (!clientPromise) {
    const client = new Client(import.meta.env.VITE_CLIENT as string);
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
}

export const NETWORK = (import.meta.env.VITE_EXPLORER_NETWORK as string) ?? "testnet";
export const DEFAULT_ADDRESS = import.meta.env.VITE_ADDRESS as string;

export function dropsToXrp(drops: string | number): string {
  return (Number(drops) / 1_000_000).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

export function shortHash(h: string, n = 8): string {
  return h.length > n * 2 ? `${h.slice(0, n)}…${h.slice(-n)}` : h;
}

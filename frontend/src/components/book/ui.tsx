"use client";
// Small shared pieces for the order book pages, in the app's existing style (sharp edges, mono labels).
import { ChevronDown } from "lucide-react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { TARGET_CHAIN_ID } from "@/lib/config";
import { OB_PREVIEW } from "@/lib/orderbook/config";
import type { MarketPhase } from "@/lib/orderbook/read";

/** A titled box. `collapsible` makes it a <details> that starts closed unless `open`. */
export function Panel({ title, children, right, collapsible, open, dot }: { title: string; children: React.ReactNode; right?: React.ReactNode; collapsible?: boolean; open?: boolean; dot?: string }) {
  const heading = (
    <h2 className="font-heading font-600 text-sm text-black dark:text-white flex items-center gap-2">
      {dot && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dot }} />}
      {title}
    </h2>
  );
  if (collapsible) {
    return (
      <details open={open} className="group bg-white dark:bg-[#0a0a0a] border border-neutral-200 dark:border-neutral-800">
        <summary className="px-4 py-3 flex items-center justify-between gap-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          {heading}
          <span className="flex items-center gap-3">
            {right}
            <ChevronDown className="w-4 h-4 text-neutral-500 group-open:rotate-180 transition-transform" />
          </span>
        </summary>
        <div className="p-4 border-t border-neutral-200 dark:border-neutral-800">{children}</div>
      </details>
    );
  }
  return (
    <section className="bg-white dark:bg-[#0a0a0a] border border-neutral-200 dark:border-neutral-800">
      <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between gap-3">
        {heading}
        {right}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex border border-neutral-200 dark:border-neutral-800">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`flex-1 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
            value === o.value ? "bg-black dark:bg-white text-white dark:text-black font-600" : "text-neutral-500 hover:text-black dark:hover:text-white"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const Label = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">{children}</span>
);

export function AmountInput({
  label, value, onChange, unit, balance, onMax,
}: { label: string; value: string; onChange: (v: string) => void; unit: string; balance?: string; onMax?: () => void }) {
  return (
    <div className="bg-white dark:bg-[#0a0a0a] p-3 border border-neutral-200 dark:border-neutral-800 focus-within:border-neutral-400 dark:focus-within:border-neutral-600 transition-colors">
      <div className="flex justify-between items-center mb-1 gap-2">
        <Label>{label}</Label>
        {balance !== undefined && (
          <span className="font-mono text-[10px] text-neutral-500">
            Bal: <span className="text-black dark:text-neutral-300 font-bold">{balance}</span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <input
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="0"
          aria-label={label}
          className="w-full min-w-0 bg-transparent outline-none font-heading font-bold text-2xl text-black dark:text-white placeholder:text-neutral-300 dark:placeholder:text-neutral-800"
        />
        <span className="font-mono text-xs text-neutral-500 flex-shrink-0">{unit}</span>
        {onMax && (
          <button type="button" onClick={onMax} className="px-2.5 py-1 bg-neutral-100 dark:bg-neutral-900 font-mono text-[9px] font-bold uppercase text-neutral-500 hover:text-black dark:hover:text-white transition-colors flex-shrink-0">
            Max
          </button>
        )}
      </div>
    </div>
  );
}

/** The main action button, or Connect / Switch network when the wallet isn't ready. */
export function ActionButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { openConnectModal } = useConnectModal();
  const base = "w-full py-3 font-heading font-bold text-sm transition-opacity disabled:opacity-40 disabled:cursor-not-allowed";
  if (!isConnected) {
    return <button type="button" onClick={() => openConnectModal?.()} className={`${base} bg-black dark:bg-white text-white dark:text-black hover:opacity-90`}>Connect wallet</button>;
  }
  if (chainId !== TARGET_CHAIN_ID) {
    return <button type="button" onClick={() => switchChain({ chainId: TARGET_CHAIN_ID })} className={`${base} bg-amber-500 text-black hover:opacity-90`}>Switch to Robinhood Chain</button>;
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} bg-[#00ff87] text-black hover:opacity-90`}>
      {children}
    </button>
  );
}

const PHASE: Record<MarketPhase, { text: string; cls: string }> = {
  trading: { text: "Trading", cls: "border-[#00ff87]/40 text-[#00cc6a] dark:text-[#00ff87] bg-[#00ff87]/10" },
  ended: { text: "Awaiting outcome", cls: "border-amber-500/40 text-amber-600 dark:text-amber-400 bg-amber-500/10" },
  pending: { text: "Outcome posted", cls: "border-sky-500/40 text-sky-600 dark:text-sky-400 bg-sky-500/10" },
  disputed: { text: "Disputed", cls: "border-red-500/40 text-red-600 dark:text-red-400 bg-red-500/10" },
  final: { text: "Final", cls: "border-neutral-400/40 text-neutral-600 dark:text-neutral-300 bg-neutral-500/10" },
};

export function PhasePill({ phase }: { phase: MarketPhase }) {
  const p = PHASE[phase];
  return <span className={`inline-block px-2 py-0.5 border font-mono text-[10px] uppercase tracking-widest ${p.cls}`}>{p.text}</span>;
}

/** Colours for outcome rows, in order. */
export const OUTCOME_COLORS = ["#00ff87", "#ff4d6d", "#4dabf7", "#ffd43b", "#b197fc", "#ff922b", "#63e6be", "#f783ac", "#a9e34b", "#ced4da"];

export function utc(sec: number): string {
  if (!sec) return "—";
  const d = new Date(sec * 1000);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${date}, ${time} UTC`;
}

export function countdown(toSec: number, nowSec: number): string {
  const s = Math.max(0, toSec - nowSec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export function parseAmount(v: string): bigint {
  if (!v || !/^\d*\.?\d*$/.test(v) || v === ".") return BigInt(0);
  const [w, f = ""] = v.split(".");
  return BigInt(w || "0") * BigInt(1_000_000) + BigInt((f + "000000").slice(0, 6));
}

export const toInput = (raw: bigint): string => {
  const s = (Number(raw) / 1e6).toFixed(6);
  return s.replace(/\.?0+$/, "");
};

/** Shown on every order book page until the contracts are deployed on Robinhood Chain. */
export function PreviewNotice() {
  if (!OB_PREVIEW) return null;
  return (
    <p role="note" className="border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 font-mono text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed">
      <span className="font-bold uppercase tracking-wider">Test mode.</span> This app is pointed at a test chain or test contracts (NEXT_PUBLIC_OB_LIVE=0). Don&apos;t send real funds to anything on these pages.
    </p>
  );
}

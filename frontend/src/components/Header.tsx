"use client";
import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Moon, Sun } from "lucide-react";
import { useDarkMode } from "@/components/Providers";

export default function Header() {
  const { isDark, toggleDark } = useDarkMode();
  return (
    <header className="flex items-center justify-between gap-4 px-4 sm:px-6 h-14 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black">
      <nav className="flex items-center gap-5">
        <Link href="/book" className="flex items-center gap-2 font-heading font-bold text-black dark:text-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/dither-logo.svg" alt="" className="w-6 h-6" />
          PFWA
        </Link>
        <Link href="/book" className="font-mono text-xs text-neutral-500 hover:text-black dark:hover:text-white">Markets</Link>
        <Link href="/book/create" className="font-mono text-xs text-neutral-500 hover:text-black dark:hover:text-white">Create</Link>
      </nav>
      <div className="flex items-center gap-3">
        <button type="button" onClick={toggleDark} aria-label={isDark ? "Light mode" : "Dark mode"} className="text-neutral-500 hover:text-black dark:hover:text-white">
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
        <ConnectButton chainStatus="icon" showBalance={false} accountStatus="address" />
      </div>
    </header>
  );
}

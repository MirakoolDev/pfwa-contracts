"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { connectorsForWallets, darkTheme, lightTheme, RainbowKitProvider, type Wallet } from "@rainbow-me/rainbowkit";
import { coinbaseWallet, injectedWallet, metaMaskWallet, rabbyWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, createConnector, http, mock, WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";
import { BROWSER_RPC_URL, robinhoodChain } from "@/lib/config";

// Local fork testing: an anvil account (anvil's dev accounts are unlocked), shown as "Fork test wallet" in the connect
// modal. Set NEXT_PUBLIC_DEV_WALLET and NEXT_PUBLIC_ROBINHOOD_RPC_URL=http://127.0.0.1:8545 (README). Development only.
const DEV_WALLET =
  process.env.NODE_ENV !== "production" && /^0x[0-9a-fA-F]{40}$/.test(process.env.NEXT_PUBLIC_DEV_WALLET || "")
    ? (process.env.NEXT_PUBLIC_DEV_WALLET as `0x${string}`)
    : undefined;

const devForkWallet = (): Wallet => ({
  id: "dev-fork",
  name: "Fork test wallet",
  iconUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 28 28'%3E%3Crect width='28' height='28' fill='%2300ff87'/%3E%3Ctext x='14' y='19' font-size='12' text-anchor='middle' font-family='monospace'%3EDEV%3C/text%3E%3C/svg%3E",
  iconBackground: "#00ff87",
  createConnector: (details) =>
    createConnector((config) => ({ ...mock({ accounts: [DEV_WALLET!], features: { reconnect: true } })(config), ...details })),
});

// WalletConnect needs a project id (cloud.reown.com). Without one, browser wallets still work.
const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

const connectors = connectorsForWallets(
  [
    { groupName: "Recommended", wallets: [injectedWallet, metaMaskWallet, rabbyWallet, coinbaseWallet, ...(WC_PROJECT_ID ? [walletConnectWallet] : [])] },
    ...(DEV_WALLET ? [{ groupName: "Local fork", wallets: [devForkWallet] }] : []),
  ],
  { appName: "PFWA order book markets", projectId: WC_PROJECT_ID || "no-walletconnect" },
);

const config = createConfig({
  connectors,
  chains: [robinhoodChain],
  transports: { [robinhoodChain.id]: http(BROWSER_RPC_URL) },
  ssr: true,
});

type DarkModeContextType = { isDark: boolean; toggleDark: () => void };
export const DarkModeContext = createContext<DarkModeContextType>({ isDark: true, toggleDark: () => {} });
export const useDarkMode = () => useContext(DarkModeContext);

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, gcTime: 300_000, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: 1 } },
  }));
  const [isDark, setIsDark] = useState(true);
  useEffect(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem("pfwa-dark"); } catch { /* storage blocked */ }
    const dark = stored !== "false";
    setIsDark(dark);
    document.documentElement.classList.toggle("dark", dark);
  }, []);
  const toggleDark = () => setIsDark((prev) => {
    const next = !prev;
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("pfwa-dark", String(next)); } catch { /* storage blocked */ }
    return next;
  });
  const theme = isDark
    ? darkTheme({ accentColor: "#00ff87", accentColorForeground: "black", borderRadius: "none", fontStack: "system" })
    : lightTheme({ accentColor: "#000000", accentColorForeground: "white", borderRadius: "none", fontStack: "system" });
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <DarkModeContext.Provider value={{ isDark, toggleDark }}>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider theme={theme} initialChain={robinhoodChain}>
            {mounted && children}
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </DarkModeContext.Provider>
  );
}

"use client";

import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

import { FC, ReactNode } from "react";
import { WalletProvider } from "@/components/providers/WalletProvider";
import { ToastProvider } from "@/hooks/useToast";
import { ToastContainer } from "@/components/ui/Toast";
import { WebMcpTools } from "@/components/webmcp/WebMcpTools";

export const Providers: FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <WalletProvider>
      <ToastProvider>
        {children}
        <ToastContainer />
        <WebMcpTools />
      </ToastProvider>
    </WalletProvider>
  );
};

"use client";

/**
 * Mounts the WebMCP "site tools" registration (lib/webmcp.ts).
 *
 * Renders nothing and changes no UI behavior: on mount it registers the
 * Percolator read-only data tools with `document.modelContext` when the
 * browser supports WebMCP, and silently does nothing otherwise.
 */

import { useEffect } from "react";
import { registerPercolatorWebMcpTools } from "@/lib/webmcp";

export function WebMcpTools() {
  useEffect(() => {
    registerPercolatorWebMcpTools();
  }, []);
  return null;
}

"use client";

import { useId } from "react";

interface MiniSparklineProps {
  /** Real price points only (oldest → newest), accumulated from live polls. */
  points: number[];
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Sparkline of REAL observed prices. Renders nothing until at least
 * two real points exist — never a generated/synthetic series.
 */
export function MiniSparkline({
  points,
  width = 340,
  height = 120,
  className = "",
}: MiniSparklineProps) {
  const gradientId = useId();
  const fillId = `sparkFill-${gradientId.replace(/[^a-zA-Z0-9]/g, "")}`;

  if (points.length < 2) {
    return (
      <div
        className={`flex items-center justify-center text-[11px] text-[var(--text-muted)] ${className}`}
        style={{ height }}
      >
        collecting live prices…
      </div>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const padY = 8;
  const usableH = height - padY * 2;

  const coords = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = padY + usableH - ((p - min) / range) * usableH;
      return `${x},${y}`;
    })
    .join(" ");

  const areaPoints = `0,${height} ${coords} ${width},${height}`;
  const rising = points[points.length - 1] >= points[0];
  const stroke = rising ? "var(--long)" : "var(--short)";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`w-full ${className}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#14F195" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#14F195" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill={`url(#${fillId})`} />
      <polyline
        points={coords}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

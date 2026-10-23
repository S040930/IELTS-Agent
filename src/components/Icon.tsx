import type { ReactNode } from "react";

type IconName = "home" | "headphones" | "book" | "file" | "repeat" | "chart" | "settings" | "chat" | "check" | "arrow" | "lock" | "unlock" | "time" | "menu" | "upload" | "refresh" | "close" | "send" | "sparkle" | "play" | "volume" | "circle-check" | "search" | "filter" | "caret" | "gauge" | "wifi" | "note";

const paths: Record<IconName, ReactNode> = {
  home: <><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/></>,
  headphones: <><path d="M3 14v-3a9 9 0 0 1 18 0v3"/><path d="M5 13H3v6a2 2 0 0 0 2 2h2v-6H5zM19 13h2v6a2 2 0 0 1-2 2h-2v-6h2z"/></>,
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22z"/><path d="M4 5.5V19a2 2 0 0 0 2 2h14"/></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></>,
  repeat: <><path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></>,
  chart: <><path d="M4 19V5M4 19h17"/><path d="M8 15v-4M12 15V8M16 15V5M20 15v-6"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/></>,
  chat: <><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
  lock: <><rect width="15" height="11" x="4.5" y="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  unlock: <><rect width="15" height="11" x="4.5" y="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.7-1.5"/></>,
  time: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  menu: <><path d="M4 6h16M4 12h16M4 18h16"/></>,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.5-2L20 12M4 12l2.9 4a7 7 0 0 0 11.5-2"/></>,
  close: <><path d="m18 6-12 12M6 6l12 12"/></>,
  send: <><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></>,
  sparkle: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/><path d="m19 14 1.2 2.8L23 18l-2.8 1.2L19 22l-1.2-2.8L15 18l2.8-1.2z"/></>,
  play: <path d="m8 5 12 7-12 7z"/>,
  volume: <><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></>,
  "circle-check": <><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></>,
  filter: <path d="M3 5h18l-7 8v5.5l-4 2V13z"/>,
  caret: <path d="m6 9 6 6 6-6"/>,
  gauge: <><path d="M5 18a7 7 0 0 1 14 0"/><path d="m12 18 3.2-5.2"/><circle cx="12" cy="18" r="1.1"/></>,
  wifi: <><path d="M2 8.8a15 15 0 0 1 20 0"/><path d="M5 12a10.5 10.5 0 0 1 14 0"/><path d="M8.5 15.5a5.4 5.4 0 0 1 7 0"/><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/></>,
  note: <><path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2h-5z"/><path d="M14 21v-7h7M8 8h8M8 12h4"/><path d="m14 17 5-5"/></>,
};

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export type { IconName };

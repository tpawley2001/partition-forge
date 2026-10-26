import React from 'react';

const s = (p: React.SVGProps<SVGSVGElement>) => ({
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const, ...p,
});

export const IconDisk = (p: React.SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /><path d="M17.7 17.7 20 20" /></svg>
);
export const IconRefresh = (p: React.SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 4v5h-5" /></svg>
);
export const IconShield = (p: React.SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M12 3 5 6v5c0 4.4 2.9 8.4 7 9.6 4.1-1.2 7-5.2 7-9.6V6l-7-3Z" /></svg>
);
export const IconWarn = (p: React.SVGProps<SVGSVGElement>) => (
  <svg {...s({ width: 14, height: 14, ...p })}><path d="M12 4 2.5 20h19L12 4Z" /><path d="M12 10v4" /><path d="M12 17.5v.01" /></svg>
);
export const IconInfo = (p: React.SVGProps<SVGSVGElement>) => (
  <svg {...s({ width: 14, height: 14, ...p })}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8v.01" /></svg>
);
export const IconTrash = (p: React.SVGProps<SVGSVGElement>) => (
  <svg {...s({ width: 14, height: 14, ...p })}><path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6 7l1 13h10l1-13" /></svg>
);
export const IconPlay = (p: React.SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M7 4.5 19 12 7 19.5v-15Z" fill="currentColor" /></svg>
);
export const IconRestart = (p: React.SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M12 3v9" /><path d="M6.5 6.5a8 8 0 1 0 11 0" /></svg>
);

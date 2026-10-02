// lib/util.js — small formatting/parsing helpers (pure, no SDK imports).

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

// Convert Persian/Arabic-Indic digits to ASCII digits.
export function normDigits(s) {
  return String(s)
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
}

// Parse a user-typed number (accepts Persian digits, thousands separators, ٫ decimal).
export function toNum(s) {
  const t = normDigits(s)
    .replace(/[,،٬]/g, '') // ASCII comma, Arabic comma, Arabic thousands separator
    .replace(/٫/g, '.') // Arabic decimal separator
    .trim();
  if (!/^-?[0-9]*\.?[0-9]+$/.test(t) || t === '' || t === '-') return NaN;
  return parseFloat(t);
}

export function fmtPrice(p) {
  if (p == null || !isFinite(p)) return '—';
  const a = Math.abs(p);
  if (a >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (a >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a >= 0.01) return p.toLocaleString('en-US', { maximumFractionDigits: 4 });
  // very small prices: use significant digits, guarding against exponent notation
  let s = p.toPrecision(4);
  if (/[eE]/.test(s)) s = p.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

export function fmtUsd(v) {
  if (v == null || !isFinite(v)) return '—';
  const s = fmtPrice(Math.abs(v));
  return v < 0 ? '-' + s : s;
}

export function fmtPct(v) {
  if (v == null || !isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

export function fmtQty(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return v.toPrecision(5);
}

// Tehran time (UTC+3:30, no DST) as DD/MM HH:MM — avoids any ICU/timezone data dependency.
export function tTime(ms) {
  const d = new Date(ms + 3.5 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// Price of the last (top) grid level for a grid's parameters.
export function topPrice(g) {
  const n = g.gridCount - 1;
  return g.lowerPrice * (1 + (n * g.intervalPct) / 100);
}

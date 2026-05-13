import { formatTriggers } from "./triggers/format"; export { formatTriggers };
export function parseWords(text:string): string[] { return String(text ?? "").trim().split(/\s+/).filter(Boolean); }
export function asNumber(value:string, name:string): number { const n=Number(value); if(!Number.isFinite(n)||n<=0) throw new Error(`${name} must be a positive number`); return n; }
export function escapeLong(text:string): string { return text.length > 3900 ? text.slice(0,3900) + "…" : text; }

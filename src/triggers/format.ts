import { deriveTriggerDirection, formatUsd, priceTargetForTrigger, TriggerOrder } from "./types";
import { PositionStore } from "./position-store";

function dateLabel(ts?: number): string { return ts ? new Date(ts).toISOString() : ""; }
function compact(value: unknown): string { return value === undefined || value === null || value === "" ? "" : String(value); }

function orderTypeText(order: any): string {
  const type = String(order.orderType ?? order.ordType ?? order.type ?? "");
  if (type === "1") return "MARKET";
  if (type === "2") return "LIMIT";
  return type || "-";
}

function orderStatusText(order: any): string {
  const status = String(order.ordStatus ?? order.status ?? "");
  if (status === "0") return "NEW";
  if (status === "1") return "PARTIAL";
  if (status === "2") return "FILLED";
  if (status === "4") return "CANCELED";
  if (status === "8") return "REJECTED";
  return status || "-";
}

function formatOrderLine(order: any, index: number): string {
  const qty = order.cumQty && Number(order.cumQty) > 0 ? order.cumQty : order.quantity ?? "-";
  const price = order.fillPrice ?? order.avgPx ?? order.lastPx ?? order.price ?? "-";
  const id = order.orderId ?? order.clientOrderId ?? "-";

  return `${index}. ${order.symbol} ${order.side} ${orderTypeText(order)} ${orderStatusText(order)} qty=${qty} price=${price} id=${id}`;
}

export function formatTrigger(trigger: TriggerOrder): string {
  const qty = trigger.closePosition
    ? "close-position"
    : trigger.closePercentage !== undefined
      ? `${trigger.closePercentage}% position`
      : compact(trigger.quantity);
  const pieces = [
    trigger.id,
    trigger.status,
    trigger.kind,
    trigger.symbol,
    trigger.side,
  ];

  const dir = deriveTriggerDirection(trigger);
  const target = priceTargetForTrigger(trigger);
  const details = [
    target ? `target=${target}` : "",
    trigger.triggerPrice ? `trigger=${trigger.triggerPrice}` : "",
    trigger.limitPrice ? `limit=${trigger.limitPrice}` : "",
    trigger.lowerPrice ? `lower=${trigger.lowerPrice}` : "",
    trigger.upperPrice ? `upper=${trigger.upperPrice}` : "",
    trigger.priceBandMode ? `band=${trigger.priceBandMode}` : "",
    trigger.trailValue ? `trail=${trigger.trailValue}${trigger.trailMode === "PERCENT" ? "%" : ""}` : "",
    trigger.currentStopPrice ? `stop=${trigger.currentStopPrice}` : "",
    trigger.highWaterMark ? `high=${trigger.highWaterMark}` : "",
    trigger.lowWaterMark ? `low=${trigger.lowWaterMark}` : "",
    trigger.breakEvenArmed ? "armed=true" : "",
    trigger.meta?.bracketAwaitingPosition ? "bracket=awaiting-position" : "",
    trigger.meta?.bracketChildrenCreated ? "bracket=exits-created" : "",
    trigger.activationValue ? `after=${trigger.activationValue}${trigger.activationMode === "PERCENT" ? "%" : ""}` : "",
    trigger.lockValue !== undefined ? `lock=${trigger.lockValue}${trigger.lockMode === "PERCENT" ? "%" : ""}` : "",
    trigger.triggerAt ? `at=${dateLabel(trigger.triggerAt)}` : "",
    trigger.cancelTriggerId ? `cancel=${trigger.cancelTriggerId}` : "",
    trigger.cancelGroupId ? `cancelGroup=${trigger.cancelGroupId}` : "",
    trigger.riskMetric ? `risk=${trigger.riskMetric}:${trigger.riskThreshold}` : "",
    trigger.riskAction ? `action=${trigger.riskAction}` : "",
    dir ? `direction=${dir}` : "",
    qty ? `qty=${qty}` : "",
    trigger.ocoGroupId ? `oco=${trigger.ocoGroupId}` : "",
    trigger.lastCheckedPrice ? `checked=${trigger.lastCheckedPrice}` : "",
    trigger.clientOrderId || trigger.orderId ? `order=${trigger.clientOrderId ?? trigger.orderId}` : "",
    trigger.error ? `error=${trigger.error}` : "",
  ].filter(Boolean);

  return `${pieces.join(" ")} ${details.join(" ")}`.trim();
}

export function formatTriggers(triggers: TriggerOrder[]): string {
  return triggers.length ? triggers.map(formatTrigger).join("\n") : "No triggers found.";
}

export function formatRisk(positions: PositionStore): string {
  return `Cached gross position risk: ${formatUsd(positions.totalRiskUsd())}\n${positions.describe()}`;
}

export function parsePage(words: string[]): number {
  const raw = words[0];
  if (!raw) return 1;

  const page = Number(raw);
  if (!Number.isFinite(page) || page <= 0) {
    throw new Error("Page must be a positive number");
  }

  return Math.floor(page);
}

export function formatOrderPage(title: string, page: any, commandName: string, syncing = false): string {
  const lines: string[] = [];

  if (!page.items.length) {
    lines.push(`No ${title.toLowerCase()} cached yet.`);
    lines.push("Account/order watcher started. Try again in a few seconds.");

    if (syncing) {
      lines.push("Order history is still syncing.");
    }

    return lines.join("\n");
  }

  const startIndex = (page.page - 1) * page.pageSize;

  lines.push(`${title} page ${page.page}/${page.totalPages} total=${page.total}`);
  lines.push("");

  for (let i = 0; i < page.items.length; i++) {
    lines.push(formatOrderLine(page.items[i], startIndex + i + 1));
  }

  if (page.page < page.totalPages) {
    lines.push("");
    lines.push(`Use /${commandName} ${page.page + 1} for next page.`);
  }

  if (syncing) {
    lines.push("");
    lines.push("Order history is still syncing. Run this command again in a few seconds for latest results.");
  }

  return lines.join("\n");
}
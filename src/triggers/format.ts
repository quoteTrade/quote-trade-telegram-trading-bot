import { deriveTriggerDirection, formatUsd, priceTargetForTrigger, TriggerOrder } from "./types";
import { PositionStore } from "./position-store";

function dateLabel(ts?: number): string { return ts ? new Date(ts).toISOString() : ""; }
function compact(value: unknown): string { return value === undefined || value === null || value === "" ? "" : String(value); }

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
    trigger.triggerSource ? `source=${trigger.triggerSource}` : "",
    qty ? `qty=${qty}` : "",
    trigger.ocoGroupId ? `oco=${trigger.ocoGroupId}` : "",
    trigger.lastPrice ? `last=${trigger.lastPrice}` : "",
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

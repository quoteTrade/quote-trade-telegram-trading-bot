import type { PositionStore } from "./triggers/position-store";

const ACCOUNT_FIELDS = [
  ["totalWalletBalance", "Wallet balance"],
  ["totalMarginBalance", "Margin balance"],
  ["totalInitialMargin", "Initial margin"],
  ["totalMaintMargin", "Maintenance margin"],
  ["totalOpenOrderInitialMargin", "Open-order initial margin"],
  ["totalPositionInitialMargin", "Position initial margin"],
  ["totalUnrealizedProfit", "Unrealized P/L"],
  ["maxWithdrawAmount", "Max withdrawal"],
] as const;

const STREAM_FIELDS = [
  ["lr", "Leverage ratio"],
  ["mv", "Margin value USD"],
  ["mmv", "Margin M value USD"],
  ["mrv", "Required margin value USD"],
  ["um", "Marginable value USD"],
  ["oo", "Open orders value USD"],
  ["oor", "Open orders required value USD"],
  ["pv", "Position value USD"],
  ["up", "Unrealized P/L USD"],
  ["uv", "Risk event uv USD"],
] as const;

function finiteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function money(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export class AccountRiskStore {
  private account?: Record<string, unknown>;
  private accountAt = 0;
  private risk?: Record<string, unknown>;
  private riskAt = 0;

  updateAccount(payload: unknown): void {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Quote.Trade returned an unrecognized account response");
    }
    const account = payload as Record<string, unknown>;
    if (account.error || (account.message && account.success === false)) {
      throw new Error(String(account.error ?? account.message));
    }
    if (account.canTrade === undefined && ACCOUNT_FIELDS.every(([key]) => account[key] === undefined)) {
      throw new Error("Quote.Trade returned an unrecognized account response");
    }
    this.account = account;
    this.accountAt = Date.now();
  }

  updateRisk(payload: unknown): void {
    if (!payload || typeof payload !== "object" || (payload as any).e !== "RISK_UPDATE") return;
    const risk = payload as Record<string, unknown>;
    const eventAt = finiteNumber(risk.E);
    if (eventAt === undefined || eventAt <= 0 || eventAt > Date.now() + 30_000) return;
    if (eventAt < this.riskAt) return;
    this.risk = risk;
    this.riskAt = eventAt;
  }

  isAccountFresh(maxAgeMs = 60_000): boolean {
    const updateTime = finiteNumber(this.account?.updateTime);
    const timestamp = updateTime && updateTime > 0 ? updateTime : this.accountAt;
    return !!this.account && timestamp > 0 && Date.now() - timestamp <= maxAgeMs && timestamp <= Date.now() + 30_000;
  }

  canTrade(): boolean {
    return this.isAccountFresh() && this.account?.canTrade === true;
  }

  buyingPowerUsd(maxAgeMs = 60_000): number | undefined {
    if (!this.risk || Date.now() - this.riskAt > maxAgeMs || !this.canTrade()) return undefined;
    const value = finiteNumber(this.risk.bpe);
    return value !== undefined && value >= 0 ? value : undefined;
  }

  format(positions: PositionStore): string {
    const lines = ["Quote.Trade account risk and margin"];
    if (this.account) {
      lines.push(
        `Account snapshot: ${this.isAccountFresh() ? "fresh" : "stale"} (${new Date(this.accountAt).toISOString()})`,
      );
      lines.push(`Trading permission: ${this.account.canTrade === true ? "enabled" : "disabled or unavailable"}`);
      for (const [key, label] of ACCOUNT_FIELDS) {
        const value = finiteNumber(this.account[key]);
        if (value !== undefined) lines.push(`${label}: ${money(value)}`);
      }
    } else {
      lines.push("Account margin snapshot: unavailable");
    }

    if (this.risk) {
      const eventBuyingPower = finiteNumber(this.risk.bpe);
      if (eventBuyingPower !== undefined)
        lines.push(`Risk event buying power estimate: ${money(eventBuyingPower)} USD`);
      lines.push(
        `Risk update: ${Date.now() - this.riskAt <= 60_000 ? "fresh" : "stale"} (${new Date(this.riskAt).toISOString()})`,
      );
      for (const [key, label] of STREAM_FIELDS) {
        const value = finiteNumber(this.risk[key]);
        if (value !== undefined) lines.push(`${label}: ${key === "lr" ? value : money(value)}`);
      }
    } else {
      lines.push("Private risk update: unavailable");
    }

    const buyingPower = this.buyingPowerUsd();
    if (buyingPower === undefined) {
      lines.push("Buying power for new orders: unavailable until a fresh private RISK_UPDATE arrives.");
    } else {
      lines.push(`Estimated buying power for new orders: ${money(buyingPower)} USD`);
      lines.push(
        `Illustrative order values: 25% ${money(buyingPower * 0.25)}, 50% ${money(buyingPower * 0.5)}, 75% ${money(buyingPower * 0.75)}.`,
      );
      lines.push(
        "These are USD order values, not asset quantities; check the live quote and exchange limits before ordering.",
      );
    }
    lines.push(`Cached gross position exposure: ${money(positions.totalRiskUsd())}`);
    lines.push(positions.describe());
    return lines.join("\n");
  }
}

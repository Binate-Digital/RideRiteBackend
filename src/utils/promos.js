import { PromoCode } from "../models/PromoCode.js";

function promoLabel(promo) {
  return promo.percentOff
    ? `${promo.percentOff}% off`
    : `$${((promo.amountOffCents ?? 0) / 100).toFixed(2)} off`;
}

/** Discount in cents a promo gives on a subtotal (flat amount wins over percent). */
export function discountFor(promo, subtotalCents) {
  if (promo.amountOffCents && promo.amountOffCents > 0) return promo.amountOffCents;
  if (promo.percentOff && promo.percentOff > 0) {
    return Math.round((subtotalCents * promo.percentOff) / 100);
  }
  return 0;
}

/**
 * Look up and validate a promo code.
 * Returns { ok, code, label, promo?, error? } — never throws for a bad code.
 */
export async function resolvePromo(rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { ok: false, code, label: "", error: "Enter a promo code" };

  const promo = await PromoCode.findOne({ code });
  if (!promo) return { ok: false, code, label: "", error: "Promo code not found" };
  if (!promo.active) return { ok: false, code, label: "", error: "Promo is not active" };
  if (promo.expiresAt && promo.expiresAt.getTime() < Date.now()) {
    return { ok: false, code, label: "", error: "Promo has expired" };
  }
  if (promo.maxUses != null && promo.uses >= promo.maxUses) {
    return { ok: false, code, label: "", error: "Promo limit reached" };
  }
  return { ok: true, code, label: promoLabel(promo), promo };
}

/** Atomically count one redemption; false when the usage cap was hit meanwhile. */
export async function redeemPromo(promo) {
  const filter = { _id: promo._id, active: true };
  if (promo.maxUses != null) filter.uses = { $lt: promo.maxUses };
  const updated = await PromoCode.findOneAndUpdate(filter, { $inc: { uses: 1 } });
  return Boolean(updated);
}

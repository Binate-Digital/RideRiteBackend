import { DriverBonus } from "../models/DriverBonus.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { SAFE_SCORE_RULES, bonusThresholds, monthKeyOf, refreshMonth } from "../utils/bonus.js";

/**
 * GET /api/driver/bonus/me — this month's live metrics (recomputed from trips on every view),
 * the thresholds they are judged against, and the driver's past months.
 */
export const getMine = asyncHandler(async (req, res) => {
  const bonus = await refreshMonth(req.user._id, monthKeyOf());
  const history = await DriverBonus.find({ userId: req.user._id, monthKey: { $ne: bonus.monthKey } })
    .sort({ monthKey: -1 })
    .limit(12);
  res.json({
    ok: true,
    bonus: bonus.toSafeJSON(),
    thresholds: bonusThresholds(),
    safeScoreRules: SAFE_SCORE_RULES,
    history: history.map((b) => b.toSafeJSON()),
  });
});

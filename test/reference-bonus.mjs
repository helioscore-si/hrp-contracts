// Offline reference model only. No blockchain calls, keys, signatures or deploy code.
// Based on the 2026-11-08 DOCX. Allocation and Round 3 were approved on 2026-11-10; launch details remain pending.
const BPS = 10_000n;
const THRESHOLD = 10n;
const LOT_HRP = 100n;
const LOT_USDT = 100n;
function amount(value, label) {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${label}: non-negative bigint required`);
  return value;
}
export function quoteBonus(previousPaidLots, newPaidLots, rateBps) {
  amount(previousPaidLots, 'previousPaidLots');
  amount(newPaidLots, 'newPaidLots');
  amount(rateBps, 'rateBps');
  if (newPaidLots === 0n || rateBps > BPS) throw new RangeError('Invalid purchase or rate');
  const totalPaidLots = previousPaidLots + newPaidLots;
  const eligibleLots = totalPaidLots < THRESHOLD ? 0n
    : previousPaidLots < THRESHOLD ? totalPaidLots : newPaidLots;
  const numerator = eligibleLots * LOT_HRP * rateBps;
  // Approved draft rates give whole HRP; do not silently round a new rate.
  if (numerator % BPS !== 0n) throw new RangeError('Fractional HRP rule is not approved');
  const paidHRP = newPaidLots * LOT_HRP;
  const bonusHRP = numerator / BPS;
  return { totalPaidLots, paidUSDT: newPaidLots * LOT_USDT, paidHRP, bonusHRP,
    deliveredHRP: paidHRP + bonusHRP };
}
export function quoteWithinInventory({previousPaidLots, newPaidLots, rateBps,
  inventoryHRP, paidRoundCapHRP, alreadyPaidRoundHRP}) {
  amount(inventoryHRP, 'inventoryHRP');
  amount(paidRoundCapHRP, 'paidRoundCapHRP');
  amount(alreadyPaidRoundHRP, 'alreadyPaidRoundHRP');
  const quote = quoteBonus(previousPaidLots, newPaidLots, rateBps);
  if (alreadyPaidRoundHRP + quote.paidHRP > paidRoundCapHRP) throw new RangeError('ROUND_CAP');
  if (quote.deliveredHRP > inventoryHRP) throw new RangeError('INSUFFICIENT_HRP');
  return quote;
}
export function inventoryRequirement(round3PaidHRP = 0n) {
  amount(round3PaidHRP, 'round3PaidHRP');
  if (round3PaidHRP % LOT_HRP !== 0n) throw new RangeError('Round 3 cap must be whole lots');
  const caps = [200_000n, 600_000n, 800_000n, 1_000_000n];
  const rates = [10_000n, 6_000n, 4_000n, 2_000n];
  const earlyPaidHRP = caps.reduce((a,b) => a+b, 0n);
  const earlyBonusHRP = caps.reduce((a,b,i) => a+b*rates[i]/BPS, 0n);
  const round3BonusHRP = round3PaidHRP/10n;
  const requiredInventoryHRP = earlyPaidHRP + earlyBonusHRP + round3PaidHRP + round3BonusHRP;
  return {earlyPaidHRP, earlyBonusHRP, round3BonusHRP, requiredInventoryHRP,
    shortageAgainstDocInventoryHRP: requiredInventoryHRP - 3_600_000n};
}
export function planningBlockers(config) {
  const missing = ['name','totalSupplyHRP','tokenDecimals','paymentTokenAddress',
    'paymentTokenDecimals','treasuryAddress','administratorAddress','saleInventoryHRP',
    'contestReserveHRP','companyAllocationHRP','saleCloseUtc','legacyBalancesPolicy']
    .filter(k => config[k] === null || config[k] === undefined || config[k] === '');
  for (const key of ['bonusRuleApproved','allocationApproved','holdRoutesApproved',
    'eligibilityProcessApproved','architectureApproved']) if (config[key] !== true) missing.push(key);
  if (config.roundsFromDoc?.[4]?.paidCapHRP == null) missing.push('round3PaidCapHRP');
  return missing;
}

const {
  AUTO_TRADE_ENABLED,
  COPY_TRADE_ENABLED,
  COPY_SELL_ORDERS,
  MIN_TRACKED_TRADE_SIZE_USD,
  MIN_TRACKED_CONFIDENCE_LEVEL,
  OPTIMAL_CONFIDENCE_MIN,
  OPTIMAL_CONFIDENCE_MAX,
  USE_OPTIMAL_CONFIDENCE_FILTER,
  PAPER_TRADING_ENABLED,
  SEND_TRADES_ONLY,
} = require("../../config");
const { matchesAutoTradeFilter } = require("../../utils/helpers");

function filterTrades(activities) {
  if (SEND_TRADES_ONLY) {
    return activities.filter(
      (item) =>
        item?.type === "TRADE" &&
        (String(item?.side).toUpperCase() === "BUY" ||
          String(item?.side).toUpperCase() === "SELL") &&
        item?.transactionHash
    );
  }
  return activities.filter(
    (item) =>
      item?.type === "TRADE" &&
      (String(item?.side).toUpperCase() === "BUY" ||
        String(item?.side).toUpperCase() === "SELL")
  );
}

function meetsMinTradeSize(usdcSize) {
  return (
    MIN_TRACKED_TRADE_SIZE_USD === 0 ||
    (usdcSize || 0) >= MIN_TRACKED_TRADE_SIZE_USD
  );
}

function isOptimalConfidenceRange(tradePrice) {
  return (
    tradePrice >= OPTIMAL_CONFIDENCE_MIN && tradePrice <= OPTIMAL_CONFIDENCE_MAX
  );
}

function meetsOptimalConfidenceFilter(tradePrice) {
  return !USE_OPTIMAL_CONFIDENCE_FILTER || tradePrice >= OPTIMAL_CONFIDENCE_MIN;
}

function getEffectiveMinConfidence() {
  if (USE_OPTIMAL_CONFIDENCE_FILTER) {
    return 0;
  }
  return MIN_TRACKED_CONFIDENCE_LEVEL;
}

function meetsMinConfidence(tradePrice) {
  const effectiveMinConfidence = getEffectiveMinConfidence();
  return effectiveMinConfidence === 0 || tradePrice >= effectiveMinConfidence;
}

function canCopySellOrder(tradeSide) {
  return tradeSide !== "SELL" || COPY_SELL_ORDERS;
}

function canAutoTrade(trade, clobClient, clobClientReady) {
  const { conditionId, side, price, usdcSize } = trade;

  const tradeSide = String(side).toUpperCase();
  const tradePrice = price || 0;
  const trackedTradeSize = usdcSize || 0;

  return (
    AUTO_TRADE_ENABLED &&
    COPY_TRADE_ENABLED &&
    conditionId &&
    canCopySellOrder(tradeSide) &&
    matchesAutoTradeFilter(trade) &&
    meetsMinTradeSize(trackedTradeSize) &&
    meetsMinConfidence(tradePrice) &&
    meetsOptimalConfidenceFilter(tradePrice) &&
    (PAPER_TRADING_ENABLED || (clobClient && clobClientReady))
  );
}

function getSkipReasons(trade, clobClient, clobClientReady) {
  const reasons = [];
  const { conditionId, side, price, usdcSize } = trade;

  const tradeSide = String(side).toUpperCase();
  const tradePrice = price || 0;
  const trackedTradeSize = usdcSize || 0;
  const effectiveMinConfidence = getEffectiveMinConfidence();

  if (!COPY_TRADE_ENABLED) {
    reasons.push("copy trading disabled (COPY_TRADE_ENABLED=false)");
  }
  if (!matchesAutoTradeFilter(trade)) {
    reasons.push("filter mismatch");
  }
  if (!meetsMinTradeSize(trackedTradeSize)) {
    reasons.push(
      `trade size $${trackedTradeSize.toFixed(
        2
      )} < min $${MIN_TRACKED_TRADE_SIZE_USD}`
    );
  }
  if (!meetsMinConfidence(tradePrice) && !USE_OPTIMAL_CONFIDENCE_FILTER) {
    reasons.push(
      `confidence ${(tradePrice * 100).toFixed(1)}% < min ${(
        effectiveMinConfidence * 100
      ).toFixed(1)}%`
    );
  }
  if (!canCopySellOrder(tradeSide)) {
    reasons.push("SELL orders disabled (COPY_SELL_ORDERS=false)");
  }
  if (!meetsOptimalConfidenceFilter(tradePrice)) {
    reasons.push(
      `confidence ${(tradePrice * 100).toFixed(1)}% below optimal minimum ${(
        OPTIMAL_CONFIDENCE_MIN * 100
      ).toFixed(0)}% (trades above ${(OPTIMAL_CONFIDENCE_MAX * 100).toFixed(
        0
      )}% are still traded)`
    );
  }
  if (!PAPER_TRADING_ENABLED && (!clobClient || !clobClientReady)) {
    reasons.push("clobClient not ready");
  }

  return reasons;
}

function getSkipReasonMessage(trade, clobClient, clobClientReady) {
  if (!AUTO_TRADE_ENABLED) {
    return "AUTO_TRADE_ENABLED is false";
  }
  if (!COPY_TRADE_ENABLED) {
    return "COPY_TRADE_ENABLED is false (copy trading disabled)";
  }
  if (!clobClient) {
    return "CLOB client not initialized";
  }
  if (!clobClientReady) {
    return "CLOB client not ready (API credentials not set)";
  }
  if (!trade.conditionId) {
    return "No conditionId in trade";
  }
  if (!matchesAutoTradeFilter(trade)) {
    return `Trade does not match filter "${
      require("../../config").AUTO_TRADE_FILTER
    }"`;
  }
  return "Unknown reason";
}

module.exports = {
  filterTrades,
  meetsMinTradeSize,
  isOptimalConfidenceRange,
  meetsOptimalConfidenceFilter,
  getEffectiveMinConfidence,
  meetsMinConfidence,
  canCopySellOrder,
  canAutoTrade,
  getSkipReasons,
  getSkipReasonMessage,
};

const { AUTO_TRADE_FILTER } = require("../config");

function isValidWalletAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function matchesAutoTradeFilter(trade) {
  if (!AUTO_TRADE_FILTER) {
    return true;
  }

  const keywords = AUTO_TRADE_FILTER.split(",")
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);

  const searchText = [trade.title, trade.slug, trade.eventSlug, trade.outcome]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const matched = keywords.some((keyword) => {
    const directMatch = searchText.includes(keyword);
    let extendedMatch = false;

    if (keyword === "eth") {
      extendedMatch = searchText.includes("ethereum");
    } else if (keyword === "btc") {
      extendedMatch = searchText.includes("bitcoin");
    }

    return directMatch || extendedMatch;
  });

  return matched;
}

function isCloudflareBlock(response) {
  if (!response) return false;
  if (typeof response === "string") {
    return (
      response.includes("Cloudflare") || response.includes("Attention Required")
    );
  }
  if (typeof response === "object") {
    const responseStr = JSON.stringify(response);
    return (
      responseStr.includes("Cloudflare") ||
      responseStr.includes("Attention Required")
    );
  }
  return false;
}

module.exports = {
  isValidWalletAddress,
  matchesAutoTradeFilter,
  isCloudflareBlock,
};

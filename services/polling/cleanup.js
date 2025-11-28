const { logToFile } = require("../../utils/logger");
const { fetchLatestActivity } = require("../marketData");

async function cleanupHourlyEvents(
  orderbookWS,
  currentWallet,
  getAllStopLossPositions,
  deleteStopLossPosition
) {
  if (!orderbookWS || !currentWallet) {
    return;
  }

  try {
    const allPositions = getAllStopLossPositions();

    if (allPositions.size === 0) {
      logToFile("DEBUG", "No stop-loss positions to check for cleanup", {});
      return;
    }

    const activities = await fetchLatestActivity(currentWallet);
    const recentTrades = activities.filter(
      (item) =>
        item?.type === "TRADE" &&
        (String(item?.side).toUpperCase() === "BUY" ||
          String(item?.side).toUpperCase() === "SELL") &&
        item?.conditionId
    );

    logToFile("DEBUG", "Proactive hourly event cleanup check", {
      monitoredPositions: allPositions.size,
      recentTradesWithConditionId: recentTrades.length,
      positionDetails: Array.from(allPositions.entries()).map(
        ([tokenId, pos]) => ({
          tokenId: tokenId.substring(0, 10) + "...",
          conditionId: pos.conditionId
            ? pos.conditionId.substring(0, 10) + "..."
            : null,
          market: pos.market,
        })
      ),
    });

    const marketTypeToConditionIds = new Map();
    for (const trade of recentTrades) {
      const { title, slug, conditionId, timestamp } = trade;
      if (!conditionId) continue;

      const marketTypeMatch = (title || slug || "").match(/^([^-]+)/);
      const marketType = marketTypeMatch ? marketTypeMatch[1].trim() : null;

      if (marketType) {
        if (!marketTypeToConditionIds.has(marketType)) {
          marketTypeToConditionIds.set(marketType, new Map());
        }
        const conditionIdMap = marketTypeToConditionIds.get(marketType);
        const existing = conditionIdMap.get(conditionId);
        if (
          !existing ||
          (timestamp && existing.timestamp && timestamp > existing.timestamp)
        ) {
          conditionIdMap.set(conditionId, {
            conditionId,
            timestamp: timestamp || 0,
          });
        }
      }
    }

    for (const [tokenId, position] of allPositions.entries()) {
      if (!position.conditionId || !position.market) continue;

      const marketTypeMatch = position.market.match(/^([^-]+)/);
      const marketType = marketTypeMatch ? marketTypeMatch[1].trim() : null;

      if (!marketType) {
        logToFile("DEBUG", "Could not extract market type from position", {
          tokenId: tokenId.substring(0, 10) + "...",
          market: position.market,
        });
        continue;
      }

      const conditionIdMap = marketTypeToConditionIds.get(marketType);
      if (!conditionIdMap || conditionIdMap.size === 0) {
        logToFile("DEBUG", "No conditionId map found for market type", {
          tokenId: tokenId.substring(0, 10) + "...",
          marketType,
          availableMarketTypes: Array.from(marketTypeToConditionIds.keys()),
        });
        continue;
      }

      const storedConditionId = position.conditionId
        ? position.conditionId.toLowerCase()
        : null;

      const hasDifferentConditionId = Array.from(conditionIdMap.keys()).some(
        (cid) => cid.toLowerCase() !== storedConditionId
      );

      if (hasDifferentConditionId) {
        let latestEvent = null;
        for (const event of conditionIdMap.values()) {
          if (event.conditionId.toLowerCase() !== storedConditionId) {
            if (
              !latestEvent ||
              (event.timestamp &&
                latestEvent.timestamp &&
                event.timestamp > latestEvent.timestamp)
            ) {
              latestEvent = event;
            }
          }
        }

        if (latestEvent) {
          logToFile(
            "INFO",
            "Cleaning up old hourly event subscription - detected new event in recent trades",
            {
              oldTokenId: tokenId.substring(0, 10) + "...",
              oldConditionId: position.conditionId.substring(0, 10) + "...",
              newConditionId: latestEvent.conditionId.substring(0, 10) + "...",
              marketType,
            }
          );
          orderbookWS.unsubscribe(tokenId);
          deleteStopLossPosition(tokenId);
        } else {
          logToFile("DEBUG", "No latest event found for cleanup", {
            tokenId: tokenId.substring(0, 10) + "...",
            positionConditionId: position.conditionId
              ? position.conditionId.substring(0, 10) + "..."
              : null,
            marketType,
            conditionIdsInMap: Array.from(conditionIdMap.keys()).map(
              (cid) => cid.substring(0, 10) + "..."
            ),
          });
        }
      } else {
        logToFile("DEBUG", "No different conditionId found for market type", {
          tokenId: tokenId.substring(0, 10) + "...",
          positionConditionId: position.conditionId
            ? position.conditionId.substring(0, 10) + "..."
            : null,
          marketType,
          conditionIdsInMap: Array.from(conditionIdMap.keys()).map(
            (cid) => cid.substring(0, 10) + "..."
          ),
        });
      }
    }
  } catch (cleanupError) {
    logToFile("ERROR", "Error during proactive hourly event cleanup", {
      error: cleanupError.message,
      stack: cleanupError.stack,
    });
  }
}

module.exports = {
  cleanupHourlyEvents,
};

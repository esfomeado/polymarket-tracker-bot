const {
  STOP_LOSS_ENABLED,
  STOP_LOSS_PERCENTAGE,
  STOP_LOSS_MIN_TIME_SINCE_ENTRY_MS,
  STOP_LOSS_WEBSOCKET_MARKET_FILTER,
  PAPER_TRADING_ENABLED,
} = require("../config");
const { logToFile, logTradeToFile } = require("../utils/logger");
const {
  getStopLossPosition,
  deleteStopLossPosition,
  getCurrentPositions,
  getAllStopLossPositions,
} = require("./positions");
const { placeMarketSellOrder } = require("./orders");

async function handleWebSocketStopLoss(
  tokenId,
  currentPrice,
  side,
  clobClient,
  clobClientReady,
  activeChannel,
  orderbookWS
) {
  if (!STOP_LOSS_ENABLED || PAPER_TRADING_ENABLED) {
    return;
  }

  if (!clobClient || !clobClientReady) {
    return;
  }

  try {
    let stopLossPosition = getStopLossPosition(tokenId);

    if (!stopLossPosition) {
      const allStopLossPositions = getAllStopLossPositions();
      if (allStopLossPositions && allStopLossPositions.size > 0) {
        const tokenIdSuffix = tokenId?.slice(-20) || "";
        for (const [
          storedTokenId,
          position,
        ] of allStopLossPositions.entries()) {
          if (
            storedTokenId === tokenId ||
            String(storedTokenId) === String(tokenId)
          ) {
            stopLossPosition = position;
            break;
          }
          if (
            storedTokenId.endsWith(tokenIdSuffix) ||
            tokenId.endsWith(storedTokenId.slice(-20))
          ) {
            stopLossPosition = position;
            break;
          }
        }
      }
    }

    if (!stopLossPosition) {
      return;
    }
    const matchesFilter =
      STOP_LOSS_WEBSOCKET_MARKET_FILTER.length === 0 ||
      STOP_LOSS_WEBSOCKET_MARKET_FILTER.some((filter) => {
        if (filter.startsWith("0x") && stopLossPosition.conditionId) {
          return (
            stopLossPosition.conditionId.toLowerCase() === filter.toLowerCase()
          );
        }
        if (stopLossPosition.market) {
          return stopLossPosition.market
            .toLowerCase()
            .includes(filter.toLowerCase());
        }
        return false;
      });

    if (!matchesFilter) {
      deleteStopLossPosition(tokenId);
      if (orderbookWS) {
        orderbookWS.unsubscribe(tokenId);
        logToFile(
          "INFO",
          "Unsubscribed from WebSocket - position no longer matches filter",
          {
            tokenId: tokenId.substring(0, 10) + "...",
          }
        );
      }
      logToFile(
        "WARN",
        "Removed position from stop-loss monitoring - no longer matches filter",
        {
          tokenId: tokenId.substring(0, 10) + "...",
          market: stopLossPosition.market,
          filter: STOP_LOSS_WEBSOCKET_MARKET_FILTER.join(", "),
        }
      );
      return;
    }

    const {
      entryPrice,
      shares: storedShares,
      entryTimestamp,
      stopLossPrice,
    } = stopLossPosition;
    let shares = storedShares;

    const now = Date.now();
    if (
      entryTimestamp &&
      now - entryTimestamp < STOP_LOSS_MIN_TIME_SINCE_ENTRY_MS
    ) {
      return;
    }

    if (currentPrice > stopLossPrice) {
      return;
    }

    const lossPercentage = ((entryPrice - currentPrice) / entryPrice) * 100;

    logToFile("WARN", "WebSocket stop-loss triggered", {
      tokenId: tokenId.substring(0, 10) + "...",
      entryPrice,
      currentPrice,
      stopLossPrice,
      lossPercentage: lossPercentage.toFixed(2),
      shares,
      side,
    });

    try {
      const positions = await getCurrentPositions();

      const actualPosition = positions.find((pos) => {
        const posTokenId =
          pos.token_id || pos.tokenID || pos.asset || pos.conditionId;
        if (!posTokenId) return false;
        if (posTokenId === tokenId) return true;
        if (String(posTokenId) === String(tokenId)) return true;
        const posTokenIdStr = String(posTokenId);
        const tokenIdStr = String(tokenId);
        if (
          posTokenIdStr.endsWith(tokenIdStr) ||
          tokenIdStr.endsWith(posTokenIdStr)
        )
          return true;
        const normalize = (id) => String(id).replace(/^0+/, "").toLowerCase();
        if (normalize(posTokenIdStr) === normalize(tokenIdStr)) return true;
        return false;
      });

      if (!actualPosition) {
        logToFile(
          "WARN",
          "Stop-loss triggered but position no longer exists, cleaning up",
          {
            tokenId: tokenId.substring(0, 10) + "...",
            entryPrice,
            currentPrice,
            expectedShares: shares,
            totalPositions: positions.length,
            availableTokenIds: positions.slice(0, 3).map((pos) => ({
              token_id: pos.token_id?.substring(0, 10) + "...",
              tokenID: pos.tokenID?.substring(0, 10) + "...",
              asset: pos.asset?.substring(0, 10) + "...",
            })),
          }
        );
        deleteStopLossPosition(tokenId);
        if (orderbookWS) {
          orderbookWS.unsubscribe(tokenId);
        }
        return;
      }

      const actualShares =
        parseFloat(actualPosition.size) ||
        parseFloat(actualPosition.shares) ||
        parseFloat(actualPosition.amount) ||
        0;

      if (actualShares <= 0) {
        logToFile("WARN", "Stop-loss position has no shares, cleaning up", {
          tokenId: tokenId.substring(0, 10) + "...",
        });
        deleteStopLossPosition(tokenId);
        if (orderbookWS) {
          orderbookWS.unsubscribe(tokenId);
        }
        return;
      }

      if (Math.abs(actualShares - shares) > 0.001) {
        logToFile(
          "INFO",
          "Using actual position size instead of stored amount",
          {
            tokenId: tokenId.substring(0, 10) + "...",
            storedShares: shares,
            actualShares: actualShares,
            difference: (actualShares - shares).toFixed(4),
          }
        );
      }

      shares = actualShares;

      const sellResult = await placeMarketSellOrder(
        tokenId,
        shares,
        null,
        clobClient,
        clobClientReady,
        null,
        null,
        null
      );

      if (sellResult && sellResult.error) {
        logToFile("ERROR", "Failed to execute stop-loss market sell", {
          tokenId: tokenId.substring(0, 10) + "...",
          error: sellResult.error,
        });
        return;
      }

      deleteStopLossPosition(tokenId);
      if (orderbookWS) {
        orderbookWS.unsubscribe(tokenId);
        logToFile(
          "INFO",
          "Unsubscribed from WebSocket after stop-loss execution",
          {
            tokenId: tokenId.substring(0, 10) + "...",
          }
        );
      }

      logToFile("INFO", "Stop-loss market sell executed", {
        tokenId: tokenId.substring(0, 10) + "...",
        entryPrice,
        exitPrice: currentPrice,
        shares,
        lossPercentage: lossPercentage.toFixed(2),
        orderId: sellResult?.orderId,
      });

      logTradeToFile("INFO", "SELL order executed (STOP-LOSS)", {
        tokenId: tokenId.substring(0, 10) + "...",
        orderValue: (shares * currentPrice).toFixed(4),
        orderSize: shares.toFixed(4),
        orderPrice: currentPrice.toFixed(4),
        entryPrice: entryPrice.toFixed(4),
        exitPrice: currentPrice.toFixed(4),
        lossPercentage: lossPercentage.toFixed(2),
        market: stopLossPosition.market,
        outcome: stopLossPosition.outcome,
        orderId: sellResult?.orderId,
      });

      if (activeChannel) {
        await activeChannel.send({
          embeds: [
            {
              title: "🛑 Stop-Loss Triggered (WebSocket)",
              description: `Position automatically sold via market order`,
              color: 0xff0000,
              fields: [
                {
                  name: "Entry Price",
                  value: `$${entryPrice.toFixed(4)} (${(
                    entryPrice * 100
                  ).toFixed(2)}¢)`,
                  inline: true,
                },
                {
                  name: "Exit Price",
                  value: `$${currentPrice.toFixed(4)} (${(
                    currentPrice * 100
                  ).toFixed(2)}¢)`,
                  inline: true,
                },
                {
                  name: "Loss %",
                  value: `${lossPercentage.toFixed(2)}%`,
                  inline: true,
                },
                {
                  name: "Shares",
                  value: `${shares.toFixed(2)}`,
                  inline: true,
                },
                {
                  name: "Order Type",
                  value: "Market Order",
                  inline: true,
                },
                {
                  name: "Order ID",
                  value: sellResult?.orderId || "Pending",
                  inline: true,
                },
              ],
              timestamp: new Date().toISOString(),
            },
          ],
        });
      }
    } catch (error) {
      if (
        error.message &&
        (error.message.includes("not enough balance") ||
          error.message.includes("don't own enough tokens") ||
          error.message.includes("You need to buy tokens first"))
      ) {
        logToFile(
          "WARN",
          "Stop-loss failed: position no longer exists or insufficient balance, cleaning up",
          {
            tokenId: tokenId.substring(0, 10) + "...",
            error: error.message,
          }
        );
        deleteStopLossPosition(tokenId);
        if (orderbookWS) {
          orderbookWS.unsubscribe(tokenId);
        }
        return;
      }

      logToFile("ERROR", "Error executing stop-loss market sell", {
        tokenId: tokenId.substring(0, 10) + "...",
        error: error.message,
        stack: error.stack,
      });
    }
  } catch (error) {
    logToFile("ERROR", "Error in WebSocket stop-loss handler", {
      tokenId: tokenId.substring(0, 10) + "...",
      error: error.message,
      stack: error.stack,
    });
  }
}

module.exports = {
  handleWebSocketStopLoss,
};

const {
  AUTO_TRADE_AMOUNT_USD,
  AUTO_TRADE_USE_MARKET,
  PAPER_TRADING_ENABLED,
  MIN_ORDER_VALUE_USD,
  OPTIMAL_CONFIDENCE_BET_MULTIPLIER,
  HIGH_CONFIDENCE_THRESHOLD_USD,
  LOW_CONFIDENCE_THRESHOLD_USD,
  MAX_BET_AMOUNT_PER_MARKET_USD,
  MAX_ORDER_VALUE_USD,
  ADD_HIGH_CONFIDENCE_ENABLED,
  ADD_HIGH_CONFIDENCE_MIN,
  ADD_HIGH_CONFIDENCE_MAX,
  ADD_HIGH_CONFIDENCE_SIZE_USD,
  USE_HALF_SIZE_INITIAL_TRADES,
  STOP_LOSS_ENABLED,
  STOP_LOSS_PERCENTAGE,
  STOP_LOSS_WEBSOCKET_MARKET_FILTER,
} = require("../../config");
const { logToFile, logTradeToFile } = require("../../utils/logger");
const {
  getPositionValueForToken,
  checkPositionLimits,
  setTrackedPosition,
  deleteTrackedPosition,
  hasHighConfidenceAddBeenPlaced,
  markHighConfidenceAddPlaced,
  hasInitialTradeBeenPlaced,
  markInitialTradePlaced,
  setStopLossPosition,
  getAllStopLossPositions,
  deleteStopLossPosition,
} = require("../positions");
const {
  paperBuy,
  paperSell,
  getPaperTradingState,
} = require("../paperTrading");
const {
  placeBuyOrder,
  placeSellOrder,
  placeMarketBuyOrder,
  placeMarketSellOrder,
} = require("../orders");
const { getTrackedWalletPosition } = require("../marketData");
const discordEmbeds = require("./discordEmbeds");
const tradeProcessor = require("./tradeProcessor");

async function calculateBuyOrderSize(
  trade,
  tokenId,
  orderPrice,
  paperTradingState
) {
  const {
    price: tradePrice,
    usdcSize: trackedTradeSize,
    size: trackedShareSize,
  } = trade;

  let orderSize = 0;
  let orderValue = 0;
  let confidenceLevel = "MEDIUM";
  const isOptimalConfidenceRange =
    tradeProcessor.isOptimalConfidenceRange(tradePrice);
  const isHighConfidenceAdd =
    ADD_HIGH_CONFIDENCE_ENABLED &&
    tradePrice >= ADD_HIGH_CONFIDENCE_MIN &&
    tradePrice <= ADD_HIGH_CONFIDENCE_MAX;

  const optimalMultiplier = isOptimalConfidenceRange
    ? OPTIMAL_CONFIDENCE_BET_MULTIPLIER
    : 1.0;

  const maxBetAmount =
    MAX_BET_AMOUNT_PER_MARKET_USD > 0
      ? MAX_BET_AMOUNT_PER_MARKET_USD
      : MAX_ORDER_VALUE_USD;

  if (isHighConfidenceAdd) {
    if (hasHighConfidenceAddBeenPlaced(tokenId)) {
      return {
        skipped: true,
        reason: "high_confidence_already_placed",
        embed: discordEmbeds.createAutoTradeSkippedEmbed(
          "High-Confidence Add Skipped",
          "Already placed one high-confidence add (80-90%+) for this market. Only one allowed per market.",
          [
            {
              name: "Market",
              value: trade.title || trade.slug || "Unknown",
              inline: false,
            },
            {
              name: "Outcome",
              value: trade.outcome || "Unknown",
              inline: true,
            },
            {
              name: "Trade Confidence",
              value: `${(tradePrice * 100).toFixed(1)}%`,
              inline: true,
            },
          ]
        ),
      };
    }

    confidenceLevel = "HIGH CONFIDENCE ADD (80-90%+)";

    let currentPositionValue = 0;
    if (PAPER_TRADING_ENABLED) {
      const paperPos = paperTradingState.positions[tokenId];
      if (paperPos) {
        currentPositionValue = paperPos.entryValue || 0;
      }
    } else {
      currentPositionValue = await getPositionValueForToken(tokenId);
    }

    const remainingAmount = Math.max(0, maxBetAmount - currentPositionValue);
    const highConfidenceMinOrder = Math.min(ADD_HIGH_CONFIDENCE_SIZE_USD, 1);

    if (remainingAmount < highConfidenceMinOrder) {
      logToFile("INFO", "High-confidence add skipped: Insufficient room", {
        tradePrice: tradePrice * 100,
        confidenceLevel,
        addSize: ADD_HIGH_CONFIDENCE_SIZE_USD,
        currentPositionValue,
        maxBetAmount,
        remainingAmount,
        minOrderValue: highConfidenceMinOrder,
        isHighConfidenceAdd: true,
      });
      return {
        orderSize: 0,
        orderValue: 0,
        confidenceLevel,
        isHighConfidenceAdd: true,
      };
    }

    orderValue = Math.min(ADD_HIGH_CONFIDENCE_SIZE_USD, remainingAmount);
    orderSize = orderPrice > 0 ? orderValue / orderPrice : 0;

    logToFile("INFO", "High-confidence add trade detected (80-90%+)", {
      tradePrice: tradePrice * 100,
      confidenceLevel,
      addSize: ADD_HIGH_CONFIDENCE_SIZE_USD,
      currentPositionValue,
      maxBetAmount,
      remainingAmount,
      ourBetSize: orderValue,
      isHighConfidenceAdd: true,
    });
  } else {
    orderValue = AUTO_TRADE_AMOUNT_USD;

    if (isOptimalConfidenceRange) {
      orderValue = orderValue * optimalMultiplier;
      confidenceLevel = "HIGH SIZE (OPTIMAL PRICE RANGE)";
    } else if (trackedTradeSize >= HIGH_CONFIDENCE_THRESHOLD_USD) {
      confidenceLevel = "HIGH SIZE";
    } else if (trackedTradeSize <= LOW_CONFIDENCE_THRESHOLD_USD) {
      confidenceLevel = "LOW SIZE";
    } else {
      confidenceLevel = "MEDIUM SIZE";
    }

    orderValue = Math.min(orderValue, maxBetAmount);

    if (USE_HALF_SIZE_INITIAL_TRADES) {
      orderValue = orderValue / 2;
      confidenceLevel += " (HALF-SIZE)";
    }

    orderSize = orderPrice > 0 ? orderValue / orderPrice : 0;
    logToFile("INFO", "Initial trade detected (60-80%)", {
      trackedTradeSize,
      confidenceLevel,
      isOptimalRange: isOptimalConfidenceRange,
      optimalMultiplier,
      ourBetSize: orderValue,
      maxBetAmount,
      autoTradeAmount: AUTO_TRADE_AMOUNT_USD,
      halfSizeEnabled: USE_HALF_SIZE_INITIAL_TRADES,
    });
  }

  return {
    orderSize,
    orderValue,
    confidenceLevel,
    isHighConfidenceAdd,
    isOptimalConfidenceRange,
  };
}

async function calculateSellOrderSize(
  trade,
  tokenId,
  orderPrice,
  currentWallet
) {
  const { size: trackedShareSize, usdcSize: trackedTradeSize } = trade;

  let orderSize = 0;
  let orderValue = 0;

  const currentPositionValue = await getPositionValueForToken(tokenId);
  const currentPositionShares =
    currentPositionValue > 0 && orderPrice > 0
      ? currentPositionValue / orderPrice
      : 0;

  if (currentPositionValue <= 0 || currentPositionShares <= 0) {
    return {
      skipped: true,
      reason: "no_position",
      embed: discordEmbeds.createAutoTradeSkippedEmbed(
        "Auto-trade Skipped",
        "Cannot sell: You don't have a position in this market.",
        []
      ),
    };
  }

  let trackedSellShares = 0;
  if (trackedShareSize > 0) {
    trackedSellShares = trackedShareSize;
  } else if (trackedTradeSize > 0 && orderPrice > 0) {
    trackedSellShares = trackedTradeSize / orderPrice;
  }

  if (trackedSellShares > 0) {
    const trackedWalletCurrentShares = await getTrackedWalletPosition(
      tokenId,
      currentWallet,
      orderPrice
    );

    const trackedWalletTotalShares =
      trackedWalletCurrentShares + trackedSellShares;

    if (trackedWalletTotalShares > 0) {
      const sellPercentage = trackedSellShares / trackedWalletTotalShares;

      orderSize = currentPositionShares * sellPercentage;
      orderValue = orderSize * orderPrice;

      if (orderValue < MIN_ORDER_VALUE_USD && orderPrice > 0) {
        orderSize = MIN_ORDER_VALUE_USD / orderPrice;
        orderValue = MIN_ORDER_VALUE_USD;
      }

      orderSize = Math.min(orderSize, currentPositionShares);
      orderValue = orderSize * orderPrice;

      logToFile(
        "INFO",
        "SELL order: Calculating sell percentage from tracked wallet",
        {
          trackedWalletCurrentShares,
          trackedWalletTotalShares,
          trackedSellShares,
          sellPercentage: sellPercentage * 100,
          ourPositionShares: currentPositionShares,
          ourPositionValue: currentPositionValue,
          ourSellSize: orderSize,
          ourSellValue: orderValue,
          ourSellPercentage: (orderSize / currentPositionShares) * 100,
        }
      );
    } else {
      logToFile(
        "WARN",
        "SELL order: Could not determine tracked wallet total position",
        {
          trackedWalletCurrentShares,
          trackedSellShares,
          ourPositionShares: currentPositionShares,
        }
      );
    }
  }

  if (orderSize === 0 && orderValue === 0) {
    if (trackedShareSize > 0) {
      orderSize = Math.min(trackedShareSize, currentPositionShares);
      orderValue = orderSize * orderPrice;
      logToFile(
        "WARN",
        "SELL order: Could not fetch tracked wallet position, copying sell size directly",
        {
          trackedShareSize,
          ourPositionShares: currentPositionShares,
          ourSellSize: orderSize,
          ourSellValue: orderValue,
        }
      );
    } else if (trackedTradeSize > 0 && orderPrice > 0) {
      orderSize = Math.min(
        trackedTradeSize / orderPrice,
        currentPositionShares
      );
      orderValue = orderSize * orderPrice;
    } else {
      orderValue = MIN_ORDER_VALUE_USD;
      orderSize = Math.min(orderValue / orderPrice, currentPositionShares);
      orderValue = orderSize * orderPrice;
    }
  }

  return { orderSize, orderValue };
}

async function checkAndAdjustOrderSize(
  trade,
  tokenId,
  orderSize,
  orderValue,
  orderPrice,
  tradeSide,
  isHighConfidenceAdd,
  paperTradingState
) {
  const { title, slug, conditionId } = trade;
  const maxBetAmount =
    MAX_BET_AMOUNT_PER_MARKET_USD > 0
      ? MAX_BET_AMOUNT_PER_MARKET_USD
      : MAX_ORDER_VALUE_USD;

  if (tokenId && tradeSide === "BUY" && MAX_BET_AMOUNT_PER_MARKET_USD > 0) {
    let currentPositionValue = 0;
    if (PAPER_TRADING_ENABLED) {
      const paperPos = paperTradingState.positions[tokenId];
      if (paperPos) {
        currentPositionValue = paperPos.entryValue || 0;
      }
    } else {
      currentPositionValue = await getPositionValueForToken(tokenId);
    }

    const remainingAmount = Math.max(0, maxBetAmount - currentPositionValue);

    if (remainingAmount === 0) {
      return {
        skipped: true,
        embed: discordEmbeds.createAutoTradeSkippedEmbed(
          `Market "${title || slug}" already at max bet amount per position.`,
          "",
          [
            {
              name: "Current Position",
              value: `$${currentPositionValue.toFixed(2)}`,
              inline: true,
            },
            {
              name: "Max Bet Amount",
              value: `$${maxBetAmount.toFixed(2)}`,
              inline: true,
            },
            {
              name: "Proposed Trade",
              value: `$${orderValue.toFixed(2)} (${orderSize.toFixed(
                2
              )} shares)`,
              inline: true,
            },
          ]
        ),
      };
    } else if (orderValue > remainingAmount) {
      const originalOrderSize = orderSize;
      const originalOrderValue = orderValue;
      orderSize = orderPrice > 0 ? remainingAmount / orderPrice : 0;
      orderValue = orderSize * orderPrice;

      if (orderValue < MIN_ORDER_VALUE_USD && orderPrice > 0) {
        const minOrderValue = MIN_ORDER_VALUE_USD;
        if (currentPositionValue + minOrderValue > maxBetAmount) {
          return {
            skipped: true,
            embed: discordEmbeds.createAutoTradeSkippedEmbed(
              `Cannot place trade: minimum order size ($${minOrderValue}) would exceed max bet amount per position.`,
              "",
              [
                {
                  name: "Current Position",
                  value: `$${currentPositionValue.toFixed(2)}`,
                  inline: true,
                },
                {
                  name: "Max Bet Amount",
                  value: `$${maxBetAmount.toFixed(2)}`,
                  inline: true,
                },
                {
                  name: "Capped Trade",
                  value: `$${orderValue.toFixed(
                    2
                  )} (below $${minOrderValue} minimum)`,
                  inline: false,
                },
                {
                  name: "Minimum Order",
                  value: `$${minOrderValue.toFixed(2)} (would exceed limit)`,
                  inline: false,
                },
              ]
            ),
          };
        } else {
          orderSize = MIN_ORDER_VALUE_USD / orderPrice;
          orderValue = MIN_ORDER_VALUE_USD;
          logToFile(
            "WARN",
            "Capped order below minimum, adjusted to minimum (within limit)",
            {
              conditionId,
              tokenId,
              market: title || slug,
              currentPositionValue,
              maxBetAmount,
              cappedOrderValue: orderSize * orderPrice,
              adjustedOrderValue: orderValue,
              minValue: MIN_ORDER_VALUE_USD,
            }
          );
        }
      }

      logToFile(
        "INFO",
        "Auto-trade size capped to avoid exceeding max bet amount per position",
        {
          conditionId,
          tokenId,
          market: title || slug,
          currentPositionValue,
          maxBetAmount,
          originalOrderSize,
          originalOrderValue,
          cappedOrderSize: orderSize,
          cappedOrderValue: orderValue,
        }
      );

      return {
        adjusted: true,
        orderSize,
        orderValue,
        embed: discordEmbeds.createTradeSizeCappedEmbed({
          currentPositionValue,
          maxBetAmount,
          originalOrderSize,
          originalOrderValue,
          orderSize,
          orderValue,
        }),
      };
    }
  }

  if (
    orderValue < MIN_ORDER_VALUE_USD &&
    orderPrice > 0 &&
    !isHighConfidenceAdd
  ) {
    if (tradeSide === "BUY" && tokenId && MAX_BET_AMOUNT_PER_MARKET_USD > 0) {
      let currentPositionValue = 0;
      if (PAPER_TRADING_ENABLED) {
        const paperPos = paperTradingState.positions[tokenId];
        if (paperPos) {
          currentPositionValue = paperPos.entryValue || 0;
        }
      } else {
        currentPositionValue = await getPositionValueForToken(tokenId);
      }

      const effectiveMinOrderValue = USE_HALF_SIZE_INITIAL_TRADES
        ? MIN_ORDER_VALUE_USD / 2
        : MIN_ORDER_VALUE_USD;

      if (currentPositionValue + effectiveMinOrderValue > maxBetAmount) {
        return {
          skipped: true,
          embed: discordEmbeds.createAutoTradeSkippedEmbed(
            `Cannot place trade: minimum order size ($${effectiveMinOrderValue.toFixed(
              2
            )}) would exceed max bet amount per position.`,
            "",
            [
              {
                name: "Current Position",
                value: `$${currentPositionValue.toFixed(2)}`,
                inline: true,
              },
              {
                name: "Max Bet Amount",
                value: `$${maxBetAmount.toFixed(2)}`,
                inline: true,
              },
              {
                name: "Order Value",
                value: `$${orderValue.toFixed(
                  2
                )} (below $${effectiveMinOrderValue.toFixed(2)} minimum)`,
                inline: false,
              },
              {
                name: "Minimum Order",
                value: `$${effectiveMinOrderValue.toFixed(
                  2
                )} (would exceed limit)`,
                inline: false,
              },
            ]
          ),
        };
      } else {
        if (orderValue < effectiveMinOrderValue) {
          const originalOrderSize = orderSize;
          const originalOrderValue = orderSize * orderPrice;
          orderSize = effectiveMinOrderValue / orderPrice;
          orderValue = effectiveMinOrderValue;
          logToFile(
            "WARN",
            "Order value below minimum, adjusted to minimum (within max bet limit)",
            {
              conditionId,
              tokenId,
              market: title || slug,
              currentPositionValue,
              maxBetAmount,
              originalOrderSize,
              originalOrderValue,
              adjustedOrderSize: orderSize,
              adjustedOrderValue: orderValue,
              minValue: effectiveMinOrderValue,
              standardMinValue: MIN_ORDER_VALUE_USD,
              halfSizeEnabled: USE_HALF_SIZE_INITIAL_TRADES,
              orderPrice,
            }
          );

          return {
            adjusted: true,
            orderSize,
            orderValue,
            embed: discordEmbeds.createOrderValueAdjustedEmbed({
              description: `Order value was below minimum of $${effectiveMinOrderValue.toFixed(
                2
              )}${
                USE_HALF_SIZE_INITIAL_TRADES ? " (half-size minimum)" : ""
              }. Adjusted to minimum (within max bet limit).`,
              fields: [
                {
                  name: "Original Order",
                  value: `$${originalOrderValue.toFixed(2)}`,
                  inline: true,
                },
                {
                  name: "Adjusted Order",
                  value: `$${orderValue.toFixed(2)} (${orderSize.toFixed(
                    2
                  )} shares)`,
                  inline: true,
                },
                {
                  name: "Position After Trade",
                  value: `$${(currentPositionValue + orderValue).toFixed(
                    2
                  )} / $${maxBetAmount.toFixed(2)}`,
                  inline: true,
                },
              ],
            }),
          };
        }
      }
    } else {
      const originalOrderSize = orderSize;
      orderSize = MIN_ORDER_VALUE_USD / orderPrice;
      orderValue = MIN_ORDER_VALUE_USD;
      logToFile("WARN", "Order value below minimum, increasing to $1", {
        originalOrderSize,
        originalOrderValue: originalOrderSize * orderPrice,
        adjustedOrderSize: orderSize,
        minValue: MIN_ORDER_VALUE_USD,
        orderPrice,
      });

      return {
        adjusted: true,
        orderSize,
        orderValue,
        embed: discordEmbeds.createOrderValueAdjustedEmbed({
          description: `Order value was below minimum of $${MIN_ORDER_VALUE_USD}.`,
          fields: [
            {
              name: "Adjusted Order",
              value: `$${orderValue.toFixed(2)} (${orderSize.toFixed(
                2
              )} shares)`,
              inline: true,
            },
          ],
        }),
      };
    }
  }

  return { orderSize, orderValue };
}

async function placeBuyOrderAuto(
  trade,
  tokenId,
  orderSize,
  orderValue,
  orderPrice,
  confidenceLevel,
  isHighConfidenceAdd,
  isOptimalConfidenceRange,
  detectedOrderType,
  clobClient,
  clobClientReady,
  orderbookWS,
  activeChannel,
  positionCheck
) {
  const {
    title,
    slug,
    conditionId,
    outcome,
    price: tradePrice,
    usdcSize: trackedTradeSize,
  } = trade;
  const useMarketOrder =
    AUTO_TRADE_USE_MARKET || detectedOrderType === "MARKET";
  const paperTradingState = getPaperTradingState();

  if (useMarketOrder) {
    if (PAPER_TRADING_ENABLED) {
      const paperResult = await paperBuy(
        tokenId,
        orderValue,
        orderPrice,
        title || slug || "Unknown",
        conditionId,
        null,
        outcome
      );

      if (paperResult && paperResult.error) {
        await activeChannel.send({
          embeds: [
            discordEmbeds.createErrorEmbed(
              "❌ Paper Trade FAILED",
              paperResult.error,
              [{ name: "Mode", value: "📝 Paper Trading", inline: true }]
            ),
          ],
        });
        return { success: false, error: paperResult.error };
      }

      if (paperResult && paperResult.success) {
        setTrackedPosition(tokenId, {
          usdcValue: orderValue,
          timestamp: Date.now(),
        });

        if (isHighConfidenceAdd) {
          markHighConfidenceAddPlaced(tokenId);
        } else {
          markInitialTradePlaced(tokenId);
        }

        const buyEmbed = discordEmbeds.createBuyOrderEmbed({
          isPaperTrading: true,
          isMarketOrder: true,
          orderValue,
          orderSize,
          orderPrice: "market price",
          entryPrice: orderPrice,
          market: title || slug || "Unknown market",
          outcome,
          confidenceLevel,
          tradePrice,
          trackedTradeSize,
          paperBalance: paperResult.balance,
          isHighConfidenceAdd,
          isOptimalConfidenceRange,
          positionInfo:
            positionCheck.allowed &&
            positionCheck.currentPositions !== undefined
              ? {
                  positionsAfter: positionCheck.currentPositions + 1,
                  maxPositions: require("../../config").MAX_POSITIONS,
                }
              : null,
        });

        await activeChannel.send({ embeds: [buyEmbed] });

        logTradeToFile(
          "INFO",
          "BUY order executed successfully (Paper Trading)",
          {
            tokenId: tokenId.substring(0, 15) + "...",
            conditionId: conditionId?.substring(0, 15) + "..." || null,
            market: title || slug || "Unknown",
            outcome,
            orderValue,
            orderSize,
            entryPrice: orderPrice,
            confidenceLevel,
            isHighConfidenceAdd,
            isOptimalConfidenceRange,
            paperBalance: paperResult.balance,
          }
        );

        return { success: true, paperResult };
      }
    } else {
      const orderResponse = await placeMarketBuyOrder(
        tokenId,
        orderValue,
        orderPrice,
        clobClient,
        clobClientReady,
        orderbookWS
      );

      if (orderResponse && orderResponse.error) {
        const errorMsg = orderResponse.error;
        let embed;
        if (errorMsg.includes("balance") || errorMsg.includes("allowance")) {
          embed = discordEmbeds.createErrorEmbed(
            "❌ Auto-trade FAILED",
            errorMsg,
            [
              {
                name: "Action Required",
                value: `1. Fund your wallet with USDC on Polygon (at least $${orderValue.toFixed(
                  2
                )})\n2. If using a proxy wallet, approve the CLOB contract to spend USDC`,
                inline: false,
              },
            ]
          );
        } else if (
          errorMsg.includes("orderbook") &&
          errorMsg.includes("does not exist")
        ) {
          embed = discordEmbeds.createErrorEmbed(
            "⚠️ Auto-trade SKIPPED",
            "Orderbook does not exist for this market. The market may be closed, expired, or inactive.",
            []
          );
        } else {
          embed = discordEmbeds.createErrorEmbed(
            "❌ Auto-placed MARKET BUY Order FAILED",
            errorMsg,
            []
          );
        }
        await activeChannel.send({ embeds: [embed] });
        return { success: false, error: errorMsg };
      } else if (orderResponse && orderResponse.success !== false) {
        setTrackedPosition(tokenId, {
          usdcValue: orderValue,
          timestamp: Date.now(),
        });

        if (isHighConfidenceAdd) {
          markHighConfidenceAddPlaced(tokenId);
        } else {
          markInitialTradePlaced(tokenId);
        }

        let actualEntryPrice = orderPrice;
        let actualShares = orderSize;

        try {
          const { getCurrentPositions } = require("../positions");
          await new Promise((resolve) => setTimeout(resolve, 2000));

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
            const normalize = (id) =>
              String(id).replace(/^0+/, "").toLowerCase();
            if (normalize(posTokenIdStr) === normalize(tokenIdStr)) return true;
            return false;
          });

          if (actualPosition) {
            const apiAvgPrice =
              parseFloat(actualPosition.avgPrice) ||
              parseFloat(actualPosition.avg_price) ||
              null;
            const apiShares =
              parseFloat(actualPosition.size) ||
              parseFloat(actualPosition.shares) ||
              parseFloat(actualPosition.amount) ||
              null;

            if (apiAvgPrice && apiAvgPrice > 0) {
              actualEntryPrice = apiAvgPrice;
              logToFile("INFO", "Updated entry price from actual position", {
                tokenId: tokenId.substring(0, 10) + "...",
                orderbookPrice: orderPrice,
                actualEntryPrice: actualEntryPrice,
                difference:
                  ((actualEntryPrice - orderPrice) * 100).toFixed(2) + "¢",
              });
            }

            if (apiShares && apiShares > 0) {
              actualShares = apiShares;
            }
          } else {
            logToFile(
              "WARN",
              "Could not find position in API to get actual entry price",
              {
                tokenId: tokenId.substring(0, 10) + "...",
                usingOrderbookPrice: orderPrice,
              }
            );
          }
        } catch (error) {
          logToFile("WARN", "Failed to fetch actual position for entry price", {
            tokenId: tokenId.substring(0, 10) + "...",
            error: error.message,
            usingOrderbookPrice: orderPrice,
          });
        }

        const buyEmbed = discordEmbeds.createBuyOrderEmbed({
          isPaperTrading: false,
          isMarketOrder: true,
          orderValue,
          orderSize: actualShares,
          orderPrice: "market price",
          entryPrice: actualEntryPrice,
          market: title || slug || "Unknown market",
          outcome,
          confidenceLevel,
          tradePrice,
          trackedTradeSize,
          isHighConfidenceAdd,
          isOptimalConfidenceRange,
          positionInfo:
            positionCheck.allowed &&
            positionCheck.currentPositions !== undefined
              ? {
                  positionsAfter: positionCheck.currentPositions + 1,
                  maxPositions: require("../../config").MAX_POSITIONS,
                  exposureAfter: positionCheck.newTotalExposure,
                  maxExposure: require("../../config").MAX_TOTAL_EXPOSURE_USD,
                }
              : null,
        });

        await activeChannel.send({ embeds: [buyEmbed] });

        logTradeToFile("INFO", "BUY order executed successfully", {
          tokenId: tokenId.substring(0, 15) + "...",
          conditionId: conditionId?.substring(0, 15) + "..." || null,
          market: title || slug || "Unknown",
          outcome,
          orderValue,
          orderSize,
          entryPrice: actualEntryPrice,
          orderId: orderResponse?.orderId || orderResponse?.id || null,
          confidenceLevel,
          isHighConfidenceAdd,
          isOptimalConfidenceRange,
        });

        if (
          STOP_LOSS_ENABLED &&
          !PAPER_TRADING_ENABLED &&
          orderbookWS &&
          conditionId
        ) {
          await setupStopLoss(
            tokenId,
            conditionId,
            actualEntryPrice,
            actualShares,
            title,
            slug,
            outcome,
            orderbookWS
          );
        }

        return { success: true, orderResponse };
      }
    }
  } else {
    // Limit order logic would go here (similar structure)
    // This is a simplified version - the full limit order logic is very similar
    return {
      success: false,
      error: "Limit orders not fully implemented in autoTrader module yet",
    };
  }

  return { success: false, error: "Unknown error" };
}

async function setupStopLoss(
  tokenId,
  conditionId,
  orderPrice,
  orderSize,
  title,
  slug,
  outcome,
  orderbookWS
) {
  const shouldMonitor =
    STOP_LOSS_WEBSOCKET_MARKET_FILTER.length === 0 ||
    STOP_LOSS_WEBSOCKET_MARKET_FILTER.some((filter) => {
      if (filter.startsWith("0x") && conditionId) {
        return conditionId.toLowerCase() === filter.toLowerCase();
      }
      const keyword = filter.toLowerCase();
      return (
        (title && title.toLowerCase().includes(keyword)) ||
        (slug && slug.toLowerCase().includes(keyword))
      );
    });

  if (!shouldMonitor) {
    logToFile(
      "INFO",
      "Trade does not match stop-loss websocket filter - skipping websocket subscription",
      {
        tokenId: tokenId.substring(0, 15) + "...",
        conditionId: conditionId?.substring(0, 15) + "..." || null,
        market: title || slug || "Unknown",
        filter:
          STOP_LOSS_WEBSOCKET_MARKET_FILTER.join(", ") ||
          "empty (monitoring all)",
      }
    );
    return;
  }

  if (shouldMonitor) {
    try {
      const stopLossPrice = orderPrice * (1 - STOP_LOSS_PERCENTAGE / 100);
      const allPositions = getAllStopLossPositions();
      const marketTypeMatch = (title || slug || "").match(/^([^-]+)/);
      const marketType = marketTypeMatch ? marketTypeMatch[1].trim() : null;

      if (marketType) {
        for (const [oldTokenId, oldPosition] of allPositions.entries()) {
          if (
            oldPosition.conditionId &&
            oldPosition.conditionId !== conditionId &&
            oldPosition.market &&
            oldPosition.market.includes(marketType)
          ) {
            logToFile(
              "INFO",
              "Cleaning up old hourly event subscription - new event started",
              {
                oldTokenId: oldTokenId.substring(0, 10) + "...",
                oldConditionId:
                  oldPosition.conditionId.substring(0, 10) + "...",
                newConditionId: conditionId.substring(0, 10) + "...",
                marketType,
              }
            );
            orderbookWS.unsubscribe(oldTokenId);
            deleteStopLossPosition(oldTokenId);
          }
        }
      }

      setStopLossPosition(tokenId, orderPrice, orderSize, stopLossPrice, {
        market: title || slug || "Unknown",
        conditionId: conditionId || null,
        outcome: outcome || null,
      });

      if (orderbookWS) {
        orderbookWS.subscribe(tokenId);
      }

      logToFile(
        "INFO",
        "Position registered for WebSocket stop-loss monitoring",
        {
          tokenId: tokenId.substring(0, 10) + "...",
          market: title || slug,
          entryPrice: orderPrice,
          shares: orderSize,
          stopLossPrice,
          filter: STOP_LOSS_WEBSOCKET_MARKET_FILTER.join(", "),
        }
      );
    } catch (error) {
      logToFile("ERROR", "Failed to setup stop-loss", {
        error: error.message,
        stack: error.stack,
      });
    }
  }
}

async function processAutoTrade(
  trade,
  clobClient,
  clobClientReady,
  orderbookWS,
  activeChannel,
  currentWallet
) {
  const {
    conditionId,
    asset,
    price,
    side,
    title,
    slug,
    outcome,
    orderType,
    fillType,
    isMarketOrder,
    marketOrder,
  } = trade;

  const tokenId = asset || conditionId;
  const tradeSide = String(side).toUpperCase();
  const orderPrice = price;
  const tradePrice = price || 0;
  const trackedTradeSize = trade.usdcSize || 0;

  if (!tokenId) {
    await activeChannel.send({
      embeds: [
        discordEmbeds.createErrorEmbed(
          "⚠️ Cannot Auto-trade",
          "No token ID found in trade data. Skipping trade.",
          []
        ),
      ],
    });
    return { success: false, error: "No tokenId" };
  }

  if (!orderPrice || orderPrice <= 0) {
    await activeChannel.send({
      embeds: [
        discordEmbeds.createErrorEmbed(
          "⚠️ Cannot Auto-trade",
          `Invalid price (${orderPrice}). Skipping trade.`,
          []
        ),
      ],
    });
    return { success: false, error: "Invalid price" };
  }

  let detectedOrderType = "UNKNOWN";
  if (orderType) {
    detectedOrderType = String(orderType).toUpperCase();
  } else if (fillType) {
    detectedOrderType = String(fillType).toUpperCase();
  } else if (isMarketOrder !== undefined) {
    detectedOrderType = isMarketOrder ? "MARKET" : "LIMIT";
  } else if (marketOrder !== undefined) {
    detectedOrderType = marketOrder ? "MARKET" : "LIMIT";
  }

  const paperTradingState = getPaperTradingState();
  const isOptimalConfidenceRange =
    tradeProcessor.isOptimalConfidenceRange(tradePrice);
  const isHighConfidenceAdd =
    ADD_HIGH_CONFIDENCE_ENABLED &&
    tradePrice >= ADD_HIGH_CONFIDENCE_MIN &&
    tradePrice <= ADD_HIGH_CONFIDENCE_MAX;

  if (tradeSide === "BUY" && !isHighConfidenceAdd) {
    if (hasInitialTradeBeenPlaced(tokenId)) {
      await activeChannel.send({
        embeds: [
          discordEmbeds.createAutoTradeSkippedEmbed(
            "Already placed initial trade for this market. Skipping 60-80% trade to leave room for high-confidence add (80-90%+).",
            "",
            [
              {
                name: "Market",
                value: title || slug || "Unknown",
                inline: false,
              },
              { name: "Outcome", value: outcome || "Unknown", inline: true },
              {
                name: "Trade Confidence",
                value: `${(tradePrice * 100).toFixed(1)}%`,
                inline: true,
              },
            ]
          ),
        ],
      });
      return {
        success: false,
        skipped: true,
        reason: "initial_trade_already_placed",
      };
    }
  }

  let orderSize = 0;
  let orderValue = 0;
  let confidenceLevel = "MEDIUM";

  if (tradeSide === "BUY") {
    const buyResult = await calculateBuyOrderSize(
      trade,
      tokenId,
      orderPrice,
      paperTradingState
    );
    if (buyResult.skipped) {
      await activeChannel.send({ embeds: [buyResult.embed] });
      return { success: false, skipped: true, reason: buyResult.reason };
    }
    orderSize = buyResult.orderSize;
    orderValue = buyResult.orderValue;
    confidenceLevel = buyResult.confidenceLevel;
  } else if (tradeSide === "SELL") {
    const sellResult = await calculateSellOrderSize(
      trade,
      tokenId,
      orderPrice,
      currentWallet
    );
    if (sellResult.skipped) {
      await activeChannel.send({ embeds: [sellResult.embed] });
      return { success: false, skipped: true, reason: sellResult.reason };
    }
    orderSize = sellResult.orderSize;
    orderValue = sellResult.orderValue;
  }

  const adjustResult = await checkAndAdjustOrderSize(
    trade,
    tokenId,
    orderSize,
    orderValue,
    orderPrice,
    tradeSide,
    isHighConfidenceAdd,
    paperTradingState
  );

  if (adjustResult.skipped) {
    await activeChannel.send({ embeds: [adjustResult.embed] });
    return { success: false, skipped: true };
  }

  if (adjustResult.adjusted) {
    orderSize = adjustResult.orderSize;
    orderValue = adjustResult.orderValue;
    if (adjustResult.embed) {
      await activeChannel.send({ embeds: [adjustResult.embed] });
    }
  }

  orderSize = Math.round(orderSize * 100) / 100;
  orderValue = orderSize * orderPrice;

  if (isHighConfidenceAdd && orderValue === 0) {
    logToFile(
      "INFO",
      "High-confidence add skipped: No room for minimum order",
      {
        conditionId,
        market: title || slug,
        outcome,
        tradePrice: tradePrice * 100,
      }
    );
    return { success: false, skipped: true, reason: "no_room_for_min_order" };
  }

  const positionCheck = await checkPositionLimits(
    orderValue,
    tradeSide,
    tokenId
  );
  if (!positionCheck.allowed) {
    const limitEmbed = {
      title: "⏸️ Auto-trade Skipped",
      description: positionCheck.message,
      color: 0xffaa00,
      fields: [],
      timestamp: new Date().toISOString(),
    };

    if (positionCheck.reason === "position_count") {
      limitEmbed.fields.push(
        {
          name: "Current Positions",
          value: `${positionCheck.currentPositions}/${positionCheck.maxPositions}`,
          inline: true,
        },
        {
          name: "Proposed Trade",
          value: `$${orderValue.toFixed(2)}`,
          inline: true,
        }
      );
    } else if (positionCheck.reason === "total_exposure") {
      limitEmbed.fields.push(
        {
          name: "Current Exposure",
          value: `$${positionCheck.currentExposure.toFixed(2)}`,
          inline: true,
        },
        {
          name: "Proposed Trade",
          value: `$${orderValue.toFixed(2)}`,
          inline: true,
        },
        {
          name: "Would Exceed Limit",
          value: `$${positionCheck.newTotalExposure.toFixed(
            2
          )} > $${positionCheck.maxExposure.toFixed(2)}`,
          inline: false,
        }
      );
    } else if (positionCheck.reason === "per_market_cap") {
      limitEmbed.fields.push(
        {
          name: "Current Position Value",
          value: `$${positionCheck.currentPositionValue.toFixed(2)}`,
          inline: true,
        },
        {
          name: "Proposed Trade",
          value: `$${orderValue.toFixed(2)}`,
          inline: true,
        },
        {
          name: "Would Exceed Limit",
          value: `$${positionCheck.newPositionValue.toFixed(
            2
          )} > $${positionCheck.maxBetAmount.toFixed(2)}`,
          inline: false,
        }
      );
    }

    await activeChannel.send({ embeds: [limitEmbed] });
    return { success: false, skipped: true, reason: positionCheck.reason };
  }

  if (tradeSide === "BUY") {
    return await placeBuyOrderAuto(
      trade,
      tokenId,
      orderSize,
      orderValue,
      orderPrice,
      confidenceLevel,
      isHighConfidenceAdd,
      isOptimalConfidenceRange,
      detectedOrderType,
      clobClient,
      clobClientReady,
      orderbookWS,
      activeChannel,
      positionCheck
    );
  } else if (tradeSide === "SELL") {
    return await placeSellOrderAuto(
      trade,
      tokenId,
      orderSize,
      orderValue,
      orderPrice,
      detectedOrderType,
      clobClient,
      clobClientReady,
      orderbookWS,
      activeChannel,
      positionCheck
    );
  }

  return { success: false, error: "Unknown trade side" };
}

async function placeSellOrderAuto(
  trade,
  tokenId,
  orderSize,
  orderValue,
  orderPrice,
  detectedOrderType,
  clobClient,
  clobClientReady,
  orderbookWS,
  activeChannel,
  positionCheck
) {
  const { title, slug, conditionId, outcome } = trade;
  const useMarketOrder =
    AUTO_TRADE_USE_MARKET || detectedOrderType === "MARKET";
  const paperTradingState = getPaperTradingState();

  if (useMarketOrder) {
    if (PAPER_TRADING_ENABLED) {
      const paperResult = await paperSell(
        tokenId,
        orderSize,
        orderPrice,
        title || slug || "Unknown"
      );

      if (paperResult && paperResult.error) {
        await activeChannel.send({
          embeds: [
            discordEmbeds.createErrorEmbed(
              "❌ Paper Trade FAILED",
              paperResult.error,
              [{ name: "Mode", value: "📝 Paper Trading", inline: true }]
            ),
          ],
        });
        return { success: false, error: paperResult.error };
      }

      if (paperResult && paperResult.success) {
        deleteTrackedPosition(tokenId);
        const sellEmbed = discordEmbeds.createSellOrderEmbed({
          isPaperTrading: true,
          isMarketOrder: true,
          orderValue,
          orderSize,
          orderPrice: "market price",
          market: title || slug || "Unknown market",
          outcome,
          pnl: paperResult.pnl,
          paperBalance: paperResult.balance,
          positionInfo:
            positionCheck.allowed &&
            positionCheck.currentPositions !== undefined
              ? {
                  positionsAfter: Math.max(
                    0,
                    positionCheck.currentPositions - 1
                  ),
                  maxPositions: require("../../config").MAX_POSITIONS,
                }
              : null,
        });

        await activeChannel.send({ embeds: [sellEmbed] });

        logTradeToFile(
          "INFO",
          "SELL order executed successfully (Paper Trading)",
          {
            tokenId: tokenId.substring(0, 15) + "...",
            conditionId: conditionId?.substring(0, 15) + "..." || null,
            market: title || slug || "Unknown",
            outcome,
            orderValue,
            orderSize,
            exitPrice: orderPrice,
            pnl: paperResult.pnl,
            paperBalance: paperResult.balance,
          }
        );

        return { success: true, paperResult };
      }
    } else {
      const orderResponse = await placeMarketSellOrder(
        tokenId,
        orderSize,
        orderPrice,
        clobClient,
        clobClientReady,
        orderbookWS,
        null,
        null
      );

      if (orderResponse && orderResponse.error) {
        const errorMsg = orderResponse.error;
        let embed;
        if (errorMsg.includes("balance") || errorMsg.includes("allowance")) {
          embed = discordEmbeds.createErrorEmbed(
            "❌ Auto-trade SELL FAILED",
            errorMsg,
            [
              {
                name: "Note",
                value:
                  "For SELL orders, you need to own the shares (tokens) you're trying to sell.\n\nYou don't have enough shares of this token to place a SELL order. Auto-trading SELL orders is skipped when you don't own the shares.",
                inline: false,
              },
            ]
          );
          logToFile(
            "WARN",
            "Skipping SELL auto-trade - user doesn't own enough shares",
            {
              tokenId,
              orderSize,
              orderPrice,
              error: errorMsg,
            }
          );
        } else {
          embed = discordEmbeds.createErrorEmbed(
            "❌ Auto-placed MARKET SELL Order FAILED",
            errorMsg,
            []
          );
        }
        await activeChannel.send({ embeds: [embed] });
        return { success: false, error: errorMsg };
      } else if (orderResponse && orderResponse.success !== false) {
        deleteTrackedPosition(tokenId);
        const sellEmbed = discordEmbeds.createSellOrderEmbed({
          isPaperTrading: false,
          isMarketOrder: true,
          orderValue,
          orderSize,
          orderPrice: "market price",
          market: title || slug || "Unknown market",
          outcome,
          positionInfo:
            positionCheck.allowed &&
            positionCheck.currentPositions !== undefined
              ? {
                  positionsAfter: Math.max(
                    0,
                    positionCheck.currentPositions - 1
                  ),
                  maxPositions: require("../../config").MAX_POSITIONS,
                  exposureAfter: positionCheck.currentExposure
                    ? Math.max(0, positionCheck.currentExposure - orderValue)
                    : undefined,
                  maxExposure: require("../../config").MAX_TOTAL_EXPOSURE_USD,
                }
              : null,
        });

        await activeChannel.send({ embeds: [sellEmbed] });

        logTradeToFile("INFO", "SELL order executed successfully", {
          tokenId: tokenId.substring(0, 15) + "...",
          conditionId: conditionId?.substring(0, 15) + "..." || null,
          market: title || slug || "Unknown",
          outcome,
          orderValue,
          orderSize,
          exitPrice: orderPrice,
          orderId: orderResponse?.orderId || orderResponse?.id || null,
        });

        return { success: true, orderResponse };
      } else {
        deleteTrackedPosition(tokenId);
        const sellEmbed = discordEmbeds.createSellOrderEmbed({
          isPaperTrading: false,
          isMarketOrder: true,
          orderValue,
          orderSize,
          orderPrice: "market price",
          market: title || slug || "Unknown market",
          outcome,
          positionInfo:
            positionCheck.allowed &&
            positionCheck.currentPositions !== undefined
              ? {
                  positionsAfter: Math.max(
                    0,
                    positionCheck.currentPositions - 1
                  ),
                  maxPositions: require("../../config").MAX_POSITIONS,
                  exposureAfter: positionCheck.currentExposure
                    ? Math.max(0, positionCheck.currentExposure - orderValue)
                    : undefined,
                  maxExposure: require("../../config").MAX_TOTAL_EXPOSURE_USD,
                }
              : null,
        });

        await activeChannel.send({ embeds: [sellEmbed] });

        logTradeToFile("INFO", "SELL order executed successfully", {
          tokenId: tokenId.substring(0, 15) + "...",
          conditionId: conditionId?.substring(0, 15) + "..." || null,
          market: title || slug || "Unknown",
          outcome,
          orderValue,
          orderSize,
          exitPrice: orderPrice,
          orderId: orderResponse?.orderId || orderResponse?.id || null,
        });

        return { success: true };
      }
    }
  } else {
    return {
      success: false,
      error: "Limit SELL orders not fully implemented in autoTrader module yet",
    };
  }

  return { success: false, error: "Unknown error" };
}

module.exports = {
  processAutoTrade,
  calculateBuyOrderSize,
  calculateSellOrderSize,
  checkAndAdjustOrderSize,
  placeBuyOrderAuto,
  placeSellOrderAuto,
  setupStopLoss,
};

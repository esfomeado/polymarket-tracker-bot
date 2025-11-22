const fetch = require("node-fetch");
const {
  PAPER_TRADING_ENABLED,
  MAX_POSITIONS,
  MAX_TOTAL_EXPOSURE_USD,
  POLYMARKET_FUNDER,
} = require("../config");
const { logToFile } = require("../utils/logger");
const { getPaperTradingBalance } = require("./paperTrading");

let trackedPositions = new Map();
let clobClient = null;
let clobClientReady = false;
let signer = null;
let currentWallet = null;

function setClobClient(client, ready) {
  clobClient = client;
  clobClientReady = ready;
}

function setSigner(signerInstance) {
  signer = signerInstance;
}

function setCurrentWallet(wallet) {
  currentWallet = wallet;
}

function getTrackedPositions() {
  return trackedPositions;
}

function setTrackedPosition(tokenId, data) {
  trackedPositions.set(tokenId, data);
}

function deleteTrackedPosition(tokenId) {
  trackedPositions.delete(tokenId);
}

async function getCurrentPositions() {
  try {
    if (clobClient && clobClientReady) {
      try {
        if (typeof clobClient.getPositions === "function") {
          const positions = await clobClient.getPositions();
          if (Array.isArray(positions)) {
            logToFile("INFO", "Fetched positions from CLOB API", {
              count: positions.length,
            });
            return positions;
          }
        }
      } catch (error) {
        logToFile("WARN", "Could not fetch positions from CLOB API", {
          error: error.message,
        });
      }

      try {
        const walletAddress =
          POLYMARKET_FUNDER || signer?.address || currentWallet;
        if (walletAddress) {
          const positionsUrl = `https://data-api.polymarket.com/positions?user=${walletAddress}`;
          const response = await fetch(positionsUrl, {
            headers: {
              accept: "application/json",
            },
          });

          if (response.ok) {
            const positions = await response.json();
            if (Array.isArray(positions)) {
              logToFile("INFO", "Fetched positions from Data API", {
                count: positions.length,
              });
              return positions;
            }
          }
        }
      } catch (error) {
        logToFile("WARN", "Could not fetch positions from Data API", {
          error: error.message,
        });
      }
    }

    const positions = [];
    for (const [tokenId, data] of trackedPositions.entries()) {
      positions.push({
        token_id: tokenId,
        usdc_value: data.usdcValue,
        timestamp: data.timestamp,
      });
    }
    logToFile("INFO", "Using tracked positions (fallback)", {
      count: positions.length,
    });
    return positions;
  } catch (error) {
    logToFile("ERROR", "Failed to get current positions", {
      error: error.message,
    });
    return [];
  }
}

async function getPositionValueForToken(tokenId) {
  try {
    const trackedPosition = trackedPositions.get(tokenId);
    if (trackedPosition) {
      return trackedPosition.usdcValue || 0;
    }

    const positions = await getCurrentPositions();
    for (const pos of positions) {
      const posTokenId = pos.token_id || pos.conditionId || pos.tokenID;
      if (posTokenId === tokenId) {
        const value =
          pos.usdc_value || pos.usdcValue || pos.value || pos.cost || 0;
        return typeof value === "number" && value > 0 ? value : 0;
      }
    }

    return 0;
  } catch (error) {
    logToFile("ERROR", "Failed to get position value for token", {
      tokenId,
      error: error.message,
    });
    return 0;
  }
}

async function checkPositionLimits(proposedTradeValue, tradeSide = "BUY") {
  if (PAPER_TRADING_ENABLED) {
    const paperBalance = getPaperTradingBalance();
    const positionCount = paperBalance.totalPositions;
    const totalExposure = paperBalance.totalExposure;

    const newTotalExposure =
      tradeSide === "SELL"
        ? Math.max(0, totalExposure - proposedTradeValue)
        : totalExposure + proposedTradeValue;

    if (tradeSide === "BUY" && positionCount >= MAX_POSITIONS) {
      return {
        allowed: false,
        reason: "position_count",
        currentPositions: positionCount,
        maxPositions: MAX_POSITIONS,
        message: `Maximum position limit reached: ${positionCount}/${MAX_POSITIONS} positions open (Paper Trading).`,
      };
    }

    if (MAX_TOTAL_EXPOSURE_USD > 0) {
      if (tradeSide === "BUY" && newTotalExposure > MAX_TOTAL_EXPOSURE_USD) {
        return {
          allowed: false,
          reason: "total_exposure",
          currentExposure: totalExposure,
          proposedTradeValue,
          newTotalExposure,
          maxExposure: MAX_TOTAL_EXPOSURE_USD,
          message: `Total exposure limit would be exceeded: $${newTotalExposure.toFixed(
            2
          )} > $${MAX_TOTAL_EXPOSURE_USD.toFixed(
            2
          )} (Current: $${totalExposure.toFixed(2)}). Paper Trading.`,
        };
      }
    }

    return {
      allowed: true,
      currentPositions: positionCount,
      currentExposure: totalExposure,
      newTotalExposure,
    };
  }

  const positions = await getCurrentPositions();

  const uniquePositions = new Set();
  let totalExposure = 0;

  for (const pos of positions) {
    const tokenId = pos.token_id || pos.conditionId || pos.tokenID;
    if (tokenId) {
      uniquePositions.add(tokenId);
      const value =
        pos.usdc_value ||
        pos.usdcValue ||
        pos.value ||
        pos.cost ||
        proposedTradeValue;
      if (typeof value === "number" && value > 0) {
        totalExposure += value;
      }
    }
  }

  const positionCount = uniquePositions.size;

  const newTotalExposure =
    tradeSide === "SELL"
      ? Math.max(0, totalExposure - proposedTradeValue)
      : totalExposure + proposedTradeValue;

  if (tradeSide === "BUY" && positionCount >= MAX_POSITIONS) {
    return {
      allowed: false,
      reason: "position_count",
      currentPositions: positionCount,
      maxPositions: MAX_POSITIONS,
      message: `Maximum position limit reached: ${positionCount}/${MAX_POSITIONS} positions open.`,
    };
  }

  if (MAX_TOTAL_EXPOSURE_USD > 0) {
    if (tradeSide === "BUY" && newTotalExposure > MAX_TOTAL_EXPOSURE_USD) {
      return {
        allowed: false,
        reason: "total_exposure",
        currentExposure: totalExposure,
        proposedTradeValue,
        newTotalExposure,
        maxExposure: MAX_TOTAL_EXPOSURE_USD,
        message: `Total exposure limit would be exceeded: $${newTotalExposure.toFixed(
          2
        )} > $${MAX_TOTAL_EXPOSURE_USD.toFixed(
          2
        )} (Current: $${totalExposure.toFixed(2)}).`,
      };
    }
  }

  return {
    allowed: true,
    currentPositions: positionCount,
    currentExposure: totalExposure,
    newTotalExposure,
  };
}

module.exports = {
  getCurrentPositions,
  getPositionValueForToken,
  checkPositionLimits,
  getTrackedPositions,
  setTrackedPosition,
  deleteTrackedPosition,
  setClobClient,
  setSigner,
  setCurrentWallet,
};

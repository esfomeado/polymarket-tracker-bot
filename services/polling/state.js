let isPolling = false;
let pollTimeout = null;
let activeChannel = null;
let currentWallet = null;
let isInitialized = false;
const seenHashes = new Set();

function getPollingState() {
  return {
    isPolling,
    pollTimeout,
    activeChannel,
    currentWallet,
    isInitialized,
    seenHashes: new Set(seenHashes),
  };
}

function setPollingState(state) {
  isPolling = state.isPolling;
  pollTimeout = state.pollTimeout;
  activeChannel = state.activeChannel;
  currentWallet = state.currentWallet;
  isInitialized = state.isInitialized;
  if (state.seenHashes) {
    seenHashes.clear();
    state.seenHashes.forEach((hash) => seenHashes.add(hash));
  }
}

function clearPollTimeout() {
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
}

function setPollTimeout(timeout) {
  pollTimeout = timeout;
}

function getActiveChannel() {
  return activeChannel;
}

function setActiveChannel(channel) {
  activeChannel = channel;
}

function getCurrentWallet() {
  return currentWallet;
}

function setCurrentWallet(wallet) {
  currentWallet = wallet;
}

function getIsPolling() {
  return isPolling;
}

function setIsPolling(value) {
  isPolling = value;
}

function getIsInitialized() {
  return isInitialized;
}

function setIsInitialized(value) {
  isInitialized = value;
}

function hasSeenHash(hash) {
  return seenHashes.has(hash);
}

function addSeenHash(hash) {
  seenHashes.add(hash);
}

function clearSeenHashes() {
  seenHashes.clear();
}

module.exports = {
  getPollingState,
  setPollingState,
  clearPollTimeout,
  setPollTimeout,
  getActiveChannel,
  setActiveChannel,
  getCurrentWallet,
  setCurrentWallet,
  getIsPolling,
  setIsPolling,
  getIsInitialized,
  setIsInitialized,
  hasSeenHash,
  addSeenHash,
  clearSeenHashes,
};

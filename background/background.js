// Background Service Worker for GPT Ad Inspector and Debugger
// Handles extension installation lifecycle events

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.log("GPT Ad Inspector and Debugger by Monetiscope installed successfully.");
    
    // Initialize standard storage values
    chrome.storage.local.set({
      install_timestamp: Date.now(),
      highlight_enabled: false
    });
  }
});

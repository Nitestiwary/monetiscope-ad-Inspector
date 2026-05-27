// Monetiscope GPT Ad Inspector - Content Script
// Runs in the isolated extension environment. Manages main-world injection, page events aggregation,
// page overlay highlights, and communications with the extension popup.

(function() {
  if (window.__monetiscope_content_loaded) return;
  window.__monetiscope_content_loaded = true;

  console.log("Monetiscope Ad Inspector: Content script loaded.");

  // Cached page state
  const pageState = {
    gptLoaded: false,
    sraEnabled: false,
    lazyLoadEnabled: false,
    lazyLoadOptions: null,
    collapseEmptyDivsEnabled: false,
    collapseBeforeAdFetch: false,
    slots: [],
    events: [],
    refreshHistory: {}
  };

  let highlightsEnabled = false;
  let activeOverlays = [];

  // 1. Inject inject.js into the MAIN world
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/inject.js');
    script.onload = function() {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  } catch (e) {
    console.error("Monetiscope Ad Inspector: Script injection failed", e);
  }

  // 2. Listen for messages from inject.js in the page context
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'monetiscope-inject') return;

    const { type, detail } = event.data;

    switch (type) {
      case 'state_scan':
        // Synchronize settings and basic slot structure
        pageState.gptLoaded = detail.gptLoaded;
        pageState.sraEnabled = detail.sraEnabled;
        pageState.lazyLoadEnabled = detail.lazyLoadEnabled;
        pageState.lazyLoadOptions = detail.lazyLoadOptions;
        pageState.collapseEmptyDivsEnabled = detail.collapseEmptyDivsEnabled;
        pageState.collapseBeforeAdFetch = detail.collapseBeforeAdFetch;
        
        // Merge slots carefully preserving existing render metadata
        if (detail.slots) {
          detail.slots.forEach(newSlot => {
            const existing = pageState.slots.find(s => s.slotId === newSlot.slotId);
            if (existing) {
              Object.assign(existing, newSlot);
            } else {
              pageState.slots.push({
                ...newSlot,
                renderedSize: null,
                isEmpty: null
              });
            }
          });
        }
        break;

      case 'settings_changed':
        Object.assign(pageState, detail);
        break;

      case 'slot_refreshed':
        pageState.refreshHistory = detail.history;
        pageState.events.push({
          id: generateUniqueId(),
          type: 'Refreshed',
          timestamp: detail.timestamp,
          slotIds: detail.slotIds,
          message: `Slots refreshed: [${detail.slotIds.join(', ')}]`
        });
        
        // Mark slot states as refreshing or clear empty status until render end
        detail.slotIds.forEach(id => {
          const slot = pageState.slots.find(s => s.slotId === id);
          if (slot) {
            slot.isRefreshing = true;
          }
        });
        
        if (highlightsEnabled) {
          setTimeout(updateHighlights, 300);
        }
        break;

      case 'slotRenderEnded':
        pageState.events.push({
          id: generateUniqueId(),
          type: 'Render Ended',
          timestamp: detail.timestamp,
          slotId: detail.slotId,
          isEmpty: detail.isEmpty,
          size: detail.size,
          message: `Render ended: ${detail.slotId} → Size: ${detail.size} (${detail.isEmpty ? 'EMPTY' : 'FILLED'})`
        });

        // Update slot render details
        const renderedSlot = pageState.slots.find(s => s.slotId === detail.slotId);
        if (renderedSlot) {
          renderedSlot.renderedSize = detail.size;
          renderedSlot.isEmpty = detail.isEmpty;
          renderedSlot.creativeId = detail.creativeId;
          renderedSlot.lineItemId = detail.lineItemId;
          renderedSlot.advertiserId = detail.advertiserId;
          renderedSlot.campaignId = detail.campaignId;
          renderedSlot.isRefreshing = false;
        } else {
          pageState.slots.push({
            slotId: detail.slotId,
            adUnitPath: detail.adUnitPath,
            configuredSizes: [detail.size],
            renderedSize: detail.size,
            isEmpty: detail.isEmpty,
            creativeId: detail.creativeId,
            lineItemId: detail.lineItemId,
            advertiserId: detail.advertiserId,
            campaignId: detail.campaignId,
            isRefreshing: false
          });
        }
        
        if (highlightsEnabled) {
          setTimeout(updateHighlights, 200);
        }
        break;

      case 'impressionViewable':
        pageState.events.push({
          id: generateUniqueId(),
          type: 'Viewable',
          timestamp: detail.timestamp,
          slotId: detail.slotId,
          message: `Impression became viewable: ${detail.slotId}`
        });
        break;

      case 'slotRequested':
        pageState.events.push({
          id: generateUniqueId(),
          type: 'Requested',
          timestamp: detail.timestamp,
          slotId: detail.slotId,
          message: `Request sent for slot: ${detail.slotId}`
        });
        break;

      case 'slotResponseReceived':
        pageState.events.push({
          id: generateUniqueId(),
          type: 'Response Recv',
          timestamp: detail.timestamp,
          slotId: detail.slotId,
          message: `Response received for slot: ${detail.slotId}`
        });
        break;

      case 'slotVisibilityChanged':
        // Silently capture visibility updates in the slots data
        const visSlot = pageState.slots.find(s => s.slotId === detail.slotId);
        if (visSlot) {
          visSlot.inViewPercentage = detail.inViewPercentage;
        }
        break;
    }
  });

  // Helper to generate unique event IDs
  function generateUniqueId() {
    return 'evt_' + Math.random().toString(36).substr(2, 9);
  }

  // 3. Listen for requests from extension popup
  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.type === 'GET_AD_DATA') {
      // Trigger a passive fresh scan at main world
      window.postMessage({ source: 'monetiscope-content', type: 'SCAN_REQUEST' }, '*');
      
      // Compute ad density, floating counts, policy warnings on the fly
      const scanResults = runAdDensityDiagnostics();
      const payload = {
        ...pageState,
        diagnostics: scanResults
      };
      
      sendResponse(payload);
    } else if (request.type === 'TOGGLE_HIGHLIGHTS') {
      highlightsEnabled = request.enabled;
      updateHighlights();
      sendResponse({ success: true, enabled: highlightsEnabled });
    }
    return true;
  });

  // Reposition overlays on scroll or resize
  window.addEventListener('scroll', function() {
    if (highlightsEnabled) {
      repositionOverlays();
    }
  }, { passive: true });

  window.addEventListener('resize', function() {
    if (highlightsEnabled) {
      updateHighlights();
    }
  }, { passive: true });

  // 4. Highlight Overlay Implementation
  function clearOverlays() {
    activeOverlays.forEach(overlay => {
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    });
    activeOverlays = [];
  }

  function updateHighlights() {
    clearOverlays();
    if (!highlightsEnabled) return;

    pageState.slots.forEach(slot => {
      const container = document.getElementById(slot.slotId);
      if (!container) return;

      const rect = container.getBoundingClientRect();
      // Skip hidden/collapsed slots unless we explicitly want to inspect them
      if (rect.width === 0 && rect.height === 0) return;

      // Determine highlight style
      let colorClass = 'monetiscope-empty'; // Red
      let labelText = 'EMPTY';
      let borderStyle = '2px dashed #EF4444';
      let bgStyle = 'rgba(239, 68, 68, 0.08)';
      let labelBg = '#EF4444';

      if (slot.isEmpty === false) {
        colorClass = 'monetiscope-filled'; // Green
        labelText = slot.renderedSize || 'FILLED';
        borderStyle = '2px dashed #10B981';
        bgStyle = 'rgba(16, 185, 129, 0.08)';
        labelBg = '#10B981';
      }

      // Check if slot is sticky/out-of-page
      const computedStyle = window.getComputedStyle(container);
      const isSticky = computedStyle.position === 'fixed' || computedStyle.position === 'sticky' || slot.isAnchor;
      if (isSticky) {
        labelText += ' (Sticky)';
        borderStyle = '2px dashed #3B82F6'; // Blue
        bgStyle = 'rgba(59, 130, 246, 0.1)';
        labelBg = '#3B82F6';
      }

      // Create overlay element
      const overlay = document.createElement('div');
      overlay.id = `monetiscope-overlay-${slot.slotId}`;
      overlay.style.position = 'absolute';
      overlay.style.boxSizing = 'border-box';
      overlay.style.border = borderStyle;
      overlay.style.backgroundColor = bgStyle;
      overlay.style.pointerEvents = 'none'; // Click-through
      overlay.style.zIndex = '999999999';
      overlay.style.transition = 'all 0.15s ease-out';
      overlay.style.borderRadius = '4px';

      // Small details badge inside overlay
      const label = document.createElement('div');
      label.style.position = 'absolute';
      label.style.top = '-20px';
      label.style.left = '0';
      label.style.backgroundColor = labelBg;
      label.style.color = '#FFFFFF';
      label.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      label.style.fontSize = '10px';
      label.style.fontWeight = 'bold';
      label.style.padding = '2px 6px';
      label.style.borderRadius = '3px';
      label.style.whiteSpace = 'nowrap';
      label.style.boxShadow = '0 2px 4px rgba(0,0,0,0.15)';
      label.innerText = `${slot.slotId} [${labelText}]`;

      overlay.appendChild(label);
      document.body.appendChild(overlay);
      activeOverlays.push(overlay);

      // Initial placement
      positionOverlay(overlay, container);
    });
  }

  function positionOverlay(overlay, container) {
    const rect = container.getBoundingClientRect();
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

    overlay.style.top = `${rect.top + scrollTop}px`;
    overlay.style.left = `${rect.left + scrollLeft}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  function repositionOverlays() {
    pageState.slots.forEach(slot => {
      const container = document.getElementById(slot.slotId);
      const overlay = document.getElementById(`monetiscope-overlay-${slot.slotId}`);
      if (container && overlay) {
        positionOverlay(overlay, container);
      }
    });
  }

  // 5. Diagnostics: Ad Density, Floating Ads & Policy Risks
  function runAdDensityDiagnostics() {
    const warnings = [];
    let totalAdAreaAboveFold = 0;
    let stickyCount = 0;
    let filledCount = 0;
    let emptyCount = 0;
    
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const totalViewportArea = viewportWidth * viewportHeight;

    pageState.slots.forEach(slot => {
      if (slot.isEmpty === false) filledCount++;
      if (slot.isEmpty === true) emptyCount++;

      const el = document.getElementById(slot.slotId);
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;

      // 1. Detect Sticky / Floating elements
      const computedStyle = window.getComputedStyle(el);
      const isSticky = computedStyle.position === 'fixed' || computedStyle.position === 'sticky' || slot.isAnchor;
      
      if (isSticky && rect.width > 0 && rect.height > 0) {
        stickyCount++;
      }

      // 2. Compute area above fold (within viewport height bounds on start)
      if (rect.top >= 0 && rect.top < viewportHeight && rect.width > 0 && rect.height > 0) {
        totalAdAreaAboveFold += area;
      }

      // 3. Look for aggressive refreshes
      const history = pageState.refreshHistory[slot.slotId];
      if (history && history.length >= 2) {
        // Calculate last refresh interval
        const last = history[history.length - 1];
        const prev = history[history.length - 2];
        const intervalSec = (last - prev) / 1000;
        
        if (intervalSec < 20) {
          warnings.push({
            type: 'aggressive_refresh',
            slotId: slot.slotId,
            severity: 'critical',
            message: `Aggressive refresh rate detected on slot ${slot.slotId} (${intervalSec.toFixed(1)}s). Google policies require active refresh rates to be at least 30s.`
          });
        } else if (intervalSec < 30) {
          warnings.push({
            type: 'aggressive_refresh',
            slotId: slot.slotId,
            severity: 'warning',
            message: `Short refresh rate on slot ${slot.slotId} (${intervalSec.toFixed(1)}s). Consider spacing requests to improve viewability.`
          });
        }
      }
    });

    // 4. Above the fold density threshold (30% policy warning)
    const adDensityAboveFoldPercent = (totalAdAreaAboveFold / totalViewportArea) * 100;
    if (adDensityAboveFoldPercent > 35) {
      warnings.push({
        type: 'high_density',
        severity: 'critical',
        message: `High ad density above fold detected (${adDensityAboveFoldPercent.toFixed(1)}%). Viewport is highly crowded, creating policy risk (Google limit is roughly 30% area above fold).`
      });
    } else if (adDensityAboveFoldPercent > 25) {
      warnings.push({
        type: 'high_density',
        severity: 'warning',
        message: `Ad density above fold is moderately high (${adDensityAboveFoldPercent.toFixed(1)}%). Consider optimizing layout to improve user experience.`
      });
    }

    // 5. Too many sticky elements warning
    if (stickyCount > 2) {
      warnings.push({
        type: 'excessive_sticky',
        severity: 'critical',
        message: `Excessive sticky/anchor ads detected (${stickyCount} slots). Multiple floating units are highly disruptive and can lead to Smart Pricing/AdX suspensions.`
      });
    }

    return {
      adDensityAboveFoldPercent: adDensityAboveFoldPercent,
      stickyCount: stickyCount,
      filledCount: filledCount,
      emptyCount: emptyCount,
      warnings: warnings
    };
  }

})();

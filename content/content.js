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
      overlay.className = 'monetiscope-ad-overlay';
      overlay.style.position = 'absolute';
      overlay.style.boxSizing = 'border-box';
      overlay.style.border = borderStyle;
      overlay.style.backgroundColor = bgStyle;
      overlay.style.pointerEvents = 'none'; // Click-through for background overlay
      overlay.style.zIndex = '999999999';
      overlay.style.transition = 'opacity 0.15s ease-out';
      overlay.style.borderRadius = '4px';

      // 4a. Build Premium Floating Details Card (Pointer events = auto for interaction)
      const labelCard = document.createElement('div');
      labelCard.className = 'monetiscope-label-card';
      labelCard.style.position = 'absolute';
      labelCard.style.pointerEvents = 'auto'; // Re-enable clicks inside the card!
      labelCard.style.backgroundColor = '#1E293B'; // Slate 800
      labelCard.style.color = '#F1F5F9';
      labelCard.style.border = '1px solid rgba(255, 255, 255, 0.15)';
      labelCard.style.borderRadius = '6px';
      labelCard.style.padding = '8px 12px';
      labelCard.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
      labelCard.style.fontSize = '11px';
      labelCard.style.lineHeight = '1.4';
      labelCard.style.width = '310px';
      labelCard.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -2px rgba(0, 0, 0, 0.1)';
      labelCard.style.zIndex = '999999999';
      
      // Determine delivery method (Dynamic Allocation vs standard)
      let adSource = 'Google Ad Manager';
      if (slot.isEmpty === false) {
        const isLongId = slot.lineItemId && (!isNaN(slot.lineItemId) && Number(slot.lineItemId) > 1000000000);
        if (slot.lineItemId === 'dynamic' || isLongId) {
          adSource = 'Dynamic Allocation';
        }
      }

      // Extract Publisher Network Code and format path
      let networkCode = '';
      let formattedPath = slot.adUnitPath;
      const match = slot.adUnitPath.match(/^\/([^\/]+)(.*)$/);
      if (match) {
        networkCode = match[1];
        const cleanPath = match[2] ? match[2].substring(1) : '';
        formattedPath = `<span style="color:#94A3B8;">${networkCode} &gt;</span> <strong style="color:#F59E0B; font-weight:700;">${escapeHtml(cleanPath)}</strong>`;
      } else {
        formattedPath = `<strong style="color:#F59E0B; font-weight:700;">${escapeHtml(slot.adUnitPath)}</strong>`;
      }

      // Size metrics & filled indicators
      let badgeColor = '#EF4444'; // Red
      let statusText = 'Empty Slot';
      if (slot.isEmpty === false) {
        badgeColor = '#10B981'; // Green
        statusText = `Filled: ${slot.renderedSize || 'Rendered'}`;
      }

      // Clickable Creative and Line Item GAM Delivery Tool hyper-paths
      let deliveryToolsHtml = '';
      if (slot.isEmpty === false && slot.creativeId) {
        const GAM_URL = networkCode ? `https://admanager.google.com/${networkCode}#delivery` : 'https://admanager.google.com';
        deliveryToolsHtml = `
          <div style="display:flex; justify-content:space-between; margin-top:6px; border-top:1px dashed rgba(255,255,255,0.1); padding-top:6px; font-size:10px;">
            <span>Creative: <a href="${GAM_URL}/CreativeDetail/creativeId=${slot.creativeId}" target="_blank" style="color:#3B82F6; text-decoration:none; font-family:monospace; font-weight:bold; border-bottom:1px dotted #3B82F6;">${slot.creativeId}</a></span>
            <span>Line Item: <a href="${GAM_URL}/LineItemDetail/lineItemId=${slot.lineItemId}" target="_blank" style="color:#3B82F6; text-decoration:none; font-family:monospace; font-weight:bold; border-bottom:1px dotted #3B82F6;">${slot.lineItemId}</a></span>
          </div>
        `;
      }

      labelCard.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
          <span style="font-weight:800; color:#FFFFFF; text-transform:uppercase; font-size:9px; letter-spacing:0.05em; font-family:sans-serif;">${adSource}</span>
          <span style="background-color:${badgeColor}; color:#FFFFFF; font-size:9px; font-weight:bold; padding:1px 6px; border-radius:4px; text-transform:uppercase;">${statusText}</span>
        </div>
        <div class="monetiscope-copyable-path" style="font-family:monospace; font-size:10px; cursor:pointer; word-break:break-all; margin-bottom:4px; padding:2px 4px; background-color:rgba(0,0,0,0.2); border-radius:3px;" title="Click to copy path">
          ${formattedPath}
        </div>
        <div style="color:#94A3B8; font-size:9px;">Div ID: <span style="font-family:monospace; color:#E2E8F0;">${escapeHtml(slot.slotId)}</span></div>
        ${deliveryToolsHtml}
      `;

      // Copy path helper
      labelCard.querySelector('.monetiscope-copyable-path').addEventListener('click', function(e) {
        e.stopPropagation();
        navigator.clipboard.writeText(slot.adUnitPath);
        
        // Visual copied feedback
        const originalHtml = this.innerHTML;
        this.style.color = '#10B981';
        this.innerHTML = '<span style="font-weight:bold;">✔ Copied Ad Unit Path!</span>';
        setTimeout(() => {
          this.style.color = '';
          this.innerHTML = originalHtml;
        }, 1000);
      });

      overlay.appendChild(labelCard);
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

    // Reposition floating card dynamically to avoid off-screen cutoffs
    const labelCard = overlay.querySelector('.monetiscope-label-card');
    if (labelCard) {
      if (rect.top < 86) {
        // Under 86px from top boundary - position card INSIDE the top-left of the ad slot
        labelCard.style.top = '4px';
        labelCard.style.left = '4px';
        labelCard.style.boxShadow = '0 4px 6px rgba(0,0,0,0.3)';
      } else {
        // Place beautifully ABOVE the ad container
        labelCard.style.top = '-82px';
        labelCard.style.left = '0';
        labelCard.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -2px rgba(0, 0, 0, 0.1)';
      }
    }
  }

  // Safe HTML escapes helper
  function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return String(unsafe);
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
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

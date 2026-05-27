// Monetiscope GPT Ad Inspector - Main World Injector
// Runs inside the web page's execution context (MAIN world) to access googletag APIs and events directly.

(function() {
  // Prevent double injection
  if (window.__monetiscope_injected) return;
  window.__monetiscope_injected = true;

  console.log("Monetiscope Ad Inspector: Core injector loaded in main world.");

  const eventLog = [];
  const refreshHistory = {};
  
  let sraEnabled = false;
  let lazyLoadEnabled = false;
  let lazyLoadOptions = null;
  let collapseEmptyDivsEnabled = false;
  let collapseBeforeAdFetch = false;

  // Helper to send messages to the isolated content script
  function sendToContentScript(type, detail) {
    window.postMessage({
      source: 'monetiscope-inject',
      type: type,
      detail: detail
    }, '*');
  }

  // Intercept sizeMapping to record configured responsive mappings
  function patchSizeMapping(googletag) {
    if (!googletag.sizeMapping) return;
    
    const originalSizeMapping = googletag.sizeMapping;
    googletag.sizeMapping = function() {
      const builder = originalSizeMapping.apply(this, arguments);
      const originalAddSize = builder.addSize;
      const originalBuild = builder.build;
      const mappings = [];

      builder.addSize = function(viewportSize, slotSizes) {
        mappings.push({ viewportSize, slotSizes });
        return originalAddSize.apply(this, arguments);
      };

      builder.build = function() {
        const result = originalBuild.apply(this, arguments);
        if (result) {
          result.__mappings = mappings;
        }
        return result;
      };

      return builder;
    };
  }

  // Intercept slot creation and slot responsive mapping bindings
  function patchDefineSlot(googletag) {
    if (!googletag.defineSlot) return;

    const originalDefineSlot = googletag.defineSlot;
    googletag.defineSlot = function(adUnitPath, size, opt_div) {
      const slot = originalDefineSlot.apply(this, arguments);
      if (slot) {
        const originalDefineSizeMapping = slot.defineSizeMapping;
        slot.defineSizeMapping = function(sizeMappingArray) {
          if (sizeMappingArray) {
            // Check if we stashed the mappings on the build result
            slot.__responsiveMappings = sizeMappingArray.__mappings || sizeMappingArray;
          }
          return originalDefineSizeMapping.apply(this, arguments);
        };
      }
      return slot;
    };
  }

  // Intercept pubads methods to track settings (SRA, Lazy Loading, etc.)
  function patchPubAds(googletag) {
    if (!googletag.pubads) return;

    const pubadsInstance = googletag.pubads();
    const pubadsProto = Object.getPrototypeOf(pubadsInstance);

    // 1. Single Request Architecture (SRA)
    const originalEnableSingleRequest = pubadsProto.enableSingleRequest;
    pubadsProto.enableSingleRequest = function() {
      sraEnabled = true;
      sendToContentScript('settings_changed', { sraEnabled, lazyLoadEnabled, collapseEmptyDivsEnabled });
      return originalEnableSingleRequest.apply(this, arguments);
    };

    // 2. Lazy Loading
    const originalEnableLazyLoad = pubadsProto.enableLazyLoad;
    pubadsProto.enableLazyLoad = function(options) {
      lazyLoadEnabled = true;
      lazyLoadOptions = options ? {
        fetchMarginPercent: options.fetchMarginPercent,
        renderMarginPercent: options.renderMarginPercent,
        mobileScalingFactor: options.mobileScalingFactor
      } : true;
      sendToContentScript('settings_changed', { sraEnabled, lazyLoadEnabled, lazyLoadOptions, collapseEmptyDivsEnabled });
      return originalEnableLazyLoad.apply(this, arguments);
    };

    // 3. Collapse Empty Divs
    const originalCollapseEmptyDivs = pubadsProto.collapseEmptyDivs;
    pubadsProto.collapseEmptyDivs = function(collapseBefore) {
      collapseEmptyDivsEnabled = true;
      collapseBeforeAdFetch = collapseBefore !== undefined ? collapseBefore : false;
      sendToContentScript('settings_changed', { sraEnabled, lazyLoadEnabled, collapseEmptyDivsEnabled, collapseBeforeAdFetch });
      return originalCollapseEmptyDivs.apply(this, arguments);
    };

    // 4. Track Refresh Events
    const originalRefresh = pubadsProto.refresh;
    pubadsProto.refresh = function(opt_slots, opt_options) {
      const refreshedSlots = opt_slots || googletag.pubads().getSlots();
      const slotIds = refreshedSlots.map(s => s.getSlotElementId());
      const now = Date.now();

      slotIds.forEach(id => {
        if (!refreshHistory[id]) refreshHistory[id] = [];
        refreshHistory[id].push(now);
      });

      sendToContentScript('slot_refreshed', {
        slotIds: slotIds,
        timestamp: now,
        history: refreshHistory
      });

      return originalRefresh.apply(this, arguments);
    };
  }

  // Setup event listeners for slot lifecycle
  function setupEventListeners(googletag) {
    const pubads = googletag.pubads();

    pubads.addEventListener('slotRenderEnded', function(event) {
      const slot = event.slot;
      const slotId = slot.getSlotElementId();
      const adUnitPath = slot.getAdUnitPath();
      
      const payload = {
        slotId: slotId,
        adUnitPath: adUnitPath,
        isEmpty: event.isEmpty,
        size: event.size ? (Array.isArray(event.size) ? event.size.join('x') : event.size) : '0x0',
        creativeId: event.creativeId,
        lineItemId: event.lineItemId,
        advertiserId: event.advertiserId,
        campaignId: event.campaignId,
        timestamp: Date.now()
      };

      sendToContentScript('slotRenderEnded', payload);
    });

    pubads.addEventListener('impressionViewable', function(event) {
      sendToContentScript('impressionViewable', {
        slotId: event.slot.getSlotElementId(),
        adUnitPath: event.slot.getAdUnitPath(),
        timestamp: Date.now()
      });
    });

    pubads.addEventListener('slotRequested', function(event) {
      sendToContentScript('slotRequested', {
        slotId: event.slot.getSlotElementId(),
        adUnitPath: event.slot.getAdUnitPath(),
        timestamp: Date.now()
      });
    });

    pubads.addEventListener('slotResponseReceived', function(event) {
      sendToContentScript('slotResponseReceived', {
        slotId: event.slot.getSlotElementId(),
        adUnitPath: event.slot.getAdUnitPath(),
        timestamp: Date.now()
      });
    });

    pubads.addEventListener('slotVisibilityChanged', function(event) {
      sendToContentScript('slotVisibilityChanged', {
        slotId: event.slot.getSlotElementId(),
        adUnitPath: event.slot.getAdUnitPath(),
        inViewPercentage: event.inViewPercentage,
        timestamp: Date.now()
      });
    });
  }

  // Gather current state of slots
  function gatherAllSlotsData() {
    if (!window.googletag || !window.googletag.apiReady) return null;

    try {
      const pubads = window.googletag.pubads();
      const slots = pubads.getSlots();

      // Check runtime flags in case monkey-patching missed early executions
      if (typeof pubads.getSingleRequestMode === 'function') {
        sraEnabled = pubads.getSingleRequestMode();
      }

      const slotsData = slots.map(slot => {
        const slotId = slot.getSlotElementId();
        
        // Formulate standard size strings
        const configuredSizes = slot.getSizes().map(s => {
          if (typeof s === 'string') return s;
          if (s && typeof s.getWidth === 'function') return s.getWidth() + 'x' + s.getHeight();
          if (Array.isArray(s)) return s.join('x');
          return JSON.stringify(s);
        });

        // Pull sticky/anchor attributes
        const isAnchor = slot.isOutOfPage ? slot.isOutOfPage() : false;
        
        // Find responsive mappings
        let mappings = null;
        if (slot.__responsiveMappings) {
          mappings = slot.__responsiveMappings;
        }

        return {
          slotId: slotId,
          adUnitPath: slot.getAdUnitPath(),
          configuredSizes: configuredSizes,
          isAnchor: isAnchor,
          responsiveMappings: mappings,
          targeting: slot.getTargetingKeys().reduce((acc, key) => {
            acc[key] = slot.getTargeting(key);
            return acc;
          }, {})
        };
      });

      return {
        gptLoaded: true,
        sraEnabled: sraEnabled,
        lazyLoadEnabled: lazyLoadEnabled,
        lazyLoadOptions: lazyLoadOptions,
        collapseEmptyDivsEnabled: collapseEmptyDivsEnabled,
        collapseBeforeAdFetch: collapseBeforeAdFetch,
        slots: slotsData,
        refreshHistory: refreshHistory
      };
    } catch (e) {
      console.error("Monetiscope Ad Inspector: Error scanning slots", e);
      return null;
    }
  }

  // Initialize hooks on window.googletag
  function init() {
    window.googletag = window.googletag || {};
    window.googletag.cmd = window.googletag.cmd || [];

    patchSizeMapping(window.googletag);
    patchDefineSlot(window.googletag);

    window.googletag.cmd.push(function() {
      patchPubAds(window.googletag);
      setupEventListeners(window.googletag);

      // Fire initial state
      setTimeout(() => {
        const initialData = gatherAllSlotsData();
        if (initialData) {
          sendToContentScript('state_scan', initialData);
        }
      }, 500);
    });
  }

  init();

  // Listen for active scanning requests from content script
  window.addEventListener('message', function(event) {
    if (event.data && event.data.source === 'monetiscope-content' && event.data.type === 'SCAN_REQUEST') {
      const data = gatherAllSlotsData();
      if (data) {
        sendToContentScript('state_scan', data);
      } else {
        sendToContentScript('state_scan', { gptLoaded: false });
      }
    }
  });

})();

// Monetiscope GPT Ad Inspector - Popup Controller
// Coordinates tabs, updates metrics, queries tab content script, and implements onboarding gate

document.addEventListener('DOMContentLoaded', function() {
  let activeTabId = null;
  let cachedData = null;
  let searchTimeout = null;

  const gptStatusBadge = document.getElementById('gpt-status-badge');
  const currentUrlSpan = document.getElementById('current-url');
  const healthScoreSpan = document.getElementById('health-score');
  const connectionStatus = document.getElementById('connection-status');

  const specSra = document.getElementById('spec-sra');
  const specLazy = document.getElementById('spec-lazy');
  const specCollapse = document.getElementById('spec-collapse');

  const metricTotal = document.getElementById('metric-total');
  const metricFilled = document.getElementById('metric-filled');
  const metricEmpty = document.getElementById('metric-empty');
  const metricSticky = document.getElementById('metric-sticky');
  const slotsCountTab = document.getElementById('slots-count-tab');

  const diagnosticsList = document.getElementById('diagnostics-list');
  const slotsList = document.getElementById('slots-list');
  const responsiveList = document.getElementById('responsive-list');
  const logsList = document.getElementById('logs-list');

  const slotSearch = document.getElementById('slot-search');
  const logSearch = document.getElementById('log-search');
  const btnClearLogs = document.getElementById('btn-clear-logs');

  const toggleHighlight = document.getElementById('toggle-highlight');
  const btnCopyDebug = document.getElementById('btn-copy-debug');
  const btnExportJson = document.getElementById('btn-export-json');

  // --- 1. Load Visual Highlighter Setting & Initialize ---
  chrome.storage.local.get(['highlight_enabled'], function(res) {
    if (res.highlight_enabled !== undefined) {
      toggleHighlight.checked = res.highlight_enabled;
    }
    initExtensionFlow();
  });

  // --- 2. Main Tab Selection Flow ---
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', function() {
      const targetPanel = btn.getAttribute('data-tab');

      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(`tab-${targetPanel}`).classList.add('active');
    });
  });

  // --- 3. Extension Initialization and Data Querying ---
  function initExtensionFlow() {
    connectionStatus.innerText = 'Locating tab...';
    
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (!tabs || tabs.length === 0) {
        connectionStatus.innerText = 'No active window';
        return;
      }

      const activeTab = tabs[0];
      activeTabId = activeTab.id;
      
      // Update target URL display
      if (activeTab.url) {
        try {
          const parsed = new URL(activeTab.url);
          currentUrlSpan.innerText = parsed.hostname + parsed.pathname;
          
          // Disable extension on internal chrome pages
          if (parsed.protocol === 'chrome:' || parsed.protocol === 'chrome-extension:') {
            connectionStatus.innerText = 'System page';
            gptStatusBadge.innerText = 'UNSUPPORTED';
            gptStatusBadge.className = 'badge badge-error';
            renderEmptyUI("Unsupported Page", "This extension does not run on internal browser settings or store pages.");
            return;
          }
        } catch (e) {
          currentUrlSpan.innerText = activeTab.url;
        }
      }

      connectionStatus.innerText = 'Connected';
      queryAdData();
    });
  }

  function queryAdData() {
    if (!activeTabId) return;

    chrome.tabs.sendMessage(activeTabId, { type: 'GET_AD_DATA' }, function(response) {
      if (chrome.runtime.lastError || !response) {
        // Content script might not be injected yet
        console.warn("Message failed: ", chrome.runtime.lastError);
        gptStatusBadge.innerText = 'NO GPT';
        gptStatusBadge.className = 'badge badge-error';
        connectionStatus.innerText = 'No connection';
        renderEmptyUI("GPT Not Loaded", "We couldn't detect Google Publisher Tag on this page yet. Ensure GPT scripts are loaded.");
        return;
      }

      cachedData = response;
      renderDashboard(response);
    });
  }

  // --- 4. Dashboard Renderer ---
  function renderDashboard(data) {
    if (!data.gptLoaded) {
      gptStatusBadge.innerText = 'NO GPT';
      gptStatusBadge.className = 'badge badge-error';
      renderEmptyUI("No GPT Detected", "GPT is not present on this page. Double-check your Google Publisher Tag code.");
      return;
    }

    // Update main loaded badges
    gptStatusBadge.innerText = 'GPT ACTIVE';
    gptStatusBadge.className = 'badge badge-success';

    // Settings Flags
    updateSpecIndicator(specSra, data.sraEnabled);
    updateSpecIndicator(specLazy, data.lazyLoadEnabled);
    updateSpecIndicator(specCollapse, data.collapseEmptyDivsEnabled);

    // Render Metrics Counter Cards
    const totalSlots = data.slots ? data.slots.length : 0;
    const filledCount = data.diagnostics ? data.diagnostics.filledCount : 0;
    const emptyCount = data.diagnostics ? data.diagnostics.emptyCount : 0;
    const stickyCount = data.diagnostics ? data.diagnostics.stickyCount : 0;

    metricTotal.innerText = totalSlots;
    slotsCountTab.innerText = totalSlots;
    metricFilled.innerText = filledCount;
    metricEmpty.innerText = emptyCount;
    metricSticky.innerText = stickyCount;

    // Calculate dynamic Ad Ops Health Score
    let healthScore = 100;
    if (data.diagnostics && data.diagnostics.warnings) {
      data.diagnostics.warnings.forEach(w => {
        if (w.severity === 'critical') healthScore -= 20;
        if (w.severity === 'warning') healthScore -= 8;
      });
    }
    healthScore = Math.max(0, healthScore);
    healthScoreSpan.innerText = `${healthScore}/100`;
    
    // Style health score badge color
    if (healthScore >= 80) {
      healthScoreSpan.style.backgroundColor = 'var(--success)';
    } else if (healthScore >= 50) {
      healthScoreSpan.style.backgroundColor = 'var(--warning)';
    } else {
      healthScoreSpan.style.backgroundColor = 'var(--danger)';
    }

    // Render diagnostic warnings list
    renderDiagnostics(data.diagnostics ? data.diagnostics.warnings : []);

    // Render Slots list
    renderSlots(data.slots || []);

    // Render Responsive Mapping table
    renderResponsiveMappings(data.slots || []);

    // Render Event logs feed
    renderLogs(data.events || []);
  }

  function updateSpecIndicator(element, state) {
    if (state === true || (typeof state === 'object' && state !== null)) {
      element.innerText = 'YES';
      element.className = 'spec-value spec-yes';
    } else {
      element.innerText = 'NO';
      element.className = 'spec-value spec-no';
    }
  }

  // --- 5. Diagnostic Warnings Builder ---
  function renderDiagnostics(warnings) {
    diagnosticsList.innerHTML = '';
    if (!warnings || warnings.length === 0) {
      diagnosticsList.innerHTML = `
        <div class="diagnostics-success-box">
          <span class="warning-icon">✔</span>
          <span>All systems clear! Google Publisher Tag integration adheres to standard monetization best practices.</span>
        </div>
      `;
      return;
    }

    warnings.forEach(w => {
      const item = document.createElement('div');
      item.className = `warning-item warning-item-${w.severity}`;
      
      const icon = w.severity === 'critical' ? '⚠' : 'ℹ';
      item.innerHTML = `
        <span class="warning-icon">${icon}</span>
        <div class="warning-text">${w.message}</div>
      `;
      diagnosticsList.appendChild(item);
    });
  }

  // --- 6. Slots Card Builder ---
  function renderSlots(slots) {
    const filter = slotSearch.value.trim().toLowerCase();
    slotsList.innerHTML = '';

    const filtered = slots.filter(s => {
      if (!filter) return true;
      return s.slotId.toLowerCase().includes(filter) || s.adUnitPath.toLowerCase().includes(filter);
    });

    if (filtered.length === 0) {
      slotsList.innerHTML = `
        <div class="empty-state">No matching GPT slots found. Try adjusting your query.</div>
      `;
      return;
    }

    filtered.forEach(slot => {
      const card = document.createElement('div');
      card.className = 'slot-card';

      // Slot Status badge
      let statusBadgeHtml = '';
      if (slot.isEmpty === false) {
        statusBadgeHtml += '<span class="slot-badge slot-badge-filled">Filled</span>';
      } else if (slot.isEmpty === true) {
        statusBadgeHtml += '<span class="slot-badge slot-badge-empty">Empty</span>';
      }
      
      if (slot.isAnchor) {
        statusBadgeHtml += '<span class="slot-badge slot-badge-sticky">Sticky</span>';
      }
      
      if (slot.isRefreshing) {
        statusBadgeHtml += '<span class="slot-badge slot-badge-refreshing">Refreshing</span>';
      }

      // Sizes list
      const sizesTags = slot.configuredSizes ? slot.configuredSizes.map(s => `<span class="size-tag">${s}</span>`).join(' ') : '';
      let renderedSizeHtml = '';
      if (slot.isEmpty === false && slot.renderedSize) {
        renderedSizeHtml = ` &bull; <span class="sizes-label">Rendered:</span> <span class="size-tag size-tag-rendered">${slot.renderedSize}</span>`;
      }

      // Targetings rendering
      let targetingHtml = '';
      const tKeys = slot.targeting ? Object.keys(slot.targeting) : [];
      if (tKeys.length > 0) {
        const rows = tKeys.map(k => `
          <tr>
            <td class="targeting-key">${escapeHtml(k)}</td>
            <td>${escapeHtml(JSON.stringify(slot.targeting[k]))}</td>
          </tr>
        `).join('');
        
        targetingHtml = `
          <button class="targeting-toggle" data-slot="${slot.slotId}">🎯 Show Targeting Targetings (${tKeys.length})</button>
          <div class="targeting-content hidden" id="t-content-${slot.slotId}">
            <table class="targeting-table">
              <tbody>${rows}</tbody>
            </table>
          </div>
        `;
      }

      card.innerHTML = `
        <div class="slot-card-header">
          <div>
            <div class="slot-path" title="Click to copy path">${escapeHtml(slot.adUnitPath)}</div>
            <div class="slot-id">Div ID: <code>${escapeHtml(slot.slotId)}</code></div>
          </div>
          <div class="slot-badge-container">
            ${statusBadgeHtml}
          </div>
        </div>
        <div class="slot-sizes-row">
          <span class="sizes-label">Configured:</span>
          ${sizesTags}
          ${renderedSizeHtml}
        </div>
        ${targetingHtml}
      `;

      // Copy ad path event
      card.querySelector('.slot-path').addEventListener('click', function() {
        navigator.clipboard.writeText(slot.adUnitPath);
        showToast(`Copied path: ${slot.adUnitPath}`);
      });

      // Targetings collapse bind
      if (tKeys.length > 0) {
        card.querySelector('.targeting-toggle').addEventListener('click', function() {
          const content = document.getElementById(`t-content-${slot.slotId}`);
          if (content.classList.contains('hidden')) {
            content.classList.remove('hidden');
            this.innerText = `🎯 Hide Targetings (${tKeys.length})`;
          } else {
            content.classList.add('hidden');
            this.innerText = `🎯 Show Targeting Targetings (${tKeys.length})`;
          }
        });
      }

      slotsList.appendChild(card);
    });
  }

  // --- 7. Responsive Mappings List Builder ---
  function renderResponsiveMappings(slots) {
    responsiveList.innerHTML = '';
    
    // Filter slots that have responsive mappings configured
    const responsiveSlots = slots.filter(s => s.responsiveMappings && Array.isArray(s.responsiveMappings));

    if (responsiveSlots.length === 0) {
      responsiveList.innerHTML = `
        <div class="empty-state">No responsive size mappings detected. Custom size-mapping is empty or unset.</div>
      `;
      return;
    }

    responsiveSlots.forEach(slot => {
      const card = document.createElement('div');
      card.className = 'responsive-card';
      
      const rows = slot.responsiveMappings.map(m => {
        const vp = Array.isArray(m.viewportSize) ? m.viewportSize.join('x') : JSON.stringify(m.viewportSize);
        let sizes = '';
        if (Array.isArray(m.slotSizes)) {
          if (Array.isArray(m.slotSizes[0])) {
            sizes = m.slotSizes.map(s => s.join('x')).join(', ');
          } else {
            sizes = m.slotSizes.join('x');
          }
        } else {
          sizes = JSON.stringify(m.slotSizes);
        }
        
        return `
          <tr>
            <td class="mapping-viewport">&ge; ${vp}px</td>
            <td class="mapping-sizes">${sizes || 'Suppress Ad'}</td>
          </tr>
        `;
      }).join('');

      card.innerHTML = `
        <h3>Slot ID: ${escapeHtml(slot.slotId)}</h3>
        <table class="mapping-table">
          <thead>
            <tr>
              <th>Viewport Min Size</th>
              <th>Allowed Creative Sizes</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      `;

      responsiveList.appendChild(card);
    });
  }

  // --- 8. Event Feed Builder ---
  function renderLogs(events) {
    const filter = logSearch.value.trim().toLowerCase();
    logsList.innerHTML = '';

    const filtered = events.filter(e => {
      if (!filter) return true;
      return e.type.toLowerCase().includes(filter) || 
             (e.slotId && e.slotId.toLowerCase().includes(filter)) ||
             (e.message && e.message.toLowerCase().includes(filter));
    });

    if (filtered.length === 0) {
      logsList.innerHTML = `
        <div class="empty-state">No matching event logs found.</div>
      `;
      return;
    }

    // Display logs descending (newest first)
    [...filtered].reverse().forEach(evt => {
      const item = document.createElement('div');
      const safeType = evt.type.replace(/\s+/g, '-');
      item.className = `log-item log-${safeType}`;

      const date = new Date(evt.timestamp);
      const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}.${date.getMilliseconds().toString().padStart(3, '0')}`;

      item.innerHTML = `
        <div class="log-item-header">
          <span class="log-type">${escapeHtml(evt.type)}</span>
          <span class="log-time">${timeStr}</span>
        </div>
        <div class="log-message">${escapeHtml(evt.message)}</div>
      `;
      logsList.appendChild(item);
    });
  }

  // Event list search binding
  logSearch.addEventListener('input', function() {
    if (cachedData && cachedData.events) {
      renderLogs(cachedData.events);
    }
  });

  // Slots search binding
  slotSearch.addEventListener('input', function() {
    if (cachedData && cachedData.slots) {
      renderSlots(cachedData.slots);
    }
  });

  // Action: Clear Log lists
  btnClearLogs.addEventListener('click', function() {
    if (cachedData) {
      cachedData.events = [];
      renderLogs([]);
    }
  });

  // --- 9. Tools & Advanced Utilities ---

  // Action: Highlight Ads Switch Toggle
  toggleHighlight.addEventListener('change', function() {
    const isChecked = this.checked;
    
    // Save to settings
    chrome.storage.local.set({ highlight_enabled: isChecked });

    // Send payload to content script
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { type: 'TOGGLE_HIGHLIGHTS', enabled: isChecked }, function(res) {
        if (chrome.runtime.lastError) {
          console.error("Highlighter failed to send: ", chrome.runtime.lastError);
        }
      });
    }
  });

  // Action: Copy Debug payload
  btnCopyDebug.addEventListener('click', function() {
    if (!cachedData) {
      showToast("No active data to copy!");
      return;
    }
    const cleanStr = JSON.stringify(cachedData, null, 2);
    navigator.clipboard.writeText(cleanStr).then(() => {
      showToast("📋 Copied JSON to clipboard!");
    }).catch(err => {
      console.error("Clipboard copy failed: ", err);
    });
  });

  // Action: Export JSON File
  btnExportJson.addEventListener('click', function() {
    if (!cachedData) {
      showToast("No active data to export!");
      return;
    }
    const cleanStr = JSON.stringify(cachedData, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(cleanStr);
    
    const exportFileDefaultName = 'monetiscope_gpt_diagnostics.json';
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    showToast("💾 Exported JSON file!");
  });

  // Helper: Toast alerts
  function showToast(msg) {
    const oldToast = document.querySelector('.monetiscope-toast');
    if (oldToast) oldToast.remove();

    const toast = document.createElement('div');
    toast.className = 'monetiscope-toast';
    toast.style.position = 'fixed';
    toast.style.bottom = '40px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.backgroundColor = 'var(--brand-dark)';
    toast.style.color = '#FFFFFF';
    toast.style.fontSize = '11px';
    toast.style.fontWeight = 'bold';
    toast.style.padding = '6px 12px';
    toast.style.borderRadius = '20px';
    toast.style.zIndex = '999999999';
    toast.style.boxShadow = '0 4px 6px rgba(0,0,0,0.15)';
    toast.innerText = msg;

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.2s ease';
      setTimeout(() => toast.remove(), 200);
    }, 2000);
  }

  // Helper: Empty State UI renderer on bad page connections
  function renderEmptyUI(title, msg) {
    const totalPlaceholder = `
      <div class="empty-state">
        <h3>${title}</h3>
        <p style="margin-top:6px; color:var(--text-secondary);">${msg}</p>
      </div>
    `;
    slotsList.innerHTML = totalPlaceholder;
    responsiveList.innerHTML = totalPlaceholder;
    logsList.innerHTML = totalPlaceholder;
    
    diagnosticsList.innerHTML = `
      <div class="diagnostic-placeholder">${title}: Ad Ops scanning is idle.</div>
    `;

    metricTotal.innerText = '--';
    slotsCountTab.innerText = '0';
    metricFilled.innerText = '--';
    metricEmpty.innerText = '--';
    metricSticky.innerText = '--';
    healthScoreSpan.innerText = '--';
    healthScoreSpan.style.backgroundColor = 'var(--text-muted)';
  }

  // Safe HTML escapes
  function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return String(unsafe);
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
  }

});

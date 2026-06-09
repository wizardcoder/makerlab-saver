// MakerLab Config Saver — Popup Script

(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const statusDot = $("#statusDot");
  const statusText = $("#statusText");
  const saveSection = $("#saveSection");
  const configName = $("#configName");
  const saveBtn = $("#saveBtn");
  const configList = $("#configList");
  const resultSection = $("#resultSection");
  const resultTitle = $("#resultTitle");
  const resultContent = $("#resultContent");
  const toast = $("#toast");
  const storageWarning = $("#storageWarning");

  let hasCapture = false;
  let onMakerLab = false;
  let currentDesignId = null;
  let currentCustomizableName = null;

  function showToast(message, type = "") {
    toast.textContent = message;
    toast.className = "toast show" + (type ? ` ${type}` : "");
    setTimeout(() => (toast.className = "toast"), 3000);
  }

  function sendToContent(msg) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) {
          resolve({ ok: false, error: "No active tab." });
          return;
        }
        chrome.tabs.sendMessage(tabs[0].id, msg, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: "Not on a MakerWorld page, or page needs refreshing." });
            return;
          }
          resolve(response || { ok: false, error: "No response." });
        });
      });
    });
  }

  function formatDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  const _escDiv = document.createElement("div");
  function escapeHtml(str) {
    _escDiv.textContent = str;
    return _escDiv.innerHTML;
  }

  function downloadJson(json, filename) {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function getStoredConfigs() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ savedConfigs: [] }, (data) => {
        resolve(data.savedConfigs);
      });
    });
  }

  // ── Status ──────────────────────────────────────────────────────────

  function getActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs[0] || null);
      });
    });
  }

  function isMakerLabUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      return (u.hostname === "makerworld.com" || u.hostname === "www.makerworld.com") &&
        u.pathname.includes("/makerlab");
    } catch { return false; }
  }

  async function checkStatus() {
    const tab = await getActiveTab();
    const urlIsMakerLab = isMakerLabUrl(tab?.url);

    const res = await sendToContent({ action: "getLastCapture" });
    if (res.ok) {
      onMakerLab = true;
      hasCapture = true;
      currentDesignId = res.designId;
      currentCustomizableName = res.customizableName || null;
      statusDot.classList.add("captured");
      statusText.textContent = `Captured: ${res.designName || "Design " + (res.designId || "?")} — ${res.paramCount} params`;
      saveBtn.disabled = false;
      saveSection.style.display = "";
    } else if (urlIsMakerLab) {
      onMakerLab = true;
      try {
        const u = new URL(tab.url);
        const urlDesignId = u.searchParams.get("designId");
        if (urlDesignId) currentDesignId = parseInt(urlDesignId, 10) || urlDesignId;
        const urlModel = u.searchParams.get("modelName");
        if (urlModel) currentCustomizableName = urlModel;
      } catch {}
      statusDot.classList.remove("captured");
      statusText.textContent = res.error && !res.error.includes("Not on a MakerWorld")
        ? res.error
        : "On MakerLab page — change a value and click Generate to capture.";
      saveBtn.disabled = true;
      saveSection.style.display = "";
    } else if (res.error && !res.error.includes("Not on a MakerWorld")) {
      onMakerLab = true;
      statusDot.classList.remove("captured");
      statusText.textContent = res.error || "No capture yet.";
      saveBtn.disabled = true;
      saveSection.style.display = "";
    } else {
      onMakerLab = false;
      statusDot.classList.remove("captured");
      statusText.textContent = "Not on a MakerLab page. Viewing all saved configs.";
      saveSection.style.display = "none";
    }
    loadConfigs();
  }

  // ── List configs ────────────────────────────────────────────────────

  function renderConfigs(allConfigs, filterDesignId, filterCustomizable) {
    if (!allConfigs.length) {
      configList.innerHTML = '<div class="empty-state">No saved configs yet</div>';
      storageWarning.style.display = "none";
      return;
    }

    const indexed = allConfigs.map((c, i) => ({ ...c, index: i })).reverse();

    let visible;
    if (filterDesignId) {
      visible = indexed.filter((c) =>
        c.designId === filterDesignId &&
        (!filterCustomizable || c.customizableName === filterCustomizable)
      );
    } else {
      visible = indexed;
    }

    if (!visible.length) {
      configList.innerHTML = filterDesignId
        ? '<div class="empty-state">No saved configs for this customiser</div>'
        : '<div class="empty-state">No saved configs yet</div>';
      storageWarning.style.display = "none";
      return;
    }

    storageWarning.style.display = "block";

    let html = "";

    if (filterDesignId) {
      html += renderGroup(visible, true, false);
    } else {
      const groups = new Map();
      for (const c of visible) {
        const key = (c.designName || "Unknown Design") + "|" + (c.customizableName || "unknown.scad");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      }
      for (const [, items] of groups) {
        html += renderGroup(items, false, true);
      }
    }

    configList.innerHTML = html;
  }

  function renderGroup(items, autoOpen, offsite) {
    const first = items[0];
    const designName = first.designName || "Unknown Design";
    const customizableName = first.customizableName || "unknown.scad";
    const titleHtml = `<span class='accordion-title__main'>${escapeHtml(designName)}</span><span class='accordion-title__subname'>${escapeHtml(customizableName)}</span>`;

    let html = `<div class="accordion${autoOpen ? " open" : ""}">
      <div class="accordion-header">
        <span class="accordion-arrow">&#9654;</span>
        <span class="accordion-title">${titleHtml}</span>
        <span class="accordion-count">${items.length}</span>
      </div>
      <div class="accordion-body">`;

    for (const c of items) {
      html += `
        <div class="config-item" data-index="${c.index}">
          <div class="config-name">${escapeHtml(c.name)}</div>
          <div class="config-meta">${c.params ? c.params.length : "?"} params · ${formatDate(c.savedAt)}</div>
          <div class="config-actions">`;
      if (!offsite) {
        html += `<button class="btn-load" data-action="restore" data-index="${c.index}">⬆ Load</button>
            <button class="btn-small" data-action="diff" data-index="${c.index}">Diff</button>`;
      }
      html += `<button class="btn-small" data-action="export" data-index="${c.index}">Export</button>`;
      if (!offsite) {
        html += `<button class="btn-small" data-action="copyPayload" data-index="${c.index}">Copy Payload</button>`;
      }
      html += `<button class="btn-danger" data-action="delete" data-index="${c.index}">Delete</button>
          </div>
        </div>`;
    }
    html += `</div></div>`;
    return html;
  }

  async function loadConfigs() {
    const allConfigs = await getStoredConfigs();
    renderConfigs(allConfigs, currentDesignId, currentCustomizableName);
  }

  // ── Save ─────────────────────────────────────────────────────────────

  saveBtn.addEventListener("click", async () => {
    const name = configName.value.trim();
    if (!name) { showToast("Enter a name first.", "error"); return; }
    const res = await sendToContent({ action: "saveConfig", name });
    if (res.ok) {
      showToast("Saved!");
      configName.value = "";
      loadConfigs();
    } else {
      showToast(res.error, "error");
    }
  });

  configName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveBtn.click();
  });

  // ── Config actions ──────────────────────────────────────────────────

  configList.addEventListener("click", async (e) => {
    const header = e.target.closest(".accordion-header");
    if (header) { header.parentElement.classList.toggle("open"); return; }

    const btn = e.target.closest("[data-action]");
    if (!btn) return;

    const action = btn.dataset.action;
    const index = parseInt(btn.dataset.index, 10);

    switch (action) {
      case "restore": {
        btn.textContent = "Restoring…";
        btn.disabled = true;
        showToast("Restoring config — dropdowns may flash…", "info");

        const res = await sendToContent({ action: "restoreConfig", index });
        btn.textContent = "⬆ Load";
        btn.disabled = false;

        if (!res.ok) {
          showToast(res.error, "error");
          return;
        }

        const r = res.results;
        showToast(`Restored ${r.matched} params (${r.failed} failed, ${r.skipped} skipped)`);

        resultTitle.textContent = "Restore Result";
        let html = `<div class="restore-summary">
          <span class="ok">✓ ${r.matched} set</span> ·
          <span class="fail">✗ ${r.failed} failed</span> ·
          <span class="skip">⊘ ${r.skipped} skipped</span>
        </div>`;

        const problems = r.details.filter((d) => d.status !== "ok");
        if (problems.length) {
          html += `<table class="diff-table" style="margin-top:8px;">
            <thead><tr><th>Parameter</th><th>Status</th></tr></thead><tbody>`;
          for (const d of problems) {
            const statusLabel =
              d.status === "no_field" ? "Not in UI"
              : d.status === "select_fail" ? "Dropdown failed"
              : d.status === "unknown_type" ? "Unknown type"
              : d.status;
            html += `<tr>
              <td>${escapeHtml(d.name)}</td>
              <td class="${d.status === "no_field" ? "skip" : "fail"}">${statusLabel}</td>
            </tr>`;
          }
          html += "</tbody></table>";
        }

        resultContent.innerHTML = html;
        resultSection.style.display = "block";
        break;
      }

      case "diff": {
        if (!hasCapture) {
          showToast("No current capture to compare against.", "error");
          return;
        }
        const res = await sendToContent({ action: "getDiff", index });
        if (!res.ok) { showToast(res.error, "error"); return; }

        const allConfigs = await getStoredConfigs();
        const cfg = allConfigs[index];
        resultTitle.textContent = `Diff: ${cfg ? cfg.name : "Config"}`;
        resultSection.style.display = "block";

        if (!res.diffs.length) {
          resultContent.innerHTML = '<div class="empty-state">No differences — identical.</div>';
          return;
        }

        let html = `<div class="diff-section"><table class="diff-table">
          <thead><tr><th>Parameter</th><th>Saved</th><th>Current</th></tr></thead><tbody>`;
        for (const d of res.diffs) {
          html += `<tr>
            <td>${escapeHtml(d.name)}</td>
            <td class="val-saved">${escapeHtml(String(d.saved))}</td>
            <td class="val-current">${escapeHtml(String(d.current))}</td>
          </tr>`;
        }
        html += `</tbody></table></div>
          <div style="margin-top:6px;font-size:11px;color:#666;">
            ${res.diffs.length} difference(s)
          </div>`;
        resultContent.innerHTML = html;
        break;
      }

      case "export": {
        const allConfigs = await getStoredConfigs();
        const config = allConfigs[index];
        if (!config) { showToast("Config not found.", "error"); return; }
        const filename = `makerlab-${(config.name || "config").replace(/[^a-z0-9]/gi, "_")}.json`;
        downloadJson(JSON.stringify(config, null, 2), filename);
        showToast("Exported!");
        break;
      }

      case "copyPayload": {
        const allConfigs = await getStoredConfigs();
        const config = allConfigs[index];
        if (!config) { showToast("Config not found.", "error"); return; }
        try {
          await navigator.clipboard.writeText(config.rawPayload);
          showToast("Raw payload copied.");
        } catch {
          showToast("Clipboard write failed.", "error");
        }
        break;
      }

      case "delete": {
        if (!confirm("Delete this config?")) return;
        const allConfigs = await getStoredConfigs();
        allConfigs.splice(index, 1);
        chrome.storage.local.set({ savedConfigs: allConfigs }, () => {
          showToast("Deleted.");
          loadConfigs();
          resultSection.style.display = "none";
        });
        break;
      }
    }
  });

  // ── Export All / Import All ───────────────────────────────────────────

  const exportAllBtn = $("#exportAllBtn");
  const importAllBtn = $("#importAllBtn");
  const importAllFile = $("#importAllFile");

  exportAllBtn.addEventListener("click", () => {
    chrome.storage.local.get({ savedConfigs: [] }, (data) => {
      if (!data.savedConfigs.length) { showToast("No configs to export.", "error"); return; }
      downloadJson(JSON.stringify(data.savedConfigs, null, 2), `makerlab-all-configs-${new Date().toISOString().slice(0, 10)}.json`);
      showToast(`Exported ${data.savedConfigs.length} configs.`);
    });
  });

  importAllBtn.addEventListener("click", () => importAllFile.click());

  importAllFile.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      // Support both single config and array of configs
      const configs = Array.isArray(parsed) ? parsed : [parsed];

      // Validate each config has params
      const valid = configs.filter((c) => c.params && Array.isArray(c.params));
      if (!valid.length) {
        showToast("No valid configs found in file.", "error");
        return;
      }

      // Ensure required fields on each
      for (const config of valid) {
        config.name = config.name || "Imported Config";
        config.savedAt = config.savedAt || new Date().toISOString();
        config.designId = config.designId || null;
        config.paramsRaw = config.paramsRaw || "";
        config.type = config.type || "obj";
        config.color = config.color || "";
        config.rawPayload = config.rawPayload || "";
        config.code = config.code || "";
      }

      chrome.storage.local.get({ savedConfigs: [] }, (data) => {
        const existing = new Set(
          data.savedConfigs.map((c) => `${c.name}|${c.designId}|${c.savedAt}`)
        );
        const fresh = valid.filter(
          (c) => !existing.has(`${c.name}|${c.designId}|${c.savedAt}`)
        );
        if (!fresh.length) {
          showToast("All configs already exist — nothing imported.", "info");
          return;
        }
        const merged = data.savedConfigs.concat(fresh);
        chrome.storage.local.set({ savedConfigs: merged }, () => {
          const skipped = valid.length - fresh.length;
          let msg = `Imported ${fresh.length} config${fresh.length === 1 ? "" : "s"}.`;
          if (skipped) msg += ` ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped.`;
          showToast(msg);
          loadConfigs();
        });
      });
    } catch (err) {
      showToast("Failed to parse JSON file.", "error");
    }

    importAllFile.value = "";
  });

  // ── Init ─────────────────────────────────────────────────────────────

  checkStatus();
})();

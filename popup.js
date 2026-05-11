// MakerLab Config Saver — Popup Script

(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const statusDot = $("#statusDot");
  const statusText = $("#statusText");
  const configName = $("#configName");
  const saveBtn = $("#saveBtn");
  const configList = $("#configList");
  const resultSection = $("#resultSection");
  const resultTitle = $("#resultTitle");
  const resultContent = $("#resultContent");
  const toast = $("#toast");
  const storageWarning = $("#storageWarning");

  let hasCapture = false;

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

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Status ──────────────────────────────────────────────────────────

  async function checkStatus() {
    const res = await sendToContent({ action: "getLastCapture" });
    if (res.ok) {
      hasCapture = true;
      statusDot.classList.add("captured");
      statusText.textContent = `Captured: ${res.designName || "Design " + (res.designId || "?")} — ${res.paramCount} params`;
      saveBtn.disabled = false;
    } else {
      statusDot.classList.remove("captured");
      statusText.textContent = res.error || "No capture yet.";
      saveBtn.disabled = true;
    }
  }

  // ── List configs ────────────────────────────────────────────────────

  async function loadConfigs() {
    const res = await sendToContent({ action: "listConfigs" });
    if (!res.ok || !res.configs.length) {
      configList.innerHTML = '<div class="empty-state">No saved configs yet</div>';
      storageWarning.style.display = "none";
      return;
    }

    storageWarning.style.display = "block";

    const configs = res.configs.slice().reverse();

    // Group by designName + customizableName
    const groups = new Map();
    for (const c of configs) {
      const key = "<span class='accordion-title__main'>" + escapeHtml(c.designName || "Unknown Design") + "</span><span class='accordion-title__subname'>" + escapeHtml(c.customizableName || "unknown.scad") + "</span>";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    let html = "";
    let groupIndex = 0;
    for (const [groupName, items] of groups) {
      const isOpen = "";
      html += `<div class="accordion${isOpen}">
        <div class="accordion-header">
          <span class="accordion-arrow">&#9654;</span>
          <span class="accordion-title">${groupName}</span>
          <span class="accordion-count">${items.length}</span>
        </div>
        <div class="accordion-body">`;
      for (const c of items) {
        html += `
          <div class="config-item" data-index="${c.index}">
            <div class="config-name">${escapeHtml(c.name)}</div>
            <div class="config-meta">${c.paramCount} params · ${formatDate(c.savedAt)}</div>
            <div class="config-actions">
              <button class="btn-load" data-action="restore" data-index="${c.index}">⬆ Load</button>
              <button class="btn-small" data-action="diff" data-index="${c.index}">Diff</button>
              <button class="btn-small" data-action="export" data-index="${c.index}">Export</button>
              <button class="btn-small" data-action="copyPayload" data-index="${c.index}">Copy Payload</button>
              <button class="btn-danger" data-action="delete" data-index="${c.index}">Delete</button>
            </div>
          </div>`;
      }
      html += `</div></div>`;
      groupIndex++;
    }

    configList.innerHTML = html;
  }

  // ── Save ─────────────────────────────────────────────────────────────

  saveBtn.addEventListener("click", async () => {
    const name = configName.value.trim();
    if (!name) { showToast("Enter a name first.", "error"); return; }
    const res = await sendToContent({ action: "saveConfig", name });
    if (res.ok) {
      showToast(`Saved! (${res.total} total)`);
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

        const listRes = await sendToContent({ action: "listConfigs" });
        const cfg = listRes.ok ? listRes.configs.find((c) => c.index === index) : null;
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
        const res = await sendToContent({ action: "exportConfig", index });
        if (!res.ok) { showToast(res.error, "error"); return; }
        const blob = new Blob([res.json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = res.filename;
        a.click();
        URL.revokeObjectURL(url);
        showToast("Exported!");
        break;
      }

      case "copyPayload": {
        const res = await sendToContent({ action: "loadConfig", index });
        if (!res.ok) { showToast(res.error, "error"); return; }
        try {
          await navigator.clipboard.writeText(res.config.rawPayload);
          showToast("Raw payload copied.");
        } catch {
          showToast("Clipboard write failed.", "error");
        }
        break;
      }

      case "delete": {
        if (!confirm("Delete this config?")) return;
        const res = await sendToContent({ action: "deleteConfig", index });
        if (res.ok) {
          showToast("Deleted.");
          loadConfigs();
          resultSection.style.display = "none";
        } else {
          showToast(res.error, "error");
        }
        break;
      }
    }
  });

  // ── Import ───────────────────────────────────────────────────────────

  const importBtn = $("#importBtn");
  const importFile = $("#importFile");

  importBtn.addEventListener("click", () => importFile.click());

  importFile.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const config = JSON.parse(text);

      // Validate it looks like a saved config
      if (!config.params || !Array.isArray(config.params)) {
        showToast("Invalid config file — missing params.", "error");
        return;
      }

      // Ensure required fields exist
      config.name = config.name || file.name.replace(/\.json$/, "");
      config.savedAt = config.savedAt || new Date().toISOString();
      config.designId = config.designId || null;
      config.paramsRaw = config.paramsRaw || "";
      config.type = config.type || "obj";
      config.color = config.color || "";
      config.rawPayload = config.rawPayload || "";
      config.code = config.code || "";

      // Save to storage via content script
      const res = await sendToContent({ action: "importConfig", config });
      if (res.ok) {
        showToast(`Imported "${config.name}" (${config.params.length} params)`);
        loadConfigs();
      } else {
        showToast(res.error || "Import failed.", "error");
      }
    } catch (err) {
      showToast("Failed to parse JSON file.", "error");
    }

    // Reset file input so the same file can be re-imported
    importFile.value = "";
  });

  // ── Init ─────────────────────────────────────────────────────────────

  checkStatus();
  loadConfigs();
})();

// MakerLab Config Saver — Content Script (isolated world)

(function () {
  "use strict";

  // ── Inject page-level script ────────────────────────────────────────

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.onload = function () {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);

  // ── State ────────────────────────────────────────────────────────────

  let lastCapturedPayload = null;
  let pendingRestoreCallback = null;

  // ── Listen for messages from injected page script ───────────────────

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.channel !== "makerlab-saver") return;

    if (event.data.type === "captured") {
      lastCapturedPayload = event.data.payload;
      console.log(
        "[MakerLab Saver] Captured — design:",
        lastCapturedPayload.designId
      );
    }

    if (event.data.type === "restoreResult" && pendingRestoreCallback) {
      pendingRestoreCallback(event.data.results);
      pendingRestoreCallback = null;
    }
  });

  // ── OpenSCAD parser ─────────────────────────────────────────────────

  /**
   * Parse -D overrides from the params string.
   * e.g. "-Dhorizontal_grids=8" → { horizontal_grids: "8" }
   */
  function parseDOverrides(paramsStr) {
    const overrides = {};
    if (!paramsStr) return overrides;
    const matches = paramsStr.matchAll(/-D(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g);
    for (const m of matches) {
      overrides[m[1]] = m[2];
    }
    return overrides;
  }

  function parseOpenSCADParams(source, paramsStr) {
    const lines = source.split(/\r?\n/);
    const params = [];
    let currentSection = "";

    // Parse -D overrides which contain the ACTUAL user-changed values
    const overrides = parseDOverrides(paramsStr);

    let inHiddenSection = false;

    for (const line of lines) {
      const sectionMatch = line.match(/^\/\*\[(.+?)\]\*\/$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1].trim();
        if (currentSection === "Hidden") inHiddenSection = true;
        continue;
      }

      // Skip everything in and after the Hidden section
      if (inHiddenSection) continue;

      // Skip internal code blocks (utility functions, modules, etc.)
      if (line.match(/^\/\/BEGIN\s/) || line.match(/^module\s/) || line.match(/^function\s/)) {
        inHiddenSection = true;
        continue;
      }

      const varMatch = line.match(/^(\w+)\s*=\s*(.+?)\s*;\s*(?:\/\/(.*))?$/);
      if (!varMatch) continue;

      const [, name, rawValue, comment] = varMatch;

      if (rawValue.includes("(") || rawValue.includes("?") || rawValue.includes("[")) continue;

      const hasOperator = /[+\-*/]/.test(rawValue);
      const isSimpleNegative = /^-\d+(\.\d+)?$/.test(rawValue);
      if (hasOperator && !isSimpleNegative) continue;

      let value, type, options;

      if (/^"([^"]*)"$/.test(rawValue)) {
        type = "string";
        value = rawValue.replace(/^"|"$/g, "");
      } else if (rawValue === "true" || rawValue === "false") {
        type = "boolean";
        value = rawValue === "true";
      } else if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
        type = "number";
        value = parseFloat(rawValue);
      } else {
        continue;
      }

      if (comment) {
        const optMatch = comment.match(/^\[(.+)\]$/);
        if (optMatch) {
          options = optMatch[1].split(",").map((o) => o.trim().replace(/^"|"$/g, ""));
        }
      }

      // Apply -D override if present (these are the actual user values)
      if (overrides[name] !== undefined) {
        const ov = overrides[name];
        if (type === "string") {
          value = ov.replace(/^"|"$/g, "");
        } else if (type === "boolean") {
          value = ov === "true";
        } else if (type === "number") {
          value = parseFloat(ov);
        }
      }

      params.push({
        name,
        value,
        type,
        options: options || null,
        section: currentSection,
        comment: comment || "",
        raw: rawValue,
      });
    }

    return params;
  }

  // ── Popup message handling ──────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.action) {
      case "getLastCapture": {
        if (!lastCapturedPayload) {
          sendResponse({ ok: false, error: "No config captured yet. Change an option in MakerLab and click Generate to capture." });
          return;
        }
        const params = parseOpenSCADParams(lastCapturedPayload.code, lastCapturedPayload.params);
        sendResponse({
          ok: true,
          designId: lastCapturedPayload.designId,
          designName: lastCapturedPayload.designName || "",
          customizableName: lastCapturedPayload.customizableName || "",
          capturedAt: lastCapturedPayload.capturedAt,
          params,
          paramCount: params.length,
        });
        return;
      }

      case "saveConfig": {
        if (!lastCapturedPayload) {
          sendResponse({ ok: false, error: "Nothing captured to save." });
          return;
        }
        const params = parseOpenSCADParams(lastCapturedPayload.code, lastCapturedPayload.params);
        const configToSave = {
          name: msg.name || `Config ${new Date().toLocaleString()}`,
          designId: lastCapturedPayload.designId,
          designName: lastCapturedPayload.designName || "",
          customizableName: lastCapturedPayload.customizableName || "",
          params,
          paramsRaw: lastCapturedPayload.params,
          type: lastCapturedPayload.type,
          color: lastCapturedPayload.color,
          savedAt: new Date().toISOString(),
          capturedAt: lastCapturedPayload.capturedAt,
          rawPayload: lastCapturedPayload.rawPayload,
          code: lastCapturedPayload.code,
        };
        chrome.storage.local.get({ savedConfigs: [] }, (data) => {
          data.savedConfigs.push(configToSave);
          chrome.storage.local.set({ savedConfigs: data.savedConfigs }, () => {
            sendResponse({ ok: true, total: data.savedConfigs.length });
          });
        });
        return true;
      }

      case "listConfigs": {
        chrome.storage.local.get({ savedConfigs: [] }, (data) => {
          sendResponse({
            ok: true,
            configs: data.savedConfigs.map((c, i) => ({
              index: i,
              name: c.name,
              designId: c.designId,
              designName: c.designName || "",
              customizableName: c.customizableName || "",
              savedAt: c.savedAt,
              paramCount: c.params.length,
            })),
          });
        });
        return true;
      }

      case "loadConfig": {
        chrome.storage.local.get({ savedConfigs: [] }, (data) => {
          const config = data.savedConfigs[msg.index];
          if (!config) {
            sendResponse({ ok: false, error: "Config not found." });
            return;
          }
          sendResponse({ ok: true, config });
        });
        return true;
      }

      case "deleteConfig": {
        chrome.storage.local.get({ savedConfigs: [] }, (data) => {
          const configs = data.savedConfigs;
          if (msg.index >= 0 && msg.index < configs.length) {
            configs.splice(msg.index, 1);
            chrome.storage.local.set({ savedConfigs: configs }, () => {
              sendResponse({ ok: true });
            });
          } else {
            sendResponse({ ok: false, error: "Invalid index." });
          }
        });
        return true;
      }

      case "importConfig": {
        const config = msg.config;
        if (!config || !config.params) {
          sendResponse({ ok: false, error: "Invalid config data." });
          return;
        }
        chrome.storage.local.get({ savedConfigs: [] }, (data) => {
          data.savedConfigs.push(config);
          chrome.storage.local.set({ savedConfigs: data.savedConfigs }, () => {
            sendResponse({ ok: true, total: data.savedConfigs.length });
          });
        });
        return true;
      }

      case "exportConfig": {
        chrome.storage.local.get({ savedConfigs: [] }, (data) => {
          const config = data.savedConfigs[msg.index];
          if (!config) {
            sendResponse({ ok: false, error: "Config not found." });
            return;
          }
          sendResponse({
            ok: true,
            json: JSON.stringify(config, null, 2),
            filename: `makerlab-${config.name.replace(/\s+/g, "-").toLowerCase()}.json`,
          });
        });
        return true;
      }

      case "exportAllConfigs": {
        chrome.storage.local.get({ savedConfigs: [] }, (data) => {
          if (!data.savedConfigs.length) {
            sendResponse({ ok: false, error: "No configs to export." });
            return;
          }
          sendResponse({
            ok: true,
            json: JSON.stringify(data.savedConfigs, null, 2),
            count: data.savedConfigs.length,
          });
        });
        return true;
      }

      case "importAllConfigs": {
        const configs = msg.configs;
        if (!Array.isArray(configs) || !configs.length) {
          sendResponse({ ok: false, error: "No valid configs found in file." });
          return;
        }
        chrome.storage.local.get({ savedConfigs: [] }, (data) => {
          const merged = data.savedConfigs.concat(configs);
          chrome.storage.local.set({ savedConfigs: merged }, () => {
            sendResponse({ ok: true, imported: configs.length, total: merged.length });
          });
        });
        return true;
      }

      case "restoreConfig": {
        chrome.storage.local.get({ savedConfigs: [] }, (data) => {
          const config = data.savedConfigs[msg.index];
          if (!config) {
            sendResponse({ ok: false, error: "Config not found." });
            return;
          }

          // Send params to page context for DOM manipulation
          pendingRestoreCallback = (results) => {
            sendResponse({ ok: true, results });
          };

          window.postMessage(
            {
              channel: "makerlab-saver",
              type: "restore",
              params: config.params,
            },
            "*"
          );

          // Timeout in case page script doesn't respond
          setTimeout(() => {
            if (pendingRestoreCallback) {
              pendingRestoreCallback = null;
              sendResponse({ ok: false, error: "Restore timed out." });
            }
          }, 15000);
        });
        return true;
      }

      case "getDiff": {
        chrome.storage.local.get({ savedConfigs: [] }, (data) => {
          const config = data.savedConfigs[msg.index];
          if (!config || !lastCapturedPayload) {
            sendResponse({ ok: false, error: "Need both a saved config and a current capture to diff." });
            return;
          }
          const currentParams = parseOpenSCADParams(lastCapturedPayload.code, lastCapturedPayload.params);
          const currentMap = {};
          for (const p of currentParams) currentMap[p.name] = p;

          const diffs = [];
          for (const sp of config.params) {
            const cp = currentMap[sp.name];
            if (!cp) {
              diffs.push({ name: sp.name, saved: sp.value, current: "(missing)", section: sp.section });
            } else if (String(sp.value) !== String(cp.value)) {
              diffs.push({ name: sp.name, saved: sp.value, current: cp.value, section: sp.section });
            }
          }

          sendResponse({ ok: true, diffs, totalSaved: config.params.length, totalCurrent: currentParams.length });
        });
        return true;
      }

      default:
        sendResponse({ ok: false, error: "Unknown action." });
    }
  });

  console.log("[MakerLab Saver] Content script loaded.");
})();

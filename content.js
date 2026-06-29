// MakerLab Config Saver - Content Script (isolated world)

(function () {
  "use strict";

  const CHANNEL = "makerlab-saver";

  // inject.js is loaded via manifest.json with "world": "MAIN"

  // ── State ────────────────────────────────────────────────────────────

  let lastCapturedPayload = null;
  let pendingRestoreCallback = null;
  let pendingScanCallback = null;
  let pendingDesignInfoCallbacks = new Map();
  let designInfoSeq = 0;

  function queryDesignInfo() {
    return new Promise((resolve) => {
      const id = ++designInfoSeq;
      pendingDesignInfoCallbacks.set(id, resolve);
      window.postMessage({ channel: CHANNEL, type: "queryDesignInfo", callbackId: id }, "*");
      setTimeout(() => {
        if (pendingDesignInfoCallbacks.has(id)) {
          pendingDesignInfoCallbacks.get(id)({ designName: "", customizableName: "" });
          pendingDesignInfoCallbacks.delete(id);
        }
      }, 1000);
    });
  }

  // ── Listen for messages from injected page script ───────────────────

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.channel !== CHANNEL) return;

    if (event.data.type === "captured") {
      lastCapturedPayload = event.data.payload;
      console.log(
        "[MakerLab Saver] Captured - design:",
        lastCapturedPayload.designId
      );
    }

    if (event.data.type === "restoreResult" && pendingRestoreCallback) {
      pendingRestoreCallback(event.data.results);
      pendingRestoreCallback = null;
    }

    if (event.data.type === "scanResult" && pendingScanCallback) {
      pendingScanCallback(event.data.fields);
      pendingScanCallback = null;
    }

    if (event.data.type === "designInfoResult") {
      const id = event.data.callbackId;
      const cb = id && pendingDesignInfoCallbacks.get(id);
      if (cb) {
        cb({
          designName: event.data.designName,
          customizableName: event.data.customizableName,
        });
        pendingDesignInfoCallbacks.delete(id);
      }
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
    const matches = paramsStr.matchAll(/-D(\w+)=("(?:[^"\\]|\\.)*"|\[[^\]]*\]|\S+)/g);
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

      if (rawValue.includes("(") || rawValue.includes("?")) continue;

      // Check for simple array/vector: [num, num, ...]
      const arrayMatch = rawValue.match(/^\[([^\[\]]*)\]$/);
      if (arrayMatch) {
        const elements = arrayMatch[1].split(",").map((s) => s.trim());
        const allNumbers = elements.every((e) => /^-?\d*\.?\d+$/.test(e));
        if (!allNumbers) continue;
        const value = elements.map((e) => parseFloat(e));
        const type = "array";

        if (overrides[name] !== undefined) {
          const ov = overrides[name];
          const ovArray = ov.match(/^\[([^\[\]]*)\]$/);
          if (ovArray) {
            const ovElements = ovArray[1].split(",").map((s) => parseFloat(s.trim()));
            params.push({ name, value: ovElements, type, options: null, section: currentSection, comment: comment || "", raw: rawValue });
            continue;
          }
        }

        params.push({ name, value, type, options: null, section: currentSection, comment: comment || "", raw: rawValue });
        continue;
      }

      if (rawValue.includes("[")) continue;

      const hasOperator = /[+\-*/]/.test(rawValue);
      const isSimpleNegative = /^-\d*\.?\d+$/.test(rawValue);
      if (hasOperator && !isSimpleNegative) continue;

      let value, type, options;

      if (/^"([^"]*)"$/.test(rawValue)) {
        type = "string";
        value = rawValue.replace(/^"|"$/g, "");
      } else if (rawValue === "true" || rawValue === "false") {
        type = "boolean";
        value = rawValue === "true";
      } else if (/^-?\d*\.?\d+$/.test(rawValue)) {
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

  function getParamsFromPayload(payload) {
    if (payload.parsedParams && payload.parsedParams.length) {
      return payload.parsedParams;
    }
    return parseOpenSCADParams(payload.code, payload.params);
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  function scanDOMFields() {
    return new Promise((resolve) => {
      pendingScanCallback = resolve;
      window.postMessage({ channel: CHANNEL, type: "scanFields" }, "*");
      setTimeout(() => {
        if (pendingScanCallback) {
          pendingScanCallback = null;
          resolve([]);
        }
      }, 2000);
    });
  }

  async function refreshPayloadInfo() {
    const info = await queryDesignInfo();
    if (info.designName) lastCapturedPayload.designName = info.designName;
    if (info.customizableName) lastCapturedPayload.customizableName = info.customizableName;
    return getParamsFromPayload(lastCapturedPayload);
  }

  // ── Popup message handling ──────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.action) {
      case "getLastCapture": {
        if (!lastCapturedPayload) {
          sendResponse({ ok: false, error: "No config captured yet. Change an option in MakerLab and click Generate to capture." });
          return;
        }
        refreshPayloadInfo().then((params) => {
          sendResponse({
            ok: true,
            designId: lastCapturedPayload.designId,
            designName: lastCapturedPayload.designName || "",
            customizableName: lastCapturedPayload.customizableName || "",
            capturedAt: lastCapturedPayload.capturedAt,
            params,
            paramCount: params.length,
          });
        });
        return true;
      }

      case "checkStale": {
        if (!lastCapturedPayload) {
          sendResponse({ ok: true, stale: false });
          return;
        }
        refreshPayloadInfo().then(async (params) => {
          const domFields = await scanDOMFields();
          if (!domFields.length) {
            sendResponse({ ok: true, stale: false });
            return;
          }
          const domMap = {};
          for (const f of domFields) domMap[f.label] = f;

          const changed = [];
          for (const p of params) {
            const label = p.name.replace(/_/g, " ").toLowerCase();
            const dom = domMap[label];
            if (!dom) continue;
            const domVal = String(Array.isArray(dom.value) ? dom.value.join(",") : dom.value);
            const capVal = String(Array.isArray(p.value) ? p.value.join(",") : p.value);
            if (domVal !== capVal) {
              changed.push({ name: p.name, captured: capVal, current: domVal });
            }
          }
          sendResponse({ ok: true, stale: changed.length > 0, changed });
        });
        return true;
      }

      case "saveConfig": {
        if (!lastCapturedPayload) {
          sendResponse({ ok: false, error: "Nothing captured to save." });
          return;
        }
        refreshPayloadInfo().then((params) => {
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

          pendingRestoreCallback = (results) => {
            sendResponse({ ok: true, results });
          };

          window.postMessage(
            { channel: CHANNEL, type: "restore", params: config.params },
            "*"
          );

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
        if (!lastCapturedPayload) {
          sendResponse({ ok: false, error: "Need both a saved config and a current capture to diff." });
          return;
        }
        chrome.storage.local.get({ savedConfigs: [] }, (data) => {
          const config = data.savedConfigs[msg.index];
          if (!config) {
            sendResponse({ ok: false, error: "Config not found." });
            return;
          }
          const currentParams = getParamsFromPayload(lastCapturedPayload);
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

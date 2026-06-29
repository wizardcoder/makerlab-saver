// MakerLab Config Saver - Page-level script (MAIN WORLD)

(function () {
  "use strict";

  const CHANNEL = "makerlab-saver";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getDesignName() {
    const candidates = document.querySelectorAll("div[aria-label]");
    for (const el of candidates) {
      if (el.children.length > 0) continue;
      const text = el.textContent.trim();
      if (text && el.getAttribute("aria-label") === text) return text;
    }
    return "";
  }

  function getCustomizableName() {
    const input = document.querySelector('input[role="combobox"]');
    return input ? input.value.trim() : "";
  }

  // ── Capture logic ───────────────────────────────────────────────────

  function sendCaptured(payload, source) {
    window.postMessage({ channel: CHANNEL, type: "captured", payload }, "*");
    console.log(`[MakerLab Saver] Captured via ${source}:`, payload.designId);
  }

  function tryCapturePayload(bodyText, source) {
    try {
      const parsed = JSON.parse(bodyText);

      const base = {
        type: parsed.type || "obj",
        color: parsed.color || "",
        designId: parsed.designId || null,
        designName: getDesignName(),
        customizableName: getCustomizableName(),
        capturedAt: new Date().toISOString(),
        rawPayload: bodyText,
      };

      // New format: { designId, uniqueKey, parameters: JSON string }
      if (parsed.designId && parsed.parameters) {
        let paramObj;
        if (typeof parsed.parameters === "string") {
          try { paramObj = JSON.parse(parsed.parameters); } catch { paramObj = {}; }
        } else {
          paramObj = parsed.parameters;
        }

        const params = Object.entries(paramObj).map(([name, value]) => ({
          name,
          value,
          type: typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string",
          options: null,
          section: "",
          comment: "",
          raw: String(value),
        }));

        sendCaptured({
          ...base,
          code: "",
          params: "",
          parsedParams: params,
          uniqueKey: parsed.uniqueKey || "",
        }, source);
        return;
      }

      // Legacy format: { code (base64), type, params (base64 -D overrides) }
      if (parsed.code && parsed.type) {
        sendCaptured({
          ...base,
          code: atob(parsed.code),
          params: parsed.params ? atob(parsed.params) : "",
        }, source);
      }
    } catch (e) {
      console.debug("[MakerLab Saver] Capture failed:", e.message);
    }
  }

  // Intercept fetch — use Object.defineProperty so the override sticks
  // even if page code tries to cache or reassign window.fetch.
  const originalFetch = window.fetch.bind(window);
  function patchedFetch(...args) {
    const [resource, init] = args;

    let method, body;
    if (resource instanceof Request) {
      method = resource.method;
      body = resource.body || init?.body;
    } else {
      method = init?.method;
      body = init?.body;
    }

    if (method?.toUpperCase() === "POST") {
      if (typeof body === "string") {
        tryCapturePayload(body, "fetch");
      } else if (body instanceof Blob) {
        body.text().then((t) => tryCapturePayload(t, "fetch"));
      } else if (body instanceof ArrayBuffer) {
        tryCapturePayload(new TextDecoder().decode(body), "fetch");
      } else if (resource instanceof Request) {
        try {
          const cloned = resource.clone();
          cloned.text().then((t) => tryCapturePayload(t, "fetch-stream"));
        } catch (e) {
          console.debug("[MakerLab Saver] Could not read stream body:", e.message);
        }
      }
    }
    return originalFetch(...args);
  }
  Object.defineProperty(window, "fetch", {
    get() { return patchedFetch; },
    set() { /* block page from overwriting our hook */ },
    configurable: true,
  });

  // Intercept XHR
  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) {
    this.__ml_method = m;
    return origXHROpen.call(this, m, u, ...r);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__ml_method?.toUpperCase() === "POST" && body) {
      if (typeof body === "string") tryCapturePayload(body, "XHR");
      else if (body instanceof Blob)
        body.text().then((t) => tryCapturePayload(t, "XHR"));
    }
    return origXHRSend.call(this, body);
  };

  // ── Field discovery ─────────────────────────────────────────────────

  function varNameToLabel(name) {
    return name.replace(/_/g, " ").toLowerCase();
  }

  function isLabelDiv(el, container) {
    if (el.tagName !== "DIV") return false;
    if (el.children.length > 0) return false;
    const text = el.textContent.trim();
    if (text.length === 0 || text.length > 80) return false;
    // Reject divs nested inside interactive controls
    let parent = el.parentElement;
    while (parent && parent !== container) {
      const role = parent.getAttribute("role");
      if (role === "combobox" || role === "listbox" || role === "option") return false;
      if (parent.tagName === "BUTTON") return false;
      parent = parent.parentElement;
    }
    return true;
  }

  function findLabelIn(container) {
    const divs = container.querySelectorAll("div");
    for (const div of divs) {
      if (isLabelDiv(div, container)) return div;
    }
    return null;
  }

  function findAllFields() {
    const fields = {};
    const allInputs = document.querySelectorAll("input");

    for (const input of allInputs) {
      if (input.type === "hidden") continue;

      const wrapper = input.closest("div");
      if (!wrapper) continue;

      // Walk up to find a container that also holds a label div
      let container = wrapper;
      let labelEl = null;
      for (let i = 0; i < 5; i++) {
        labelEl = findLabelIn(container);
        if (labelEl && labelEl !== input) break;
        labelEl = null;
        if (!container.parentElement) break;
        container = container.parentElement;
        if (container.tagName !== "DIV") break;
      }

      if (!labelEl) continue;
      const label = labelEl.textContent.trim().toLowerCase();
      if (!label) continue;

      if (input.type === "checkbox") {
        if (!fields[label]) {
          fields[label] = { type: "checkbox", element: input, wrapper: container };
        }
      } else if (input.getAttribute("role") === "combobox") {
        continue;
      } else {
        const combobox = container.querySelector('[role="combobox"]');
        if (combobox) {
          if (!fields[label]) {
            fields[label] = {
              type: "select",
              element: input,
              combobox,
              wrapper: container,
            };
          }
        } else if (input.offsetParent !== null) {
          if (fields[label] && fields[label].type === "array") {
            fields[label].elements.push(input);
          } else if (fields[label] && fields[label].type === "text") {
            fields[label] = {
              type: "array",
              elements: [fields[label].element, input],
              wrapper: container,
            };
          } else if (!fields[label]) {
            fields[label] = { type: "text", element: input, wrapper: container };
          }
        }
      }
    }

    return fields;
  }

  // ── Input setters ───────────────────────────────────────────────────

  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  ).set;

  function setReactInput(input, value) {
    // Focus the input first so React registers the interaction
    input.focus();
    nativeSetter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  }

  async function setMUISelect(field, value) {
    const { combobox, element } = field;
    if (!combobox) return false;

    // Skip if already set to the right value
    if (element.value === String(value)) return true;

    // Open dropdown - try mousedown first, then focus+click as fallback
    combobox.focus();
    combobox.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    );

    let listbox = null;
    for (let i = 0; i < 15; i++) {
      await sleep(50);
      listbox = document.querySelector('[role="listbox"]');
      if (listbox) break;
    }

    if (!listbox) {
      combobox.click();
      for (let i = 0; i < 15; i++) {
        await sleep(50);
        listbox = document.querySelector('[role="listbox"]');
        if (listbox) break;
      }
    }

    if (!listbox) {
      console.warn(`[MakerLab Saver] Dropdown didn't open for:`, value);
      return false;
    }

    const options = listbox.querySelectorAll('[role="option"], li');
    const strValue = String(value);
    const lowerValue = strValue.toLowerCase();

    let exact = null, caseMatch = null, prefixMatch = null, prefixLen = Infinity;
    for (const opt of options) {
      const raw = opt.textContent.replace(/\s+/g, " ").trim();
      if (raw === strValue) { exact = opt; break; }
      const lower = raw.toLowerCase();
      if (!caseMatch && lower === lowerValue) caseMatch = opt;
      if (lower.startsWith(lowerValue) && raw.length < prefixLen) {
        prefixMatch = opt;
        prefixLen = raw.length;
      }
    }

    const match = exact || caseMatch || prefixMatch;
    if (match) {
      match.click();
    } else {
      console.warn(`[MakerLab Saver] Option "${strValue}" not found`);
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    }

    for (let i = 0; i < 10; i++) {
      if (!document.querySelector('[role="listbox"]')) break;
      await sleep(100);
    }

    return !!match;
  }

  function setCheckbox(input, value) {
    const target = value === true || value === "true";
    if (input.checked === target) return true;
    input.click();
    if (input.checked === target) return true;
    const parent = input.closest("span");
    if (parent) parent.click();
    return input.checked === target;
  }

  // ── Restore orchestrator ────────────────────────────────────────────

  async function restoreConfig(params) {
    const results = { matched: 0, skipped: 0, failed: 0, details: [] };

    // First pass: set all text/number inputs (fast, less disruptive)
    // Second pass: set all dropdowns (slow, needs sequential operation)
    // Third pass: set checkboxes

    const fields = findAllFields();
    const textParams = [];
    const selectParams = [];
    const checkboxParams = [];
    const noField = [];

    const arrayParams = [];

    for (const param of params) {
      const label = varNameToLabel(param.name);
      const field = fields[label];
      if (!field) {
        noField.push(param);
        continue;
      }
      if (field.type === "array") arrayParams.push({ param, field });
      else if (field.type === "text") textParams.push({ param, field });
      else if (field.type === "select") selectParams.push({ param, field });
      else if (field.type === "checkbox") checkboxParams.push({ param, field });
    }

    // Log skipped params (not in UI)
    for (const param of noField) {
      results.skipped++;
      results.details.push({ name: param.name, status: "no_field" });
    }

    // Pass 1a: text inputs with small delays
    for (const { param, field } of textParams) {
      try {
        setReactInput(field.element, param.value);
        results.matched++;
        results.details.push({ name: param.name, status: "ok" });
      } catch (e) {
        results.failed++;
        results.details.push({ name: param.name, status: "error", error: e.message });
      }
      await sleep(30);
    }

    // Pass 1b: array/grouped inputs
    for (const { param, field } of arrayParams) {
      try {
        const values = Array.isArray(param.value) ? param.value : [param.value];
        for (let i = 0; i < Math.min(values.length, field.elements.length); i++) {
          setReactInput(field.elements[i], values[i]);
          await sleep(30);
        }
        results.matched++;
        results.details.push({ name: param.name, status: "ok" });
      } catch (e) {
        results.failed++;
        results.details.push({ name: param.name, status: "error", error: e.message });
      }
    }

    // Wait for React to settle after all text inputs
    await sleep(300);

    // Pass 2: dropdowns - strictly sequential with generous delays
    for (const { param, field } of selectParams) {
      try {
        const ok = await setMUISelect(field, param.value);
        if (ok) {
          results.matched++;
          results.details.push({ name: param.name, status: "ok" });
        } else {
          results.failed++;
          results.details.push({ name: param.name, status: "select_fail" });
        }
      } catch (e) {
        results.failed++;
        results.details.push({ name: param.name, status: "error", error: e.message });
      }
      // Extra settle time between dropdowns
      await sleep(200);
    }

    // Wait for React to settle after dropdowns
    await sleep(300);

    // Pass 3: checkboxes
    for (const { param, field } of checkboxParams) {
      try {
        const ok = setCheckbox(field.element, param.value);
        if (ok) {
          results.matched++;
          results.details.push({ name: param.name, status: "ok" });
        } else {
          results.failed++;
          results.details.push({ name: param.name, status: "checkbox_fail" });
        }
      } catch (e) {
        results.failed++;
        results.details.push({ name: param.name, status: "error", error: e.message });
      }
      await sleep(30);
    }

    return results;
  }

  // ── Message listener ────────────────────────────────────────────────

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (event.data?.channel !== CHANNEL) return;

    if (event.data.type === "restore") {
      console.log(
        "[MakerLab Saver] Restoring",
        event.data.params.length,
        "params…"
      );
      const results = await restoreConfig(event.data.params);
      console.log("[MakerLab Saver] Done:", results);
      window.postMessage(
        { channel: CHANNEL, type: "restoreResult", results },
        "*"
      );
    }

    if (event.data.type === "queryDesignInfo") {
      window.postMessage(
        {
          channel: CHANNEL,
          type: "designInfoResult",
          callbackId: event.data.callbackId,
          designName: getDesignName(),
          customizableName: getCustomizableName(),
        },
        "*"
      );
    }

    if (event.data.type === "scanFields") {
      const fields = findAllFields();
      const list = Object.entries(fields).map(([label, f]) => ({
        label,
        type: f.type,
        value:
          f.type === "array"
            ? f.elements.map((el) => el.value)
            : f.type === "checkbox"
              ? f.element.checked
              : f.element.value,
      }));
      window.postMessage(
        { channel: CHANNEL, type: "scanResult", fields: list },
        "*"
      );
    }
  });

  console.log("[MakerLab Saver] Page-level intercept installed.");
})();

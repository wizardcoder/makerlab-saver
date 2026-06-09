// MakerLab Config Saver — Page-level script (MAIN WORLD)

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

  function tryCapturePayload(bodyText, source) {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed.code && parsed.type) {
        window.postMessage(
          {
            channel: CHANNEL,
            type: "captured",
            payload: {
              code: atob(parsed.code),
              params: parsed.params ? atob(parsed.params) : "",
              type: parsed.type,
              color: parsed.color || "",
              designId: parsed.designId || null,
              designName: getDesignName(),
              customizableName: getCustomizableName(),
              capturedAt: new Date().toISOString(),
              rawPayload: bodyText,
            },
          },
          "*"
        );
        console.log(`[MakerLab Saver] Captured via ${source}:`, parsed.designId);
      }
    } catch (e) {}
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const [, init] = args;
    if (init?.method?.toUpperCase() === "POST" && init?.body) {
      if (typeof init.body === "string")
        tryCapturePayload(init.body, "fetch");
      else if (init.body instanceof Blob)
        init.body.text().then((t) => tryCapturePayload(t, "fetch"));
      else if (init.body instanceof ArrayBuffer)
        tryCapturePayload(new TextDecoder().decode(init.body), "fetch");
    }
    return originalFetch.apply(this, args);
  };

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

    // Open dropdown — try mousedown first, then focus+click as fallback
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

    // Find and click the matching option
    const options = listbox.querySelectorAll('[role="option"], li');
    let matched = false;
    const strValue = String(value);
    const lowerValue = strValue.toLowerCase();

    // Pass 1: exact match (after whitespace normalisation)
    for (const opt of options) {
      const optText = opt.textContent.replace(/\s+/g, " ").trim();
      if (optText === strValue) {
        opt.click();
        matched = true;
        break;
      }
    }

    // Pass 2: case-insensitive match or option starts with the saved value
    // Handles OpenSCAD key:label mismatches (e.g. saved "cullenect" → "Cullenect click labels V2")
    if (!matched) {
      for (const opt of options) {
        const optText = opt.textContent.replace(/\s+/g, " ").trim().toLowerCase();
        if (optText === lowerValue || optText.startsWith(lowerValue)) {
          opt.click();
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      console.warn(`[MakerLab Saver] Option "${strValue}" not found. Available:`,
        [...options].map(o => JSON.stringify(o.textContent)));
      // Close dropdown with Escape
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          keyCode: 27,
          bubbles: true,
        })
      );
      // Also try pressing Escape on the listbox parent
      await sleep(50);
      const stillOpen = document.querySelector('[role="listbox"]');
      if (stillOpen) {
        stillOpen.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            keyCode: 27,
            bubbles: true,
          })
        );
      }
      console.warn(`[MakerLab Saver] Option "${value}" not found`);
    }

    // Wait for dropdown to fully close and React to settle
    await sleep(200);

    // Verify it's actually closed before continuing
    for (let i = 0; i < 10; i++) {
      if (!document.querySelector('[role="listbox"]')) break;
      await sleep(100);
    }

    return matched;
  }

  function setCheckbox(input, value) {
    const target = value === true || value === "true";
    if (input.checked !== target) {
      input.click();
      if (input.checked !== target) {
        const parent = input.closest("span");
        if (parent) parent.click();
      }
    }
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

    // Pass 2: dropdowns — strictly sequential with generous delays
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
        setCheckbox(field.element, param.value);
        results.matched++;
        results.details.push({ name: param.name, status: "ok" });
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

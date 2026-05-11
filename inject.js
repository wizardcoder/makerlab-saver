// MakerLab Config Saver — Page-level script (MAIN WORLD)

(function () {
  "use strict";

  const CHANNEL = "makerlab-saver";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getDesignName() {
    const el = document.querySelector('.mw-css-1ab7fra[aria-label]');
    return el ? el.textContent.trim() : "";
  }

  function getCustomizableName() {
    const input = document.querySelector('.MuiAutocomplete-inputRoot input[role="combobox"]');
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

  function findAllFields() {
    const fields = {};

    // Pass 1: text inputs and selects via the reliable column wrapper
    const columnWrappers = document.querySelectorAll(
      'div[style*="flex-direction: column"]'
    );
    for (const wrapper of columnWrappers) {
      const labelEl = wrapper.querySelector(
        'div[style*="font-weight: 600"][style*="font-size: 14px"]'
      );
      if (!labelEl) continue;

      const label = labelEl.textContent.trim().toLowerCase();
      if (!label) continue;

      const textInput = wrapper.querySelector("input.mw-css-528tg4");
      const selectNative = wrapper.querySelector(
        'input[class*="Select-nativeInput"]'
      );
      const combobox = wrapper.querySelector('[role="combobox"]');

      if (textInput) {
        fields[label] = { type: "text", element: textInput, wrapper };
      } else if (selectNative && combobox) {
        fields[label] = {
          type: "select",
          element: selectNative,
          combobox,
          wrapper,
        };
      }
    }

    // Pass 2: checkboxes/switches via the space-between row wrapper
    const rowWrappers = document.querySelectorAll(
      'div[style*="justify-content: space-between"]'
    );
    for (const wrapper of rowWrappers) {
      const labelEl = wrapper.querySelector(
        'div[style*="font-weight: 600"][style*="font-size: 14px"]'
      );
      if (!labelEl) continue;

      const label = labelEl.textContent.trim().toLowerCase();
      if (!label || fields[label]) continue;

      const checkbox =
        wrapper.querySelector("input.MuiSwitch-input") ||
        wrapper.querySelector('.MuiCheckbox-root input[type="checkbox"]') ||
        wrapper.querySelector('input[type="checkbox"]');

      if (checkbox) {
        fields[label] = { type: "checkbox", element: checkbox, wrapper };
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

    // Open dropdown via mousedown (MUI listens on mousedown, not click)
    combobox.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    );

    // Wait for listbox to appear in the DOM (MUI portals it to body)
    let listbox = null;
    for (let i = 0; i < 30; i++) {
      await sleep(50);
      // MUI renders the listbox as a direct child of body or a portal
      listbox = document.querySelector('[role="listbox"]');
      if (listbox) break;
    }

    if (!listbox) {
      console.warn(`[MakerLab Saver] Dropdown didn't open for:`, value);
      return false;
    }

    // Find and click the matching option
    const options = listbox.querySelectorAll('[role="option"], li');
    let matched = false;

    for (const opt of options) {
      if (opt.textContent.trim() === String(value)) {
        opt.click();
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Close dropdown with Escape on the body/backdrop
      const backdrop = document.querySelector(".MuiBackdrop-root, .MuiModal-backdrop");
      if (backdrop) {
        backdrop.click();
      } else {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            keyCode: 27,
            bubbles: true,
          })
        );
      }
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
      // Try clicking the input first
      input.click();
      // If that didn't work, try clicking the MUI Switch parent
      if (input.checked !== target) {
        const switchBase = input.closest(".MuiSwitch-switchBase");
        if (switchBase) switchBase.click();
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

    for (const param of params) {
      const label = varNameToLabel(param.name);
      const field = fields[label];
      if (!field) {
        noField.push(param);
        continue;
      }
      if (field.type === "text") textParams.push({ param, field });
      else if (field.type === "select") selectParams.push({ param, field });
      else if (field.type === "checkbox") checkboxParams.push({ param, field });
    }

    // Log skipped params (not in UI)
    for (const param of noField) {
      results.skipped++;
      results.details.push({ name: param.name, status: "no_field" });
    }

    // Pass 1: text inputs with small delays
    for (const { param, field } of textParams) {
      try {
        setReactInput(field.element, param.value);
        results.matched++;
        results.details.push({ name: param.name, status: "ok" });
      } catch (e) {
        results.failed++;
        results.details.push({ name: param.name, status: "error", error: e.message });
      }
      // Small delay to let React process each change
      await sleep(30);
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

    if (event.data.type === "scanFields") {
      const fields = findAllFields();
      const list = Object.entries(fields).map(([label, f]) => ({
        label,
        type: f.type,
        value:
          f.type === "checkbox" ? f.element.checked : f.element.value,
      }));
      window.postMessage(
        { channel: CHANNEL, type: "scanResult", fields: list },
        "*"
      );
    }
  });

  console.log("[MakerLab Saver] Page-level intercept installed.");
})();

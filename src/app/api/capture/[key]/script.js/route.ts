import { messagingConfig } from "@/server/messaging/config";

// The snippet a website loads with <script src=".../api/capture/<key>/script.js">.
// It watches every form on the page and, when one is sent, posts a copy of the
// answers to ShabCRM. The site's own form carries on exactly as before.
const SCRIPT = String.raw`(function () {
  if (window.__shabcrmCapture) return;
  window.__shabcrmCapture = 1;
  var ENDPOINT = __ENDPOINT__;
  var SKIP = ["submit", "button", "reset", "file", "hidden", "image", "password"];
  function text(el) { return el ? (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : ""; }
  function labelFor(el) {
    if (el.labels && el.labels.length) return text(el.labels[0]);
    var by = el.getAttribute("aria-labelledby");
    if (by && document.getElementById(by)) return text(document.getElementById(by));
    return el.getAttribute("aria-label") || el.getAttribute("placeholder") || text(el.closest("label")) || "";
  }
  function groupLabel(el) {
    var set = el.closest("fieldset");
    var legend = set && set.querySelector("legend");
    return legend ? text(legend) : el.name;
  }
  function send(form) {
    if (!form || form.tagName !== "FORM" || form.hasAttribute("data-shabcrm-ignore")) return;
    var fields = [];
    for (var i = 0; i < form.elements.length; i++) {
      var el = form.elements[i];
      var type = (el.type || el.tagName || "").toLowerCase();
      if (type === "password") return; // never touch sign-in forms
      if (!el.name && !el.id) continue;
      if (SKIP.indexOf(type) > -1) continue;
      if ((type === "checkbox" || type === "radio") && !el.checked) continue;
      var value = el.tagName === "SELECT" && el.multiple
        ? Array.prototype.map.call(el.selectedOptions, function (o) { return o.value; }).join(", ")
        : el.value;
      if (!value) continue;
      var label = type === "checkbox" || type === "radio" ? groupLabel(el) : labelFor(el);
      fields.push({ name: el.name || el.id, label: (label || "").slice(0, 120), type: type, value: String(value).slice(0, 5000) });
    }
    if (!fields.length) return;
    var body = JSON.stringify({
      __shabcrm: 1,
      formKey: form.id || form.getAttribute("name") || "form-" + Array.prototype.indexOf.call(document.forms, form),
      formName: form.getAttribute("data-shabcrm-name") || form.getAttribute("aria-label") || form.getAttribute("name") || "",
      page: location.href,
      fields: fields
    });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain" }))) return;
    } catch (e) {}
    try { fetch(ENDPOINT, { method: "POST", body: body, keepalive: true, mode: "no-cors", headers: { "Content-Type": "text/plain" } }); } catch (e) {}
  }
  document.addEventListener("submit", function (e) { try { send(e.target); } catch (err) {} }, true);
})();
`;

export async function GET(_: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const safeKey = /^ws_[\w-]{10,40}$/.test(key) ? key : "invalid";
  const endpoint = `${messagingConfig().appUrl}/api/capture/${safeKey}`;
  return new Response(SCRIPT.replace("__ENDPOINT__", JSON.stringify(endpoint)), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

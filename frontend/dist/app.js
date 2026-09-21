// session1 frontend — no framework, no build step.
//
// Talks the node HTTP surface the way the substrate's own dapps do:
// query via POST /api/query; updates via /api/next_nonce + /api/call +
// /api/receipt polling. `arg`/`reply` are hex-encoded Candid bytes;
// the codec below covers exactly what the starter backend speaks
// (text, nat, nat64).

(function () {
  "use strict";

  const BACKEND_CANISTER_ID = 158344202516175;
  const BASE = ""; // same-origin through the boundary (/_/raw/<cid>/…)

  // ─── hex ───────────────────────────────────────────────────────────

  function bytesToHex(b) {
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  function hexToBytes(hex) {
    const clean = hex.length % 2 ? "0" + hex : hex;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  // ─── LEB128 ────────────────────────────────────────────────────────

  function uleb(n) {
    n = BigInt(n);
    const out = [];
    for (;;) {
      const byte = Number(n & 0x7fn);
      n >>= 7n;
      if (n === 0n) {
        out.push(byte);
        return out;
      }
      out.push(byte | 0x80);
    }
  }
  function ulebDecode(buf, off) {
    let result = 0n,
      shift = 0n;
    for (;;) {
      const byte = buf[off++];
      if (byte === undefined) throw new Error("candid: truncated uleb128");
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return [result, off];
      shift += 7n;
    }
  }
  function slebDecode(buf, off) {
    let result = 0n,
      shift = 0n;
    for (;;) {
      const byte = buf[off++];
      if (byte === undefined) throw new Error("candid: truncated sleb128");
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) {
        if (byte & 0x40) result -= 1n << shift;
        return [result, off];
      }
    }
  }

  // ─── Candid (text | nat | nat64) ───────────────────────────────────

  const MAGIC = [0x44, 0x49, 0x44, 0x4c]; // "DIDL"
  const TYPE_TEXT_SLEB = 0x71; // sleb128(-15)
  const TYPE_NAT = 0x7d; // nat
  const TYPE_BOOL = 0x7e; // bool
  const TYPE_VEC = -19;
  const TYPE_RECORD = -20;
  function encodeEmpty() {
    return bytesToHex(new Uint8Array([...MAGIC, 0, 0]));
  }
  function encodeText(s) {
    const utf8 = new TextEncoder().encode(s);
    return bytesToHex(
      new Uint8Array([...MAGIC, 0, 1, TYPE_TEXT_SLEB, ...uleb(utf8.length), ...utf8])
    );
  }

function encodeNat(n) {
  return bytesToHex(
    new Uint8Array([
      ...MAGIC,
      0,
      1,
      TYPE_NAT,
      ...uleb(n),
    ])
  );
}
function encodeNatAndText(id, text) {
  const utf8 = new TextEncoder().encode(text);
  // DIDL + 2 types (nat, text) + 2 args
  return bytesToHex(new Uint8Array([
   ...MAGIC, 0, 2, TYPE_NAT, TYPE_TEXT_SLEB,
   ...uleb(id),
   ...uleb(utf8.length),...utf8
  ]));
}

function encodeTodoId(id) {
  return encodeNat(id);
}
function decodeTodos(hex) {
  const buf = hexToBytes(hex);

  if (
    buf.length < 4 ||
    buf[0] !== 0x44 ||
    buf[1] !== 0x49 ||
    buf[2] !== 0x44 ||
    buf[3] !== 0x4c
  ) {
    throw new Error("candid: bad magic in todo reply");
  }

  let off = 4;

  // عدد الأنواع الموجودة في جدول Candid
  let typeCount;
  [typeCount, off] = ulebDecode(buf, off);

  const types = [];

  // قراءة جدول الأنواع
  for (let i = 0; i < Number(typeCount); i++) {
    let kind;
    [kind, off] = slebDecode(buf, off);

    // vec
    if (kind === -19n) {
      let inner;
      [inner, off] = slebDecode(buf, off);

      types.push({
        kind: "vec",
        inner,
      });
    }

    // record
    else if (kind === -20n) {
      let fieldCount;
      [fieldCount, off] = ulebDecode(buf, off);

      const fields = [];

      for (let j = 0; j < Number(fieldCount); j++) {
        let hash;
        [hash, off] = ulebDecode(buf, off);

        let fieldType;
        [fieldType, off] = slebDecode(buf, off);

        fields.push({
          hash,
          fieldType,
        });
      }

      types.push({
        kind: "record",
        fields,
      });
    }

    // نوع أساسي مثل nat أو text أو bool
    else {
      types.push({
        kind: "primitive",
        kindValue: kind,
      });
    }
  }

  // عدد القيم المرجعة
  let argCount;
  [argCount, off] = ulebDecode(buf, off);

  if (argCount !== 1n) {
    throw new Error("expected one return value");
  }

  // النوع الرئيسي للرد
  let rootType;
  [rootType, off] = slebDecode(buf, off);

  if (rootType < 0n) {
    throw new Error("expected a vector return type");
  }

  const vectorType = types[Number(rootType)];

  if (!vectorType || vectorType.kind !== "vec") {
    throw new Error("expected vec return type");
  }

  // عدد عناصر المصفوفة
  let lengthResult;
  [lengthResult, off] = ulebDecode(buf, off);

  const count = Number(lengthResult);
  const todos = [];

  // نوع العنصر داخل vec، وهو Todo record
  const recordTypeIndex = vectorType.inner;

  for (let i = 0; i < count; i++) {
    const result = decodeTodoRecord(
      buf,
      off,
      recordTypeIndex,
      types
    );

    todos.push(result.value);
    off = result.offset;
  }

  return todos;
}

function formatTimestamp(nano) {
  // Motoko Time.now() بالنانو، نحوله لميلي ثانية
  const ms = Number(nano / 1000000n);
  const d = new Date(ms);
  return d.toLocaleString('en-US', {
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    hour12: true
  });
}

function decodeTodoRecord(buf, off, recordTypeIndex, types) {
  const recordType = types[Number(recordTypeIndex)];
  const todo = { id: 0n, text: "", completed: false, timestamp: 0n };
  for (const field of recordType.fields) {
    const res = decodeCandidValue(buf, off, field.fieldType, types);
    off = res.offset;
    if (res.type === "nat") todo.id = res.value;
    else if (res.type === "text") todo.text = res.value;
    else if (res.type === "bool") todo.completed = res.value;
    else if (res.type === "int") todo.timestamp = res.value;
  }
  return { value: todo, offset: off };
}

function decodeCandidValue(buf, off, type, types) {
  if (type >= 0n) {
    const tableType = types[Number(type)];
    if (!tableType || tableType.kind!== "primitive") {
      throw new Error("unsupported nested Candid type");
    }
    type = tableType.kindValue;
  }

  if (type === -3n) { // nat
    const result = ulebDecode(buf, off);
    return { value: result[0], offset: result[1], type: "nat" };
  }

  if (type === -15n) { // text
    let lengthResult;
    [lengthResult, off] = ulebDecode(buf, off);
    const length = Number(lengthResult);
    const end = off + length;
    if (end > buf.length) throw new Error("candid: truncated text");
    return { value: new TextDecoder().decode(buf.slice(off, end)), offset: end, type: "text" };
  }

  if (type === -2n) { // bool
    if (off >= buf.length) throw new Error("candid: truncated bool");
    return { value: buf[off]!== 0, offset: off + 1, type: "bool" };
  }

  if (type === -4n) { // int -> timestamp
    const result = slebDecode(buf, off);
    return { value: result[0], offset: result[1], type: "int" };
  }

  throw new Error("unsupported Candid value type: " + type);
}

  function decodeReply(hex) {
    const buf = hexToBytes(hex);
    if (buf.length < 6 || buf[0] !== 0x44 || buf[1] !== 0x49 || buf[2] !== 0x44 || buf[3] !== 0x4c) {
      throw new Error("candid: bad magic in reply");
    }
    let off = 4,
      v;
    [v, off] = ulebDecode(buf, off); // type-table count
    if (v !== 0n) throw new Error("candid: compound reply types not supported by this starter");
    [v, off] = ulebDecode(buf, off); // arg count
    if (v === 0n) return "";
    let ty;
    [ty, off] = slebDecode(buf, off);
    if (ty === -15n) {
      let len;
      [len, off] = ulebDecode(buf, off);
      return new TextDecoder().decode(buf.slice(off, off + Number(len)));
    }
    if (ty === -2n) {
  return buf[off] !== 0;
}

    if (ty === -3n) {
      return ulebDecode(buf, off)[0];
    }
    if (ty === -8n) {
      let out = 0n;
      for (let i = 7; i >= 0; i--) out = (out << 8n) | BigInt(buf[off + i]);
      return out;
    }
    throw new Error("candid: unsupported reply type " + ty);
  }

  // ─── demo sender (per-browser; use Memphis for real identity) ──────

  function demoSender() {
    // Scoped per backend cid — see the React client for why: one origin
    // shared by every app means an unscoped key collides nonce sequences.
    const KEY = "thebes-demo-sender:" + BACKEND_CANISTER_ID;
    let s = localStorage.getItem(KEY);
    if (!s) {
      const b = new Uint8Array(8);
      crypto.getRandomValues(b);
      s = bytesToHex(b);
      localStorage.setItem(KEY, s);
    }
    return s;
  }

  // ─── transient-tolerant fetch ──────────────────────────────────────
  //
  // The boundary fans out to a validator set; when one validator is
  // briefly unreachable the gateway answers 502 "validator
  // unreachable". That is transient — the next attempt routes
  // elsewhere. Retry reads and pre-submit steps with backoff. The
  // submitted update itself is never retried (double-execution risk);
  // its receipt is polled instead.

  const RETRIES = 3;

  function isTransient(status, body) {
    return (
      status === 502 ||
      status === 503 ||
      status === 504 ||
      /validator unreachable|no healthy validator|unhealthy/i.test(body)
    );
  }

  async function fetchWithRetry(url, init) {
    let lastErr = "";
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
      try {
        const r = await fetch(url, init);
        const text = await r.text();
        if (!r.ok && isTransient(r.status, text)) {
          lastErr = "HTTP " + r.status + ": " + text.slice(0, 200);
          continue;
        }
        try {
          return JSON.parse(text);
        } catch (_) {
          throw new Error("malformed reply: " + text.slice(0, 200));
        }
      } catch (e) {
        lastErr = String(e);
      }
    }
    throw new Error("the network is briefly unreachable — please try again (" + lastErr + ")");
  }

  // ─── wire motions ──────────────────────────────────────────────────

  async function query(method, argHex) {
    const j = await fetchWithRetry(BASE + "/api/query", {
      method: "POST",
      headers: { "content-type": "application/json", },
      body: JSON.stringify({
        canister_id: BACKEND_CANISTER_ID,
        method,
        arg: argHex,
        sender: demoSender(),
      }),
    });
    if (j.status !== "success") {
  throw new Error(j.error || "query failed");
}
return j.reply || "";
  }

  async function call(method, argHex) {
    const sender = demoSender();
    const nj = await fetchWithRetry(BASE + "/api/next_nonce?sender=" + sender, {
      cache: "no-store",
    });
    if (typeof nj.next_nonce !== "number") throw new Error("malformed next_nonce reply");
    // Deliberately not retried: a retry after a submit that landed
    // would execute the update twice.
    async function submit(nonce) {
      const r = await fetch(BASE + "/api/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          canister_id: BACKEND_CANISTER_ID,
          method,
          arg: argHex,
          sender,
          nonce,
        }),
      });
      const text = await r.text();
      if (!r.ok && isTransient(r.status, text)) {
        throw new Error("the network is briefly unreachable — please try again");
      }
      return JSON.parse(text);
    }
    let j = await submit(nj.next_nonce);
    // Nonce recovery: a replay rejection means our nonce was behind the
    // substrate's replay set and the call did NOT execute, so re-submitting
    // is safe. The rejection names the real high-water mark
    // ("nonce 0 already used (last seen: 8)") — resubmit at last_seen + 1.
    if (!j.queued && typeof j.error === "string" && /nonce .* already used/i.test(j.error)) {
      const m = j.error.match(/last seen:\s*(\d+)/i);
      j = await submit(m ? Number(m[1]) + 1 : nj.next_nonce + 1);
    }
    if (!j.queued || !j.message_hash) throw new Error(j.error || "call rejected");
    const deadline = Date.now() + 30000;
    let transientPolls = 0;
    while (Date.now() < deadline) {
      try {
        const rj = await fetchWithRetry(BASE + "/api/receipt?hash=" + j.message_hash);
        if (rj.found) {
          if (rj.status === "success"){return rj.reply || "";} 
          throw new Error(rj.error || "call failed on chain");}
        
      } catch (e) {
        // A transient during polling doesn't mean the call failed.
        if (++transientPolls > 10) throw e;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error("timed out waiting for the chain's receipt");
  }

  // ─── theme (light / dark / follow-the-OS) ──────────────────────────
  //
  // Three states, not two: with no stored choice the CSS media query
  // follows the operating system; an explicit choice writes
  // data-theme on <html>, which the stylesheet ranks above the query.
  // The key is scoped per app — every app on the gateway shares one
  // origin, so an unscoped key would let one project set another's theme.

  const THEME_KEY = "thebes-theme:" + BACKEND_CANISTER_ID;

  function osPrefersDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function storedTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return v === "light" || v === "dark" ? v : "auto";
    } catch (_) {
      return "auto";
    }
  }
  function effectiveTheme() {
    const t = storedTheme();
    return t === "auto" ? (osPrefersDark() ? "dark" : "light") : t;
  }
  function applyTheme() {
    const t = storedTheme();
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    const btn = document.getElementById("theme-toggle");
    if (btn) {
      const dark = effectiveTheme() === "dark";
      btn.textContent = dark ? "☀" : "☾";
      const label = "Switch to " + (dark ? "light" : "dark") + " mode";
      btn.setAttribute("aria-label", label);
      btn.title = label;
    }
  }
  applyTheme();

  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      const next = effectiveTheme() === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch (_) {
        /* storage blocked — nothing to persist */
      }
      applyTheme();
    });
  }

  // ─── UI wiring ─────────────────────────────────────────────────────

  const errorEl = document.getElementById("error");
const form = document.getElementById("todo-form");
const input = document.getElementById("todo-input");
const list = document.getElementById("todo-list");
const summary = document.getElementById("todo-summary");
const addButton = document.getElementById("add-button");

let todos = [];

function showError(error) {
  errorEl.textContent = String(error);
  errorEl.hidden = false;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

let editingId = null;

const editModal = document.getElementById("edit-modal");
const editInput = document.getElementById("edit-input");

function renderTodos() {
  list.innerHTML = "";
  todos.forEach((todo) => {
    const li = document.createElement("li");
    li.className = todo.completed? "todo completed" : "todo";

    const left = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = todo.completed;
    checkbox.addEventListener("change", async () => {
      checkbox.disabled = true;
      try {
        await call("toggleTodo", encodeNat(todo.id));
        await loadTodos();
      } catch (e) { showError(e); } finally { checkbox.disabled = false; }
    });
    const textWrap = document.createElement("div");
    textWrap.style.display = "flex";
    textWrap.style.flexDirection = "column";

    const text = document.createElement("span");
    text.textContent = todo.text;

    const time = document.createElement("small");
    time.textContent = formatTimestamp(todo.timestamp);
    time.style.fontSize = "15px";
    time.style.fontWeight = "600";
    time.style.color = "#020706";
    time.style.opacity = "1";
    time.style.marginTop = "2px";
    
    textWrap.appendChild(text);
    textWrap.appendChild(time);
    
    left.appendChild(checkbox);
    left.appendChild(textWrap);
    
    const actions = document.createElement("div");
    actions.className = "todo-actions";

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.className = "btn-pin";
    editBtn.addEventListener("click", () => {
      editingId = todo.id;
      editInput.value = todo.text;
      editModal.hidden = false;
    });

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.className = "btn-del";
    delBtn.addEventListener("click", async () => {
      if (!confirm("Delete this task?")) return;
      try {
        // لو الـ backend عندك اسم الدالة removeTodo غيره هنا
        await call("deleteTodo", encodeNat(todo.id));
        await loadTodos();
      } catch (e) { showError(e); }
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    li.appendChild(left);
    li.appendChild(actions);
    list.appendChild(li);
  });
  const pending = todos.filter((t) =>!t.completed).length;
  summary.textContent = `${pending} of ${todos.length} pending`;
}

// Modal logic
document.getElementById("cancel-edit").addEventListener("click", () => {
  editModal.hidden = true;
  editingId = null;
});
document.getElementById("save-edit").addEventListener("click", async () => {
  const newText = editInput.value.trim();
  if (!newText || editingId === null) return;
  try {
    // لو الـ backend عندك اسم الدالة updateTodo غيره هنا
    await call("editTodo", encodeNatAndText(editingId, newText));
    editModal.hidden = true;
    editingId = null;
    await loadTodos();
  } catch (e) { showError(e); }
});

async function loadTodos() {
  clearError();

  try {
    const reply = await query("getTodos", encodeEmpty());
    console.log("getTodos reply:", reply);
    todos = decodeTodos(reply);
    renderTodos();
  } catch (error) {
    console.error("loadTodos error:", error);
    showError(error);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  const text = input.value.trim();

  if (!text) {
    showError("Please enter a task");
    return;
  }

  addButton.disabled = true;
  addButton.textContent = "adding…";

  try {
    await call("addTodo", encodeText(text));
    input.value = "";
    await loadTodos();
  } catch (error) {
    showError(error);
  } finally {
    addButton.disabled = false;
    addButton.textContent = "Add";
  }
});

loadTodos();
})();

// ── State ────────────────────────────────────────────────────────────────────
let _apiCounter = 2;

function _newApiId() { return `api${++_apiCounter}`; }

function _apiColor(idx) {
  const palette = ['#6c63ff','#4ecdc4','#ffa502','#ff6b81','#a29bfe','#00cec9','#fd79a8','#fdcb6e'];
  return palette[idx % palette.length];
}

// postFields: apiId -> [{name, type, value, random, inject}]
// inject: if value starts with {{, treat as context injection (disable random)

const state = {
  spec: null,
  endpoints: [],
  mappings: [],           // [{apiId, field, asVar}]
  apis: [
    { id: 'api1', name: 'API 1', colorIdx: 0 },
    { id: 'api2', name: 'API 2', colorIdx: 1 },
  ],
  selections:        { api1: {}, api2: {} },
  baseUrls:          { api1: '', api2: '' },
  idFields:          { api1: 'id', api2: 'id' },
  postFields:        { api1: [], api2: [] },
  selectedResources: { api1: '', api2: '' },
  // ── new generic state ──
  apiOps:     { api1: {create:true,read:true,update:true,delete:true},
                api2: {create:true,read:true,update:true,delete:true} },
  apiHeaders:      { api1: [], api2: [] },
  apiAuth:         { api1: null, api2: null },
  responseSchemas: { api1: null, api2: null }, // POST response schema per api (from spec)
  executionSteps:  [], // [{uid, apiId, operation, enabled}] — user-ordered step list
};

function _initApiState(id, colorIdx) {
  state.selections[id]        = {};
  state.baseUrls[id]          = state.spec?.base_url || '';
  state.idFields[id]          = 'id';
  state.postFields[id]        = [];
  state.selectedResources[id] = '';
  state.apiOps[id]         = { create:true, read:true, update:true, delete:true };
  state.apiHeaders[id]     = [];
  state.apiAuth[id]        = null;
  state.responseSchemas[id] = null;
  state.apis.push({ id, name: `API ${colorIdx + 1}`, colorIdx });
  state.executionSteps = []; // force re-generate on next Run page visit
}

function addApi() {
  saveChainPageState();
  const id = _newApiId();
  const idx = state.apis.length;
  _initApiState(id, idx);
  renderChainPage();
}

function removeApi(apiId) {
  if (state.apis.length <= 2) { alert('Minimum 2 APIs required.'); return; }
  saveChainPageState();
  state.apis = state.apis.filter(a => a.id !== apiId);
  delete state.selections[apiId];
  delete state.baseUrls[apiId];
  delete state.idFields[apiId];
  delete state.postFields[apiId];
  delete state.selectedResources[apiId];
  delete state.apiOps[apiId];
  delete state.apiHeaders[apiId];
  delete state.apiAuth[apiId];
  delete state.responseSchemas[apiId];
  state.mappings = state.mappings.filter(m => m.apiId !== apiId);
  state.executionSteps = state.executionSteps.filter(s => s.apiId !== apiId);
  renderChainPage();
}

function moveApi(apiId, dir) {
  saveChainPageState();
  const idx = state.apis.findIndex(a => a.id === apiId);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= state.apis.length) return;
  // swap
  [state.apis[idx], state.apis[newIdx]] = [state.apis[newIdx], state.apis[idx]];
  renderChainPage();
}

function toggleOp(apiId, op, checked) {
  if (!state.apiOps[apiId]) state.apiOps[apiId] = {create:true,read:true,update:true,delete:true};
  state.apiOps[apiId][op] = checked;
}

function saveChainPageState() {
  state.apis.forEach(a => {
    const urlEl  = document.getElementById(`base-url-${a.id}`);
    const idEl   = document.getElementById(`id-field-${a.id}`);
    const nameEl = document.getElementById(`api-name-${a.id}`);
    if (urlEl)  state.baseUrls[a.id] = urlEl.value;
    if (idEl)   state.idFields[a.id] = idEl.value;
    if (nameEl) a.name = nameEl.value;
    ['post','get','put','delete'].forEach(m => {
      const sel = document.getElementById(`sel-${a.id}-${m}`);
      if (sel) state.selections[a.id][m] = sel.value;
    });
  });
}

// ── Field helpers ─────────────────────────────────────────────────────────────

// Return [{asVar, resourceName, apiName, fieldLabel}] from all APIs before apiId
function _prevApiVars(apiId) {
  const myIdx = state.apis.findIndex(a => a.id === apiId);
  const vars = [];
  for (let i = 0; i < myIdx; i++) {
    const a = state.apis[i];
    const rn = _resourceNameOf(a.id);

    // All fields from POST response schema
    const schema = state.responseSchemas[a.id];
    if (schema?.properties) {
      Object.entries(schema.properties).forEach(([field, prop]) => {
        vars.push({ asVar: `${a.id}_${field}`, resourceName: rn, apiName: a.name, fieldLabel: field, apiId: a.id });
      });
    } else {
      // fallback: at minimum the id field
      vars.push({ asVar: `${a.id}_id`, resourceName: rn, apiName: a.name, fieldLabel: state.idFields[a.id] || 'id', apiId: a.id });
    }

    // user-defined mappings on top
    state.mappings.filter(m => m.apiId === a.id && m.asVar)
      .forEach(m => vars.push({ asVar: m.asVar, resourceName: rn, apiName: a.name, fieldLabel: m.field, apiId: a.id }));
  }
  return vars;
}

function _resourceNameOf(apiId) {
  const res = state.selectedResources[apiId] || '';
  return res.toLowerCase().replace(/s$/, ''); // "products" → "product"
}

// Decide injection var for a field, or null
function _autoInject(fieldName, fieldType, prevVars) {
  const fl = fieldName.toLowerCase();
  for (const v of prevVars) {
    const rn = v.resourceName; // e.g. "product"
    // Exact resource ID field: productId, product_id, productid
    if (rn && (fl === rn + 'id' || fl === rn + '_id' || fl === rn + 'ids')) return v.asVar;
    // Field name is just "id" in non-first API
    if (fl === 'id' && fieldType === 'integer') return v.asVar;
  }
  return null;
}

// For array fields: build smart default using prev API id
function _arrayDefault(fieldName, prop, prevVars) {
  const fl = fieldName.toLowerCase();
  for (const v of prevVars) {
    const rn = v.resourceName; // "product"
    if (!rn) continue;
    // field name matches resource: "products", "productList", "items"
    if (fl.includes(rn)) {
      // determine inner id key
      const itemProps = prop?.items?.properties;
      const idKey = itemProps ? Object.keys(itemProps).find(k => k.toLowerCase() === 'id') || 'id' : 'id';
      return JSON.stringify([{ [idKey]: `{{${v.asVar}}}` }]);
    }
  }
  return null;
}

// Build source picker — grouped by API, all response fields shown
function _sourceOptions(apiId, currentValue) {
  const prevVars = _prevApiVars(apiId);
  const isManual = !currentValue.startsWith('{{') && currentValue !== '__random__';
  const isRandom = currentValue === '__random__';

  let opts = `<option value="__manual__" ${isManual?'selected':''}>⌨ Manual</option>`;
  opts    += `<option value="__random__" ${isRandom?'selected':''}>🎲 Random</option>`;

  if (!prevVars.length) return opts;

  // Group by apiId
  const grouped = {};
  const seen = new Set();
  for (const v of prevVars) {
    if (seen.has(v.asVar)) continue; seen.add(v.asVar);
    if (!grouped[v.apiId]) grouped[v.apiId] = { name: v.apiName, vars: [] };
    grouped[v.apiId].vars.push(v);
  }

  for (const [grpApiId, grp] of Object.entries(grouped)) {
    opts += `<optgroup label="⛓ ${grp.name} response">`;
    for (const v of grp.vars) {
      const sel = currentValue === `{{${v.asVar}}}` ? 'selected' : '';
      opts += `<option value="var:${v.asVar}" ${sel}>  → ${v.fieldLabel}  ({{${v.asVar}}})</option>`;
    }
    opts += `</optgroup>`;
  }
  return opts;
}

function onSourceChange(apiId, idx, val) {
  const f = state.postFields[apiId]?.[idx];
  if (!f) return;
  const inp = document.getElementById(`field-val-${apiId}-${idx}`);
  if (val === '__manual__') {
    f.value = inp ? inp.value : '';
    if (inp) { inp.disabled = false; inp.style.color = ''; inp.style.borderColor = ''; }
  } else if (val === '__random__') {
    f.value = _randomValueForType(f.type);
    f.random = true;
    if (inp) { inp.value = f.value; inp.disabled = false; inp.style.color = 'var(--success)'; inp.style.borderColor = ''; }
  } else if (val.startsWith('var:')) {
    const varName = val.slice(4);
    f.value = `{{${varName}}}`;
    if (inp) { inp.value = f.value; inp.disabled = false; inp.style.color = 'var(--accent)'; inp.style.borderColor = 'rgba(108,99,255,.5)'; }
  }
  updateJsonPreview(apiId);
}

// Resolve which API name provides a {{varName}} value
function _sourceApiForVar(varStr) {
  const varName = varStr.replace(/\{|\}/g, '').trim();
  // auto-var pattern: api1_id, api2_id …
  for (const a of state.apis) {
    if (varName === `${a.id}_id`) return a.name;
  }
  // user-defined mapping
  const m = state.mappings.find(mp => mp.asVar === varName);
  if (m) return state.apis.find(a => a.id === m.apiId)?.name || '';
  return '';
}

function _schemaToFields(schema, apiId) {
  if (!schema || schema.type !== 'object' || !schema.properties) return [];
  const prevVars = apiId ? _prevApiVars(apiId) : [];

  return Object.entries(schema.properties).map(([name, prop]) => {
    const type = prop.type || 'string';
    const fmt  = prop.format || '';

    // 1. Try auto-inject from previous API response
    const inject = _autoInject(name, type, prevVars);
    if (inject) return { name, type, value: `{{${inject}}}`, random: false };

    // 2. Array → try smart default
    if (type === 'array') {
      const arr = _arrayDefault(name, prop, prevVars);
      return { name, type, value: arr || '[]', random: false };
    }

    // 3. Use example if present
    if (prop.example != null) return { name, type, value: String(prop.example), random: true };

    // 4. Auto-random
    return { name, type, value: _randomValueForType(type, fmt), random: true };
  });
}

function _randomValueForType(type, fmt) {
  fmt = fmt || '';
  if (type === 'integer') return String(Math.floor(Math.random() * 1000) + 1);
  if (type === 'number')  return String((Math.random() * 100).toFixed(2));
  if (type === 'boolean') return String(Math.random() > 0.5);
  if (fmt === 'email')    return `user${Math.floor(Math.random()*9999)}@test.com`;
  if (fmt === 'uuid')     return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16); });
  if (fmt === 'date')     return new Date().toISOString().slice(0,10);
  // default string
  const words = ['test','sample','demo','alpha','beta','gamma','random','auto'];
  return words[Math.floor(Math.random()*words.length)] + Math.floor(Math.random()*999);
}

function randomField(apiId, idx) {
  const f = state.postFields[apiId]?.[idx];
  if (!f) return;
  f.value  = _randomValueForType(f.type);
  f.random = true;
  const inp = document.getElementById(`field-val-${apiId}-${idx}`);
  if (inp) inp.value = f.value;
}

function randomAllFields(apiId) {
  (state.postFields[apiId] || []).forEach((f, i) => {
    // skip injected ({{var}}) and array/object (complex types)
    if (!f.value.startsWith('{{') && f.type !== 'array' && f.type !== 'object') {
      f.value  = _randomValueForType(f.type);
      f.random = true;
    }
  });
  renderFieldEditor(apiId);
}

function addCustomField(apiId) {
  state.postFields[apiId] = state.postFields[apiId] || [];
  state.postFields[apiId].push({ name: '', type: 'string', value: '', random: false });
  renderFieldEditor(apiId);
}

function removeField(apiId, idx) {
  state.postFields[apiId].splice(idx, 1);
  renderFieldEditor(apiId);
}

function syncFieldValue(apiId, idx, val) {
  if (state.postFields[apiId]?.[idx]) state.postFields[apiId][idx].value = val;
}

function syncFieldName(apiId, idx, val) {
  if (state.postFields[apiId]?.[idx]) state.postFields[apiId][idx].name = val;
}

function syncFieldType(apiId, idx, val) {
  if (state.postFields[apiId]?.[idx]) state.postFields[apiId][idx].type = val;
}

function _fieldsToBody(apiId) {
  const fields = state.postFields[apiId] || [];
  const obj = {};
  for (const f of fields) {
    if (!f.name) continue;
    const raw = f.value;
    if (raw.startsWith('{{')) { obj[f.name] = raw; continue; }
    if (f.type === 'integer') { obj[f.name] = parseInt(raw) || 0; continue; }
    if (f.type === 'number')  { obj[f.name] = parseFloat(raw) || 0; continue; }
    if (f.type === 'boolean') { obj[f.name] = raw === 'true'; continue; }
    // array/object: try JSON parse
    if (f.type === 'array' || f.type === 'object') {
      try { obj[f.name] = JSON.parse(raw); continue; } catch {}
    }
    obj[f.name] = raw;
  }
  return obj;
}

// ── Navigation ────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.page));
});

function navigateTo(page) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'chain') renderChainPage();
  if (page === 'data')  renderDataPage();
  if (page === 'run')   renderRunPage();
}

// ── PAGE 1: Import ────────────────────────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) readFile(file);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) readFile(fileInput.files[0]); });

function readFile(file) {
  const reader = new FileReader();
  reader.onload = ev => { document.getElementById('spec-text').value = ev.target.result; };
  reader.readAsText(file);
}

document.getElementById('btn-clear-spec').addEventListener('click', () => {
  document.getElementById('spec-text').value = '';
  hide('spec-result'); hide('parse-error');
  state.spec = null; state.endpoints = [];
});

document.getElementById('btn-parse').addEventListener('click', async () => {
  const content = document.getElementById('spec-text').value.trim();
  if (!content) { showError('parse-error', 'Paste a spec first.'); return; }
  hide('parse-error');
  try {
    const res = await api('/api/parse-spec', { content });
    state.spec = res;
    state.endpoints = res.endpoints;
    renderEndpointList(res);
    show('spec-result');
  } catch (e) {
    showError('parse-error', e.message);
  }
});

document.getElementById('ep-search').addEventListener('input', function () {
  const q = this.value.toLowerCase();
  document.querySelectorAll('.endpoint-item').forEach(el => {
    el.style.display = (el.dataset.path + el.dataset.method + el.dataset.summary).toLowerCase().includes(q) ? '' : 'none';
  });
});

document.getElementById('btn-to-chain').addEventListener('click', () => {
  // Pre-fill base URLs from spec
  if (state.spec?.base_url) {
    state.apis.forEach(a => { state.baseUrls[a.id] = state.spec.base_url; });
  }
  navigateTo('chain');
});

function renderEndpointList(spec) {
  document.getElementById('spec-info').textContent =
    `📋 ${spec.title} v${spec.version}${spec.base_url ? '  ·  ' + spec.base_url : ''}`;
  document.getElementById('ep-count').textContent = spec.endpoints.length + ' endpoints';
  const list = document.getElementById('endpoint-list');
  list.innerHTML = spec.endpoints.map((ep, i) => `
    <div class="endpoint-item" data-idx="${i}" data-path="${ep.path}" data-method="${ep.method}" data-summary="${ep.summary||''}">
      <span class="method-badge method-${ep.method}">${ep.method}</span>
      <span class="endpoint-path">${ep.path}</span>
      <span class="endpoint-summary">${ep.summary || ''}</span>
    </div>
  `).join('');
}

// ── Resource grouping ─────────────────────────────────────────────────────────
function groupByResource(endpoints) {
  // Group by first path segment: /products, /products/{id} → "products"
  const groups = {};
  for (const ep of endpoints) {
    const seg = ep.path.split('/').filter(Boolean)[0] || 'root';
    if (!groups[seg]) groups[seg] = [];
    groups[seg].push(ep);
  }
  return groups;
}

function autoAssignFromResource(resource, apiId) {
  // Track selection for mutual exclusion
  state.selectedResources[apiId] = resource;

  // Refresh ALL resource dropdowns so taken resources are hidden
  refreshResourceDropdowns();

  if (!resource) {
    // Clear assignments
    ['post','get','put','delete'].forEach(m => {
      const sel = document.getElementById(`sel-${apiId}-${m}`);
      if (sel) { sel.value = ''; sel.style.borderColor = ''; state.selections[apiId][m] = ''; }
    });
    return;
  }

  const groups = groupByResource(state.endpoints);
  const eps = groups[resource] || [];

  const find = (method, wantParam) => {
    const filtered = eps.filter(e => e.method === method);
    if (wantParam === true)  return filtered.find(e =>  e.path.includes('{')) || filtered[0];
    if (wantParam === false) return filtered.find(e => !e.path.includes('{')) || filtered[0];
    return filtered[0];
  };

  const postEp   = find('POST',   false);
  const getEp    = find('GET',    true);
  const putEp    = find('PUT',    null);
  const deleteEp = find('DELETE', null);

  const assign = (method, ep) => {
    const sel = document.getElementById(`sel-${apiId}-${method}`);
    if (sel && ep) { sel.value = ep.path; state.selections[apiId][method] = ep.path; }
  };
  assign('post',   postEp);
  assign('get',    getEp);
  assign('put',    putEp);
  assign('delete', deleteEp);

  // Auto-name
  const niceName = resource.charAt(0).toUpperCase() + resource.slice(1) + ' API';
  const nameEl = document.getElementById(`api-name-${apiId}`);
  if (nameEl) { nameEl.value = niceName; updateApiName(apiId, niceName); }

  // Green border on assigned
  ['post','get','put','delete'].forEach(m => {
    const sel = document.getElementById(`sel-${apiId}-${m}`);
    if (sel) sel.style.borderColor = sel.value ? 'var(--success)' : '';
  });

  // Store POST response schema for source picker
  if (postEp?.response_schema) state.responseSchemas[apiId] = postEp.response_schema;

  // Auto-populate postFields from POST request body schema
  if (postEp?.request_body_schema)
    state.postFields[apiId] = _schemaToFields(postEp.request_body_schema, apiId);
}

function refreshResourceDropdowns() {
  // Resources already claimed by OTHER apis
  const taken = new Set(
    Object.entries(state.selectedResources)
      .filter(([, v]) => v)
      .map(([, v]) => v)
  );

  const groups = groupByResource(state.endpoints);

  state.apis.forEach(api => {
    const sel = document.getElementById(`resource-${api.id}`);
    if (!sel) return;
    const current = state.selectedResources[api.id];
    sel.innerHTML = `<option value="">— pick a resource —</option>` +
      Object.keys(groups).map(r => {
        // Hide if taken by another API
        const takenByOther = taken.has(r) && r !== current;
        if (takenByOther) return '';
        const cnt = groups[r].length;
        const label = r.charAt(0).toUpperCase() + r.slice(1);
        return `<option value="${r}" ${r === current ? 'selected' : ''}>${label} (${cnt} endpoints)</option>`;
      }).join('');
  });
}

// ── PAGE 2: Configure Chain ───────────────────────────────────────────────────
function renderChainPage() {
  const container = document.getElementById('api-panels-container');
  container.innerHTML =
    state.apis.map(a => renderApiPanel(a)).join('') +
    `<div style="margin-bottom:16px">
       <button class="btn btn-secondary" onclick="addApi()">＋ Add API</button>
       <span class="hint" style="margin-left:10px">Add API-3, API-4… Delete order is reverse of list</span>
     </div>`;

  // restore saved values; fall back to spec base_url if not yet set
  state.apis.forEach(a => {
    if (!state.baseUrls[a.id] && state.spec?.base_url)
      state.baseUrls[a.id] = state.spec.base_url;
    const urlEl = document.getElementById(`base-url-${a.id}`);
    if (urlEl) urlEl.value = state.baseUrls[a.id] || '';
    const idEl = document.getElementById(`id-field-${a.id}`);
    if (idEl) idEl.value = state.idFields[a.id] || 'id';
    ['post','get','put','delete'].forEach(m => {
      const sel = document.getElementById(`sel-${a.id}-${m}`);
      if (sel && state.selections[a.id][m]) {
        sel.value = state.selections[a.id][m];
        sel.style.borderColor = sel.value ? 'var(--success)' : '';
      }
    });
  });
  refreshResourceDropdowns();
  renderMappingTable();
  bindChainEvents();
}

function renderApiPanel(api) {
  const groups  = groupByResource(state.endpoints);
  const resources = Object.keys(groups);

  const resourceOptions = `<option value="">— pick a resource —</option>` +
    resources.map(r => {
      const cnt = groups[r].length;
      const label = r.charAt(0).toUpperCase() + r.slice(1);
      return `<option value="${r}">${label} (${cnt} endpoints)</option>`;
    }).join('');

  const epOptions = (method) => {
    const filtered = state.endpoints.filter(e => e.method === method.toUpperCase());
    return `<option value="">— none —</option>` +
      filtered.map(e => `<option value="${e.path}">${e.path}</option>`).join('');
  };

  const accentColor = _apiColor(api.colorIdx);
  const canRemove = state.apis.length > 2;
  const myIdx     = state.apis.findIndex(a => a.id === api.id);
  const canUp     = myIdx > 0;
  const canDown   = myIdx < state.apis.length - 1;
  const seqLabel  = `#${myIdx + 1}`;

  return `
  <div class="card api-panel" style="border-left:3px solid ${accentColor}">
    <div class="api-panel-header" onclick="togglePanel('${api.id}')" style="border-left:none">
      <span style="background:${accentColor};color:#000;font-size:10px;font-weight:800;padding:2px 7px;border-radius:4px;margin-right:8px;flex-shrink:0">${seqLabel}</span>
      <h3 id="panel-title-${api.id}">${api.name}</h3>
      <div style="margin-left:auto;display:flex;gap:4px;align-items:center" onclick="event.stopPropagation()">
        <button class="btn btn-secondary btn-sm" style="padding:3px 8px" title="Move up" ${canUp?'':'disabled'} onclick="moveApi('${api.id}',-1)">▲</button>
        <button class="btn btn-secondary btn-sm" style="padding:3px 8px" title="Move down" ${canDown?'':'disabled'} onclick="moveApi('${api.id}',1)">▼</button>
        ${canRemove ? `<button class="btn btn-danger btn-sm" style="padding:3px 8px" onclick="removeApi('${api.id}')">✕</button>` : ''}
        <span style="font-size:12px;color:var(--text-dim);margin-left:4px">▾</span>
      </div>
    </div>
    <div class="api-panel-body open" id="panel-body-${api.id}">

      <!-- Step 1: pick resource -->
      <div style="background:rgba(108,99,255,.06);border:1px solid rgba(108,99,255,.2);border-radius:8px;padding:14px;margin-bottom:16px;">
        <label style="color:${accentColor};font-size:12px;font-weight:700;letter-spacing:.5px;">
          STEP 1 — SELECT RESOURCE GROUP
        </label>
        <select id="resource-${api.id}" style="margin-top:6px;border-color:${accentColor};"
                onchange="autoAssignFromResource(this.value,'${api.id}')">
          ${resourceOptions}
        </select>
        <p class="hint" style="margin-top:5px">Picks a resource → auto-fills all 4 endpoints below</p>
      </div>

      <!-- Step 2: review / override -->
      <label style="font-size:11px;font-weight:700;color:var(--text-dim);letter-spacing:.5px;">
        STEP 2 — REVIEW / OVERRIDE ENDPOINTS
      </label>

      <div class="form-row cols-2" style="margin-top:8px;">
        <div class="form-group">
          <label>API Name</label>
          <input type="text" id="api-name-${api.id}" value="${api.name}" oninput="updateApiName('${api.id}',this.value)"/>
        </div>
        <div class="form-group">
          <label>Base URL</label>
          <input type="text" id="base-url-${api.id}" placeholder="https://api.example.com" value="${state.baseUrls[api.id] || state.spec?.base_url || ''}"/>
        </div>
      </div>
      <div class="form-row cols-2">
        <div class="form-group">
          <label>🟣 POST — Create</label>
          <select id="sel-${api.id}-post">${epOptions('POST')}</select>
        </div>
        <div class="form-group">
          <label>🟢 GET — Read</label>
          <select id="sel-${api.id}-get">${epOptions('GET')}</select>
        </div>
      </div>
      <div class="form-row cols-2">
        <div class="form-group">
          <label>🟡 PUT — Update</label>
          <select id="sel-${api.id}-put">${epOptions('PUT')}</select>
        </div>
        <div class="form-group">
          <label>🔴 DELETE</label>
          <select id="sel-${api.id}-delete">${epOptions('DELETE')}</select>
        </div>
      </div>
      <div class="form-row cols-2">
        <div class="form-group">
          <label>ID field in POST response</label>
          <input type="text" id="id-field-${api.id}" value="${state.idFields[api.id]||'id'}" placeholder="id"/>
          <p class="hint">Field in response body holding resource ID (e.g. "id", "data.id")</p>
        </div>
      </div>

      <!-- Operation toggles -->
      <div style="margin-top:4px">
        <label style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.6px;display:block;margin-bottom:8px">Operations to Execute</label>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${['create','read','update','delete'].map(op => {
            const icons = {create:'🟣 CREATE',read:'🟢 READ',update:'🟡 UPDATE',delete:'🔴 DELETE'};
            const checked = (state.apiOps[api.id]?.[op] !== false) ? 'checked' : '';
            return `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;background:var(--surface2);border:1px solid var(--border);padding:6px 12px;border-radius:7px;font-size:12px;font-weight:600;user-select:none">
              <input type="checkbox" id="op-${api.id}-${op}" ${checked} onchange="toggleOp('${api.id}','${op}',this.checked)" style="width:14px;height:14px"/>
              ${icons[op]}
            </label>`;
          }).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

function togglePanel(apiId) {
  const body = document.getElementById(`panel-body-${apiId}`);
  body.classList.toggle('open');
}

function updateApiName(apiId, name) {
  const a = state.apis.find(x => x.id === apiId);
  if (a) a.name = name;
  const title = document.getElementById(`panel-title-${apiId}`);
  if (title) title.textContent = name;
}

function renderMappingTable() {
  const tbody = document.getElementById('mapping-tbody');
  tbody.innerHTML = state.mappings.map((m, i) => `
    <tr>
      <td>
        <select onchange="state.mappings[${i}].apiId=this.value">
          ${state.apis.map(a => `<option value="${a.id}" ${m.apiId===a.id?'selected':''}>${a.name}</option>`).join('')}
        </select>
      </td>
      <td><input type="text" value="${m.field}" placeholder="id" oninput="state.mappings[${i}].field=this.value"/></td>
      <td><input type="text" value="${m.asVar}" placeholder="api1_id" oninput="state.mappings[${i}].asVar=this.value"/></td>
      <td><button class="btn btn-danger btn-sm" onclick="removeMapping(${i})">✕</button></td>
    </tr>`).join('');
}

document.getElementById('btn-add-mapping').addEventListener('click', () => {
  state.mappings.push({ apiId: state.apis[0].id, field: 'id', asVar: 'api1_id' });
  renderMappingTable();
});

function removeMapping(i) {
  state.mappings.splice(i, 1);
  renderMappingTable();
}

function bindChainEvents() {
  state.apis.forEach(a => {
    document.getElementById(`base-url-${a.id}`)?.addEventListener('change', function() {
      state.baseUrls[a.id] = this.value;
    });
    document.getElementById(`id-field-${a.id}`)?.addEventListener('change', function() {
      state.idFields[a.id] = this.value;
    });
    ['post','get','put','delete'].forEach(m => {
      document.getElementById(`sel-${a.id}-${m}`)?.addEventListener('change', function() {
        state.selections[a.id][m] = this.value;
      });
    });
  });
}

document.getElementById('btn-to-data').addEventListener('click', () => {
  // save selections
  state.apis.forEach(a => {
    state.baseUrls[a.id] = document.getElementById(`base-url-${a.id}`)?.value || '';
    state.idFields[a.id] = document.getElementById(`id-field-${a.id}`)?.value || 'id';
    ['post','get','put','delete'].forEach(m => {
      const sel = document.getElementById(`sel-${a.id}-${m}`);
      if (sel) state.selections[a.id][m] = sel.value;
    });
    const nameEl = document.getElementById(`api-name-${a.id}`);
    if (nameEl) a.name = nameEl.value;
  });
  navigateTo('data');
});

// ── PAGE 3: Auth & Data ───────────────────────────────────────────────────────
document.getElementById('auth-type').addEventListener('change', function() {
  document.querySelectorAll('.auth-section').forEach(el => el.classList.add('hidden'));
  const section = document.getElementById(`auth-fields-${this.value}`);
  if (section) section.classList.remove('hidden');
  if (this.value === 'bearer') renderAuthTokenPicker();
});

function renderAuthTokenPicker() {
  const pickerEl = document.getElementById('auth-token-source-picker');
  if (!pickerEl) return;

  // Collect all scalar response fields from all configured APIs
  const vars = [];
  const seen = new Set();
  state.apis.forEach(a => {
    const schema = state.responseSchemas[a.id];
    if (schema?.properties) {
      Object.entries(schema.properties).forEach(([field, prop]) => {
        const t = prop.type || 'string';
        if (['string', 'integer', 'number', 'boolean'].includes(t)) {
          const vn = `${a.id}_${field}`;
          if (!seen.has(vn)) { seen.add(vn); vars.push({ varName: vn, apiName: a.name, field }); }
        }
      });
    }
    // fallback: idField
    const idF = state.idFields[a.id] || 'id';
    const vn = `${a.id}_${idF}`;
    if (!seen.has(vn)) { seen.add(vn); vars.push({ varName: vn, apiName: a.name, field: idF }); }
  });

  if (!vars.length) { pickerEl.innerHTML = ''; return; }

  pickerEl.innerHTML = `
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <span style="font-size:11px;color:var(--text-dim);font-weight:700;text-transform:uppercase;letter-spacing:.5px">Quick fill:</span>
      ${vars.map(v => `
        <button class="btn btn-secondary btn-sm"
          style="font-family:var(--mono);font-size:11px;padding:3px 10px;color:var(--accent);border-color:rgba(108,99,255,.4)"
          title="Set bearer token to {{${v.varName}}} from ${v.apiName}"
          onclick="setAuthTokenVar('${v.varName}')">
          {{${v.varName}}}
          <span style="font-size:9px;color:var(--text-dim);margin-left:4px">[${escHtml(v.apiName)}]</span>
        </button>`).join('')}
    </div>`;
}

function setAuthTokenVar(varName) {
  const inp = document.getElementById('auth-token');
  if (!inp) return;
  inp.value = `{{${varName}}}`;
  inp.style.color = 'var(--accent)';
  inp.style.borderColor = 'rgba(108,99,255,.5)';
}

function renderDataPage() {
  renderAuthTokenPicker();
  const container = document.getElementById('post-bodies-container');
  container.innerHTML = state.apis.map(a => {
    const ep    = state.selections[a.id]?.post;
    const color = _apiColor(a.colorIdx);
    const injVars = state.mappings.filter(m => m.apiId !== a.id && m.asVar).map(m => m.asVar);
    return `
    <div class="card" style="border-left:3px solid ${color}">
      <div class="card-title">
        <span class="dot" style="background:${color}"></span>
        ${a.name} — POST Request Body
        ${ep ? `<span class="tag" style="margin-left:8px">${ep}</span>` : '<span class="tag" style="color:var(--warning)">no POST endpoint configured</span>'}
      </div>
      ${injVars.length ? `
        <div class="alert alert-info" style="margin-bottom:12px">
          Inject from previous APIs — click to copy:
          ${injVars.map(v=>`<code style="color:var(--accent);cursor:pointer;margin:0 4px" onclick="copyVar('{{${v}}}')" title="Click to copy">{{${v}}}</code>`).join('')}
        </div>` : ''}
      <div id="field-editor-${a.id}"></div>
      <div class="btn-group" style="margin-top:10px">
        <button class="btn btn-secondary btn-sm" onclick="randomAllFields('${a.id}')">🎲 Random All</button>
        <button class="btn btn-secondary btn-sm" onclick="addCustomField('${a.id}')">＋ Add Field</button>
        <button class="btn btn-secondary btn-sm" onclick="toggleJsonPreview('${a.id}')">{ } View JSON</button>
      </div>
      <div id="json-preview-${a.id}" class="hidden" style="margin-top:10px">
        <pre id="json-pre-${a.id}" style="background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:10px;font-size:11px;font-family:var(--mono);max-height:200px;overflow:auto;white-space:pre-wrap;color:var(--text)"></pre>
      </div>

      <!-- Custom headers -->
      <div style="margin-top:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <label style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.6px">Custom Headers</label>
          <button class="btn btn-secondary btn-sm" onclick="addHeader('${a.id}')">＋ Add Header</button>
        </div>
        <div id="headers-${a.id}"></div>
      </div>
    </div>`;
  }).join('');

  state.apis.forEach(a => {
    renderHeaders(a.id);
    // auto-populate fields from schema if empty
    if (!state.postFields[a.id]?.length) {
      const ep     = state.selections[a.id]?.post;
      const epData = ep ? state.endpoints.find(e => e.method === 'POST' && e.path === ep) : null;
      if (epData?.request_body_schema)
        state.postFields[a.id] = _schemaToFields(epData.request_body_schema, a.id);
    }
    renderFieldEditor(a.id);
  });
}

// ── Custom Headers ────────────────────────────────────────────────────────────
function addHeader(apiId) {
  state.apiHeaders[apiId] = state.apiHeaders[apiId] || [];
  state.apiHeaders[apiId].push({ key: '', value: '' });
  renderHeaders(apiId);
}
function removeHeader(apiId, i) {
  state.apiHeaders[apiId].splice(i, 1);
  renderHeaders(apiId);
}
function renderHeaders(apiId) {
  const c = document.getElementById(`headers-${apiId}`);
  if (!c) return;
  const hdrs = state.apiHeaders[apiId] || [];
  if (!hdrs.length) { c.innerHTML = `<p class="hint">No custom headers. Authorization header is handled by Auth section above.</p>`; return; }
  c.innerHTML = hdrs.map((h, i) => `
    <div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
      <input style="flex:1;font-family:var(--mono);font-size:12px" value="${escHtml(h.key)}" placeholder="Header-Name"
        oninput="state.apiHeaders['${apiId}'][${i}].key=this.value"/>
      <input style="flex:2;font-family:var(--mono);font-size:12px" value="${escHtml(h.value)}" placeholder="value or {{var}}"
        oninput="state.apiHeaders['${apiId}'][${i}].value=this.value"/>
      <button class="btn btn-danger btn-sm" style="padding:3px 8px" onclick="removeHeader('${apiId}',${i})">✕</button>
    </div>`).join('');
}

function renderFieldEditor(apiId) {
  const container = document.getElementById(`field-editor-${apiId}`);
  if (!container) return;
  const fields = state.postFields[apiId] || [];

  if (!fields.length) {
    container.innerHTML = `<div class="hint" style="margin-bottom:8px">No fields yet. Click <strong>+ Add Field</strong> or select a resource with a POST schema.</div>`;
    return;
  }

  const TYPES = ['string','integer','number','boolean','array','object'];
  container.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:4px">
      <thead>
        <tr style="background:var(--surface2)">
          <th style="padding:7px 10px;text-align:left;color:var(--text-dim);font-weight:700;width:26%">Field Name</th>
          <th style="padding:7px 10px;text-align:left;color:var(--text-dim);font-weight:700;width:12%">Type</th>
          <th style="padding:7px 10px;text-align:left;color:var(--text-dim);font-weight:700;width:20%">Source</th>
          <th style="padding:7px 10px;text-align:left;color:var(--text-dim);font-weight:700">Value</th>
          <th style="padding:7px 10px;width:28px"></th>
        </tr>
      </thead>
      <tbody>
        ${fields.map((f, i) => {
          const isInject = f.value.startsWith('{{');
          const isArray  = f.type === 'array' || f.type === 'object';
          const srcApi   = isInject ? _sourceApiForVar(f.value) : '';

          const rowBg    = isInject ? 'background:rgba(108,99,255,.07)' : '';
          const valStyle = isInject
            ? 'color:var(--accent);border-color:rgba(108,99,255,.5);font-weight:600'
            : isArray ? 'color:var(--warning);font-size:11px' : '';

          // source label under field name
          const srcLabel = srcApi
            ? `<div style="font-size:10px;color:#a29bfe;margin-top:2px">⛓ from <strong>${escHtml(srcApi)}</strong></div>`
            : '';

          const typeBadge = isInject
            ? `<span style="font-size:9px;background:rgba(108,99,255,.25);color:#a29bfe;padding:1px 6px;border-radius:3px;white-space:nowrap">AUTO-INJECT</span>`
            : isArray
              ? `<span style="font-size:9px;background:rgba(255,165,0,.2);color:var(--warning);padding:1px 6px;border-radius:3px">ARRAY</span>`
              : '';

          const actionCell = (!isInject && !isArray)
            ? `<button class="btn btn-secondary btn-sm" style="padding:3px 7px;font-size:13px" title="Generate random"
                onclick="randomField('${apiId}',${i});document.getElementById('field-val-${apiId}-${i}').value=state.postFields['${apiId}'][${i}].value;updateJsonPreview('${apiId}')">🎲</button>`
            : (isInject
                ? `<span title="Auto-injected from previous API" style="font-size:16px;cursor:default">⛓</span>`
                : `<span style="color:var(--text-dim)">·</span>`);

          return `<tr style="border-bottom:1px solid rgba(46,49,71,.4);${rowBg}">
            <td style="padding:6px 8px;vertical-align:middle">
              <input style="font-family:var(--mono);font-size:12px" value="${escHtml(f.name)}"
                oninput="syncFieldName('${apiId}',${i},this.value)" placeholder="fieldName"/>
              ${srcLabel}
            </td>
            <td style="padding:5px 6px;vertical-align:middle">
              <select style="font-size:12px;padding:5px 6px" onchange="syncFieldType('${apiId}',${i},this.value)">
                ${TYPES.map(t => `<option value="${t}" ${f.type===t?'selected':''}>${t}</option>`).join('')}
              </select>
            </td>
            <td style="padding:5px 6px;vertical-align:middle">
              <select style="font-size:12px;padding:5px 6px;${isInject?'color:var(--accent);border-color:rgba(108,99,255,.4)':isArray?'color:var(--warning)':''}"
                onchange="onSourceChange('${apiId}',${i},this.value)">
                ${_sourceOptions(apiId, f.value)}
              </select>
              <div style="margin-top:3px">${typeBadge}</div>
            </td>
            <td style="padding:5px 6px;vertical-align:middle">
              <input id="field-val-${apiId}-${i}"
                style="font-family:var(--mono);font-size:12px;${valStyle}"
                value="${escHtml(f.value)}"
                placeholder="${isInject ? '{{var}}' : isArray ? '[{"id":"{{var}}"}]' : 'enter value'}"
                oninput="syncFieldValue('${apiId}',${i},this.value);updateJsonPreview('${apiId}')"/>
            </td>
            <td style="padding:5px 4px;text-align:center;vertical-align:middle">
              <button class="btn btn-danger btn-sm" style="padding:3px 7px" onclick="removeField('${apiId}',${i})">✕</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  updateJsonPreview(apiId);
}

function toggleJsonPreview(apiId) {
  const box = document.getElementById(`json-preview-${apiId}`);
  if (!box) return;
  box.classList.toggle('hidden');
  updateJsonPreview(apiId);
}

function updateJsonPreview(apiId) {
  const pre = document.getElementById(`json-pre-${apiId}`);
  if (!pre) return;
  try {
    pre.textContent = JSON.stringify(_fieldsToBody(apiId), null, 2);
  } catch {}
}

function copyVar(text) {
  navigator.clipboard?.writeText(text).catch(()=>{});
}

document.getElementById('btn-to-run').addEventListener('click', () => {
  // sync any typed values from DOM → state before leaving page
  state.apis.forEach(a => {
    (state.postFields[a.id] || []).forEach((f, i) => {
      const inp = document.getElementById(`field-val-${a.id}-${i}`);
      if (inp) f.value = inp.value;
    });
  });
  navigateTo('run');
});

// ── PAGE 4: Run ───────────────────────────────────────────────────────────────
document.getElementById('btn-run').addEventListener('click', runChain);

async function runChain() {
  // sync typed field values from DOM → state
  state.apis.forEach(a => {
    (state.postFields[a.id] || []).forEach((f, i) => {
      const inp = document.getElementById(`field-val-${a.id}-${i}`);
      if (inp) f.value = inp.value;
    });
  });

  // Build chain config
  let chainConfig;
  try {
    chainConfig = buildChainConfig();
  } catch(e) {
    showResultBanner(false, 'Configuration error: ' + e.message);
    return;
  }

  // UI: loading
  document.getElementById('btn-run').disabled = true;
  show('run-spinner');
  hide('run-summary');
  document.getElementById('result-banner-container').innerHTML = '';
  document.getElementById('results-container').innerHTML = '';

  try {
    const result = await api('/api/run', { chain: chainConfig });
    renderResults(result);
  } catch(e) {
    showResultBanner(false, 'Request failed: ' + e.message);
  } finally {
    document.getElementById('btn-run').disabled = false;
    hide('run-spinner');
  }
}

function buildChainConfig() {
  // Auth
  const authType = document.getElementById('auth-type').value;
  let auth = { type: authType };
  if (authType === 'bearer') auth.token = document.getElementById('auth-token').value;
  if (authType === 'basic') {
    auth.username = document.getElementById('auth-username').value;
    auth.password = document.getElementById('auth-password').value;
  }
  if (authType === 'api_key') {
    auth.key_name  = document.getElementById('auth-key-name').value;
    auth.key_value = document.getElementById('auth-key-value').value;
    auth.key_in    = document.getElementById('auth-key-in').value;
  }

  const apis = state.apis.map(a => {
    const sel = state.selections[a.id] || {};
    const baseUrl = state.baseUrls[a.id];
    if (!baseUrl) throw new Error(`Base URL missing for ${a.name}`);

    const postBody = _fieldsToBody(a.id);

    const extracts = state.mappings
      .filter(m => m.apiId === a.id && m.field && m.asVar)
      .map(m => ({ field: m.field, as_var: m.asVar }));

    // custom headers (filter empty keys)
    const customHeaders = {};
    (state.apiHeaders[a.id] || []).forEach(h => { if (h.key.trim()) customHeaders[h.key.trim()] = h.value; });

    // ops
    const ops = state.apiOps[a.id] || { create:true, read:true, update:true, delete:true };

    return {
      id: a.id,
      name: a.name,
      base_url: baseUrl,
      post_endpoint:   sel.post   ? { path: sel.post,   method: 'POST'   } : null,
      get_endpoint:    sel.get    ? { path: sel.get,    method: 'GET'    } : null,
      put_endpoint:    sel.put    ? { path: sel.put,    method: 'PUT'    } : null,
      delete_endpoint: sel.delete ? { path: sel.delete, method: 'DELETE' } : null,
      post_body: postBody,
      id_field: state.idFields[a.id] || 'id',
      response_extracts: extracts,
      custom_headers: customHeaders,
      ops,
    };
  });

  const deleteOrder = [...state.apis].reverse().map(a => a.id);

  const execution_steps = state.executionSteps.length
    ? state.executionSteps.map(s => ({ api_id: s.apiId, operation: s.operation, enabled: s.enabled }))
    : null;

  return {
    auth,
    apis,
    delete_order: deleteOrder,
    verify_ssl: document.getElementById('opt-ssl').value === 'true',
    timeout: parseInt(document.getElementById('opt-timeout').value) || 30,
    execution_steps,
  };
}

// ── Execution Step helpers ────────────────────────────────────────────────────
let _execStepUid = 0;

const _opMeta = {
  create: { method: 'POST',   color: '#a29bfe', desc: 'Create' },
  read:   { method: 'GET',    color: '#00d9a3', desc: 'Read'   },
  update: { method: 'PUT',    color: '#ffa502', desc: 'Update' },
  delete: { method: 'DELETE', color: '#ff4757', desc: 'Delete' },
};

function _buildDefaultSteps() {
  _execStepUid = 0;
  const steps = [];
  const mk = (apiId, op) => ({ uid: _execStepUid++, apiId, operation: op, enabled: true });

  state.apis.forEach(a => {
    if (state.apiOps[a.id]?.create !== false && state.selections[a.id]?.post)
      steps.push(mk(a.id, 'create'));
  });
  state.apis.forEach(a => {
    if (state.apiOps[a.id]?.read !== false && state.selections[a.id]?.get)
      steps.push(mk(a.id, 'read'));
  });
  state.apis.forEach(a => {
    if (state.apiOps[a.id]?.update !== false && state.selections[a.id]?.put)
      steps.push(mk(a.id, 'update'));
  });
  [...state.apis].reverse().forEach(a => {
    if (state.apiOps[a.id]?.delete !== false && state.selections[a.id]?.delete)
      steps.push(mk(a.id, 'delete'));
  });
  return steps;
}

function renderRunPage() {
  if (!state.executionSteps.length)
    state.executionSteps = _buildDefaultSteps();

  const rows = state.executionSteps.map((step, i) => {
    const api  = state.apis.find(a => a.id === step.apiId);
    if (!api) return '';
    const meta = _opMeta[step.operation];
    const ep   = state.selections[step.apiId]?.[step.operation === 'create' ? 'post'
                  : step.operation === 'read' ? 'get'
                  : step.operation === 'update' ? 'put' : 'delete'];
    const canUp   = i > 0;
    const canDown = i < state.executionSteps.length - 1;
    const dimmed  = step.enabled ? '' : 'opacity:.4;';

    return `
    <div style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;${dimmed}">
      <label style="cursor:pointer;display:flex;align-items:center;gap:0">
        <input type="checkbox" ${step.enabled ? 'checked' : ''}
          onchange="toggleExecStep(${i},this.checked)"
          style="width:16px;height:16px;cursor:pointer"/>
      </label>
      <span style="min-width:6px;font-size:11px;color:var(--text-dim);font-weight:700">${i+1}</span>
      <span style="background:${meta.color}22;color:${meta.color};border:1px solid ${meta.color}55;
        font-size:10px;font-weight:800;padding:3px 9px;border-radius:4px;min-width:58px;text-align:center">${meta.method}</span>
      <span style="font-weight:700;color:var(--text);min-width:120px">${escHtml(api.name)}</span>
      <span style="font-size:11px;color:var(--text-dim);flex:1">${ep ? escHtml(ep) : '<em style="color:var(--warning)">no endpoint</em>'}</span>
      <div style="display:flex;gap:4px">
        <button class="btn btn-secondary btn-sm" style="padding:2px 7px" ${canUp ? '' : 'disabled'}
          onclick="moveExecStep(${i},-1)">▲</button>
        <button class="btn btn-secondary btn-sm" style="padding:2px 7px" ${canDown ? '' : 'disabled'}
          onclick="moveExecStep(${i},1)">▼</button>
      </div>
    </div>`;
  }).join('');

  const seqHtml = `
  <div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
      <div class="card-title" style="margin:0"><span class="dot"></span>Execution Steps</div>
      <button class="btn btn-secondary btn-sm" onclick="resetExecSteps()">↺ Reset to Default</button>
    </div>
    <p class="hint" style="margin-bottom:12px">Reorder with ▲▼ or uncheck to skip individual steps. Reflects your API config — hit Reset if you changed endpoints.</p>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${rows || '<p class="hint">No steps yet. Go to Configure Chain and select endpoints, then come back.</p>'}
    </div>
  </div>`;

  const el = document.getElementById('run-sequence');
  if (el) el.innerHTML = seqHtml;
}

function toggleExecStep(idx, enabled) {
  if (state.executionSteps[idx]) state.executionSteps[idx].enabled = enabled;
}

function moveExecStep(idx, dir) {
  const ni = idx + dir;
  if (ni < 0 || ni >= state.executionSteps.length) return;
  [state.executionSteps[idx], state.executionSteps[ni]] = [state.executionSteps[ni], state.executionSteps[idx]];
  renderRunPage();
}

function resetExecSteps() {
  state.executionSteps = _buildDefaultSteps();
  renderRunPage();
}

// keep last result for report download
let _lastResult = null;

function renderResults(result) {
  _lastResult = result;

  showResultBanner(result.success, result.success
    ? `All ${result.steps.length} steps passed ✓`
    : `Chain ${result.steps.filter(s=>!s.success).length} step(s) failed`);

  const passCount = result.steps.filter(s => s.success).length;
  const failCount = result.steps.length - passCount;
  document.getElementById('pass-count').textContent = passCount;
  document.getElementById('fail-count').textContent = failCount;
  show('run-summary');

  // badge
  const badge = document.getElementById('result-badge');
  badge.textContent = failCount > 0 ? failCount + ' ✗' : '✓';
  badge.style.background = failCount > 0 ? 'var(--error)' : 'var(--success)';
  show(badge);

  // Download report button
  const bannerEl = document.getElementById('result-banner-container');
  bannerEl.insertAdjacentHTML('beforeend',
    `<div style="margin-bottom:12px">
       <button class="btn btn-secondary" onclick="downloadReport()">
         📥 Download HTML Report
       </button>
     </div>`);

  const container = document.getElementById('results-container');
  container.innerHTML = result.steps.map((step, i) => renderStep(step, i)).join('');

  container.querySelectorAll('.step-header').forEach(h => {
    h.addEventListener('click', () => h.nextElementSibling.classList.toggle('open'));
  });
}

function renderStep(step, i) {
  const cls = step.success ? 'pass' : (step.error ? 'fail' : 'skip');
  const statusColor = step.success ? 'var(--success)' : 'var(--error)';
  const codeClass = !step.status_code ? '' :
    step.status_code < 300 ? 'code-2xx' : step.status_code < 500 ? 'code-4xx' : 'code-5xx';

  const extractedHtml = Object.keys(step.extracted || {}).length > 0
    ? `<div class="extracted-vars">
        ${Object.entries(step.extracted).map(([k,v]) =>
          `<span class="var-chip">{{${k}}} = ${v}</span>`
        ).join('')}
       </div>` : '';

  const reqBodyHtml = step.request_body
    ? `<h4>Request Body</h4><pre>${jsonStr(step.request_body)}</pre>` : '';

  const respBodyHtml = step.response_body !== null && step.response_body !== undefined
    ? `<h4>Response Body</h4><pre>${jsonStr(step.response_body)}</pre>` : '';

  const errorHtml = step.error
    ? `<h4>Error</h4><pre style="color:var(--error)">${escHtml(step.error)}</pre>` : '';

  return `
  <div class="step-result ${cls}">
    <div class="step-header">
      <span class="step-status" style="background:${statusColor}"></span>
      <span class="step-label">${escHtml(step.step)}</span>
      <span class="method-badge method-${step.method}">${step.method}</span>
      <span class="step-url">${escHtml(step.url)}</span>
      ${step.status_code ? `<span class="step-code ${codeClass}">${step.status_code}</span>` : ''}
      <span class="step-time">${step.duration_ms ? step.duration_ms + 'ms' : '—'}</span>
    </div>
    <div class="step-body">
      ${extractedHtml ? `<h4>Extracted Variables</h4>${extractedHtml}` : ''}
      ${reqBodyHtml}
      ${respBodyHtml}
      ${errorHtml}
    </div>
  </div>`;
}

function showResultBanner(success, msg) {
  const el = document.getElementById('result-banner-container');
  el.innerHTML = `<div class="result-banner ${success?'pass':'fail'}">${success?'✅':'❌'} ${escHtml(msg)}</div>`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

function show(el) {
  const node = typeof el === 'string' ? document.getElementById(el) : el;
  node?.classList.remove('hidden');
}
function hide(el) {
  const node = typeof el === 'string' ? document.getElementById(el) : el;
  node?.classList.add('hidden');
}
function showError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}
function jsonStr(v) {
  return escHtml(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── HTML Report Generator ─────────────────────────────────────────────────────
function downloadReport() {
  if (!_lastResult) return;
  const html = buildReportHtml(_lastResult);
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `api-chain-report-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.html`;
  a.click();
}

function buildReportHtml(result) {
  const now      = new Date().toLocaleString();
  const specName = state.spec?.title || 'API Chain';
  const pass     = result.steps.filter(s => s.success).length;
  const fail     = result.steps.length - pass;
  const totalMs  = result.steps.reduce((s, r) => s + (r.duration_ms || 0), 0);
  const status   = result.success ? 'PASS' : 'FAIL';
  const statusColor = result.success ? '#00d9a3' : '#ff4757';

  const stepRows = result.steps.map((step, i) => {
    const sc       = step.status_code;
    const scColor  = !sc ? '#888' : sc < 300 ? '#00d9a3' : sc < 500 ? '#ffa502' : '#ff4757';
    const rowBg    = step.success ? '#0d2b1e' : '#2b0d0d';
    const icon     = step.success ? '✅' : '❌';
    const reqBody  = step.request_body  ? JSON.stringify(step.request_body,  null, 2) : null;
    const respBody = step.response_body != null ? JSON.stringify(step.response_body, null, 2) : null;
    const extracts = Object.entries(step.extracted || {});

    return `
    <tr style="background:${rowBg}">
      <td style="padding:10px 14px;font-weight:700">${i+1}</td>
      <td style="padding:10px 14px">${icon} ${h(step.step)}</td>
      <td style="padding:10px 14px"><span style="background:#2a2a3a;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:800;color:#a29bfe">${h(step.method)}</span></td>
      <td style="padding:10px 14px;font-family:monospace;font-size:12px;word-break:break-all">${h(step.url)}</td>
      <td style="padding:10px 14px;text-align:center;font-weight:700;color:${scColor}">${sc || '—'}</td>
      <td style="padding:10px 14px;text-align:right;color:#888;font-size:12px">${step.duration_ms ? step.duration_ms+'ms' : '—'}</td>
    </tr>
    <tr style="background:#141420">
      <td colspan="6" style="padding:0">
        <div style="padding:14px 20px;display:flex;gap:24px;flex-wrap:wrap;font-size:12px">
          ${extracts.length ? `
          <div style="flex:0 0 100%;margin-bottom:8px">
            <div style="color:#6c63ff;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Extracted Variables</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${extracts.map(([k,v]) => `<span style="background:rgba(108,99,255,.15);border:1px solid rgba(108,99,255,.3);padding:3px 10px;border-radius:4px;font-family:monospace;color:#a29bfe">{{${h(k)}}} = ${h(String(v))}</span>`).join('')}
            </div>
          </div>` : ''}
          ${reqBody ? `
          <div style="flex:1;min-width:280px">
            <div style="color:#8b8fa8;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Request Body</div>
            <pre style="background:#0f1117;border:1px solid #2e3147;border-radius:6px;padding:10px;margin:0;font-size:11px;color:#e4e6f1;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow-y:auto">${h(reqBody)}</pre>
          </div>` : ''}
          ${respBody ? `
          <div style="flex:1;min-width:280px">
            <div style="color:#8b8fa8;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Response Body</div>
            <pre style="background:#0f1117;border:1px solid #2e3147;border-radius:6px;padding:10px;margin:0;font-size:11px;color:#e4e6f1;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow-y:auto">${h(respBody)}</pre>
          </div>` : ''}
          ${step.error ? `
          <div style="flex:0 0 100%">
            <div style="color:#ff4757;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Error</div>
            <pre style="background:#2b0d0d;border:1px solid rgba(255,71,87,.3);border-radius:6px;padding:10px;margin:0;font-size:12px;color:#ff4757">${h(step.error)}</pre>
          </div>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');

  const apiSummaryRows = state.apis.map(a => {
    const apiSteps = result.steps.filter(s => s.api_id === a.id);
    const aPass = apiSteps.filter(s => s.success).length;
    const aFail = apiSteps.length - aPass;
    return `<tr>
      <td style="padding:8px 14px;font-weight:600">${h(a.name)}</td>
      <td style="padding:8px 14px;text-align:center">${apiSteps.length}</td>
      <td style="padding:8px 14px;text-align:center;color:#00d9a3;font-weight:700">${aPass}</td>
      <td style="padding:8px 14px;text-align:center;color:${aFail>0?'#ff4757':'#888'};font-weight:700">${aFail}</td>
    </tr>`;
  }).join('');

  // helper shorthand
  function h(s) { return escHtml(String(s ?? '')); }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>API Chain Test Report — ${h(specName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1117;color:#e4e6f1;font-family:'Segoe UI',system-ui,sans-serif;padding:32px}
h1{font-size:22px;font-weight:800;margin-bottom:4px}
h2{font-size:15px;font-weight:700;color:#8b8fa8;text-transform:uppercase;letter-spacing:.8px;margin:28px 0 12px}
a{color:#6c63ff}
table{width:100%;border-collapse:collapse;background:#1a1d27;border:1px solid #2e3147;border-radius:10px;overflow:hidden;margin-bottom:24px}
th{padding:10px 14px;text-align:left;background:#252836;color:#8b8fa8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;border-bottom:1px solid #2e3147}
td{border-bottom:1px solid rgba(46,49,71,.4);vertical-align:top}
.badge{display:inline-block;padding:4px 14px;border-radius:6px;font-weight:800;font-size:14px;letter-spacing:1px}
.chip{display:inline-block;background:#1a1d27;border:1px solid #2e3147;padding:2px 10px;border-radius:4px;font-size:11px;color:#8b8fa8;margin:2px}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-thumb{background:#2e3147;border-radius:3px}
</style>
</head>
<body>

<div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:16px;margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid #2e3147">
  <div>
    <h1>⚡ API Chain Test Report</h1>
    <div style="color:#8b8fa8;font-size:13px;margin-top:6px">${h(specName)} &nbsp;·&nbsp; Generated: ${h(now)}</div>
  </div>
  <span class="badge" style="background:${statusColor}22;border:2px solid ${statusColor};color:${statusColor};font-size:18px">${status}</span>
</div>

<!-- Summary cards -->
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:28px">
  ${[
    ['Total Steps', result.steps.length, '#6c63ff'],
    ['Passed',      pass,                '#00d9a3'],
    ['Failed',      fail,                fail>0?'#ff4757':'#444'],
    ['Duration',    totalMs.toFixed(0)+'ms','#ffa502'],
  ].map(([label, val, color]) => `
  <div style="background:#1a1d27;border:1px solid #2e3147;border-left:3px solid ${color};border-radius:10px;padding:16px">
    <div style="font-size:11px;color:#8b8fa8;font-weight:700;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">${label}</div>
    <div style="font-size:26px;font-weight:800;color:${color}">${val}</div>
  </div>`).join('')}
</div>

<!-- Per-API summary -->
<h2>API Summary</h2>
<table>
  <thead><tr><th>API</th><th style="text-align:center">Steps</th><th style="text-align:center">Passed</th><th style="text-align:center">Failed</th></tr></thead>
  <tbody>${apiSummaryRows}</tbody>
</table>

<!-- Execution context -->
${Object.keys(result.context || {}).length ? `
<h2>Final Context Variables</h2>
<div style="background:#1a1d27;border:1px solid #2e3147;border-radius:10px;padding:14px;margin-bottom:24px;display:flex;flex-wrap:wrap;gap:8px">
  ${Object.entries(result.context).map(([k,v]) =>
    `<span class="chip" style="color:#a29bfe;border-color:rgba(108,99,255,.3);background:rgba(108,99,255,.08)">{{${h(k)}}} = ${h(String(v))}</span>`
  ).join('')}
</div>` : ''}

<!-- Step-by-step -->
<h2>Step-by-Step Results</h2>
<table>
  <thead>
    <tr>
      <th style="width:40px">#</th>
      <th>Step</th>
      <th style="width:80px">Method</th>
      <th>URL</th>
      <th style="width:70px;text-align:center">Status</th>
      <th style="width:80px;text-align:right">Duration</th>
    </tr>
  </thead>
  <tbody>${stepRows}</tbody>
</table>

<div style="text-align:center;color:#8b8fa8;font-size:12px;margin-top:32px;padding-top:16px;border-top:1px solid #2e3147">
  Generated by <strong style="color:#6c63ff">API Chain Tester</strong> &nbsp;·&nbsp; ${h(now)}
</div>

</body>
</html>`;
}

// Pass 1: turn a parse tree (or a regex "lite" pass) into symbols plus unresolved references.
// Output shape (all positions 1-based lines):
//   { symbols:[{name,kind,start,end,parent,owner,doc,signature}], imports:[string],
//     refs:[{kind:'call'|'type'|'heritage',name,recv,from,rel,line}], routes:[{method,path,line,handler}] }
// `parent` / `from` are indexes into `symbols` (-1 = file level). The linker (Pass 2) resolves refs.

const IDENT = /^[A-Za-z_$][\w$]*$/;
const KIND_MAP = { Variable: 'Resource' }; // closed label set has no Variable
const ID_TYPES = new Set(['identifier', 'type_identifier', 'field_identifier', 'simple_identifier', 'property_identifier', 'name', 'constant']);
const HTTP = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all']);
const MAX_REFS = 20000;

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

function nameOf(node) {
  const f = node.childForFieldName('name');
  if (f) return f.text;
  let d = node.childForFieldName('declarator');
  while (d) {
    if (ID_TYPES.has(d.type) || d.type === 'qualified_identifier') return d.text;
    d = d.childForFieldName('declarator') ?? d.namedChildren.find((c) => ID_TYPES.has(c.type)) ?? null;
  }
  const c = node.namedChildren.find((x) => ID_TYPES.has(x.type));
  return c ? c.text : null;
}

function resolveKind(spec, node) {
  if (typeof spec === 'string') return spec;
  let kind = spec.kind;
  if (spec.by) {
    const t = node.childForFieldName(spec.by.field);
    if (t && spec.by.map[t.type]) kind = spec.by.map[t.type];
  }
  if (spec.keywords) {
    for (const ch of node.children) if (spec.keywords[ch.type]) kind = spec.keywords[ch.type];
  }
  return kind;
}

function splitCallee(text) {
  const t = text.replace(/\(.*$/s, '').trim();
  if (t.length > 200) return null;
  const m = /([A-Za-z_$][\w$]*)\s*$/.exec(t);
  if (!m) return null;
  const recv = t.slice(0, m.index).replace(/(?:\?\.|\.|::|->|:)\s*$/, '').trim();
  return { name: m[1], recv: /^[\w$.:>\-]*$/.test(recv) ? recv : '' };
}

function idsIn(node, out = []) {
  if (ID_TYPES.has(node.type) && node.type !== 'property_identifier' && node.type !== 'field_identifier') out.push(node.text);
  else for (const c of node.namedChildren) idsIn(c, out);
  return out;
}

function leadingDoc(node, cfg, lines) {
  const types = cfg.commentTypes ?? [];
  let s = node.previousNamedSibling;
  const parts = [];
  let expect = node.startPosition.row;
  while (s && types.includes(s.type) && s.endPosition.row >= expect - 1) {
    parts.unshift(s.text);
    expect = s.startPosition.row;
    s = s.previousNamedSibling;
  }
  if (!parts.length && cfg.pythonDocstrings) {
    const body = node.childForFieldName('body');
    const first = body?.namedChildren[0];
    if (first?.type === 'expression_statement' && first.firstNamedChild?.type === 'string') parts.push(first.firstNamedChild.text);
  }
  if (!parts.length) return '';
  return clip(parts.join('\n').replace(/^\s*(\/\*+|\/\/+|#+|"""|''')\s?|\s*\*+\/\s*$|(\s*\*\s?)|"""|'''/gm, '').trim(), 400);
}

export function extractTree(tree, source, cfg) {
  const out = { symbols: [], imports: [], refs: [], routes: [] };
  const lines = source.split('\n');
  const stack = [-1];
  const ownerKinds = new Set(['Class', 'Interface', 'Enum', 'Type']);

  const addSymbol = (node, name, kind, extra = {}) => {
    const parent = stack[stack.length - 1];
    const idx = out.symbols.length;
    out.symbols.push({
      name, kind: KIND_MAP[kind] ?? kind,
      start: node.startPosition.row + 1, end: node.endPosition.row + 1,
      parent, owner: extra.owner ?? null,
      doc: leadingDoc(node, cfg, lines),
      signature: clip((lines[node.startPosition.row] ?? '').trim()),
    });
    return idx;
  };

  const addRef = (r) => { if (out.refs.length < MAX_REFS) out.refs.push({ from: stack[stack.length - 1], line: 0, ...r }); };

  const heritageFor = (node, symIdx) => {
    for (const h of cfg.heritage ?? []) {
      let targets = [];
      if (h.field) {
        const f = node.childForFieldName(h.field);
        if (f) targets = idsIn(f);
      } else if (h.type && node.type === h.type) {
        targets = idsIn(node);
      }
      for (const name of targets) {
        if (h.ifacePrefix && !/^I[A-Z]/.test(name)) {
          out.refs.push({ kind: 'heritage', name, recv: '', from: symIdx, rel: 'INHERITS', line: node.startPosition.row + 1 });
        } else {
          out.refs.push({ kind: 'heritage', name, recv: '', from: symIdx, rel: h.ifacePrefix ? 'IMPLEMENTS' : h.rel, line: node.startPosition.row + 1 });
        }
      }
    }
  };

  const goOwner = (node) => {
    const r = node.childForFieldName('receiver');
    if (!r) return null;
    const m = /([A-Za-z_]\w*)\s*\)\s*$/.exec(r.text);
    return m ? m[1] : null;
  };

  function visit(node) {
    let pushed = false;
    const t = node.type;

    const defSpec = cfg.defs?.[t];
    if (defSpec) {
      const name = nameOf(node);
      if (name && !(cfg.requireBody?.includes(t) && !node.childForFieldName('body'))) {
        let kind = resolveKind(defSpec, node);
        const parentSym = out.symbols[stack[stack.length - 1]];
        if (kind === 'Function' && parentSym && ownerKinds.has(parentSym.kind) && parentSym.kind !== 'Type') kind = 'Method';
        const owner = cfg.methodOwner === 'go' && kind === 'Method' ? goOwner(node) : (parentSym?.ownerOverride ?? null);
        const idx = addSymbol(node, name, kind, { owner });
        if (cfg.extendToSibling) {
          const sib = node.nextNamedSibling;
          if (sib?.type === cfg.extendToSibling) out.symbols[idx].end = sib.endPosition.row + 1;
        }
        heritageFor(node, idx);
        if (cfg.heritage?.some((h) => h.type === 'base_clause' || h.type === 'class_interface_clause' || h.type === 'delegation_specifier')) {
          /* type-based heritage handled when the clause node is visited, with `from` = this symbol */
        }
        stack.push(idx); pushed = true;
      }
    } else if (cfg.containers?.[t]) {
      const c = cfg.containers[t];
      const n = node.childForFieldName(c.nameField)?.text;
      if (n) {
        const tmp = { ownerOverride: n, kind: 'Type' };
        const idx = out.symbols.length;
        out.symbols.push({ name: `impl ${n}`, kind: 'Type', start: node.startPosition.row + 1, end: node.endPosition.row + 1, parent: stack[stack.length - 1], owner: null, doc: '', signature: clip(node.text.split('\n')[0]), hidden: true, ownerOverride: n });
        void tmp;
        if (c.implementsField) {
          const tr = node.childForFieldName(c.implementsField);
          if (tr) addRef({ kind: 'heritage', name: idsIn(tr).pop() ?? tr.text, recv: '', from: -2, owner: n, rel: 'IMPLEMENTS', line: node.startPosition.row + 1 });
        }
        stack.push(idx); pushed = true;
      }
    } else if (cfg.declarators?.[t]) {
      const d = cfg.declarators[t];
      const val = node.childForFieldName(d.value);
      const nm = node.childForFieldName(d.name);
      if (val && nm && cfg.declaratorValues?.includes(val.type) && IDENT.test(nm.text)) {
        const idx = addSymbol(node, nm.text, stack.length > 1 && ownerKinds.has(out.symbols[stack[stack.length - 1]]?.kind) ? 'Method' : 'Function');
        stack.push(idx); pushed = true;
      }
    }

    // Type-based heritage clauses (e.g. extends_clause) attach to the enclosing symbol.
    if (!defSpec) {
      const cur = stack[stack.length - 1];
      for (const h of cfg.heritage ?? []) {
        if (h.type && t === h.type && cur >= 0) {
          const rel = h.ifacePrefix ? null : h.rel;
          for (const name of idsIn(node)) {
            addRef({ kind: 'heritage', name, recv: '', rel: rel ?? (/^I[A-Z]/.test(name) ? 'IMPLEMENTS' : 'INHERITS'), line: node.startPosition.row + 1 });
          }
        }
      }
    }

    if (cfg.importTypes?.includes(t)) out.imports.push(clip(node.text.replace(/\s+/g, ' '), 300));

    const callSpec = cfg.calls?.[t];
    if (callSpec) {
      let name = null; let recv = '';
      if (callSpec.name) {
        const n = node.childForFieldName(callSpec.name);
        name = n?.text ?? null;
        recv = node.childForFieldName(callSpec.recv)?.text ?? '';
      } else {
        const c = callSpec.callee ? node.childForFieldName(callSpec.callee) : node.firstNamedChild;
        const sp = c ? splitCallee(c.text) : null;
        if (sp) ({ name, recv } = sp);
      }
      if (name && IDENT.test(name.replace(/!$/, ''))) {
        if (cfg.importCalls?.includes(name) && !recv) {
          const arg = node.text.match(/["']([^"']+)["']/);
          if (arg) out.imports.push(`${name}("${arg[1]}")`);
        } else {
          addRef({ kind: 'call', name: name.replace(/!$/, ''), recv: clip(recv, 80), line: node.startPosition.row + 1 });
          if (cfg.routes && HTTP.has(name) && /^(app|router|server|api|route)s?$/i.test(recv)) {
            const p = /^\s*\(\s*["'`]([^"'`]+)["'`]/.exec(node.childForFieldName('arguments')?.text ?? '');
            if (p) out.routes.push({ method: name.toUpperCase(), path: p[1], line: node.startPosition.row + 1, handler: null });
          }
        }
      }
    }

    if (cfg.typeRefs?.includes(t) && stack[stack.length - 1] >= 0) {
      const cur = out.symbols[stack[stack.length - 1]];
      if (cur && node.text !== cur.name) addRef({ kind: 'type', name: node.text, recv: '', line: node.startPosition.row + 1 });
    }

    if (cfg.decoratedRoutes && t === 'decorated_definition') {
      const m = /@\w+\.(get|post|put|delete|patch|route)\(\s*['"]([^'"]+)/.exec(node.text);
      const def = node.childForFieldName('definition');
      if (m && def) out.routes.push({ method: m[1] === 'route' ? 'ANY' : m[1].toUpperCase(), path: m[2], line: node.startPosition.row + 1, handler: nameOf(def) });
    }

    for (const c of node.namedChildren) visit(c);
    if (pushed) stack.pop();
  }

  visit(tree.rootNode);

  // Rust-style impl blocks: re-parent members to the implemented type and drop the helper symbol.
  const hidden = out.symbols.map((s) => !!s.hidden);
  if (hidden.some(Boolean)) {
    for (const s of out.symbols) {
      if (s.parent >= 0 && hidden[s.parent]) { s.owner = out.symbols[s.parent].ownerOverride; s.parent = out.symbols[s.parent].parent; if (s.kind === 'Function') s.kind = 'Method'; }
    }
    for (const r of out.refs) if (r.from === -2) r.from = out.symbols.findIndex((x) => x.name === r.owner && !x.hidden);
    for (const r of out.refs) if (r.from >= 0 && hidden[r.from]) r.from = out.symbols[r.from].parent;
    // compact indexes
    const map = new Map(); const kept = [];
    out.symbols.forEach((s, i) => { if (!hidden[i]) { map.set(i, kept.length); kept.push(s); } });
    for (const s of kept) s.parent = s.parent >= 0 ? (map.get(s.parent) ?? -1) : -1;
    out.refs = out.refs.filter((r) => r.from === -1 || map.has(r.from)).map((r) => ({ ...r, from: r.from >= 0 ? map.get(r.from) : -1 }));
    out.symbols = kept;
  }
  for (const s of out.symbols) delete s.ownerOverride;
  return out;
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

function blockEnd(text, from, mode) {
  if (mode === 'line') return lineOf(text, from);
  if (mode === 'semicolon') {
    const i = text.indexOf(';', from);
    return lineOf(text, i < 0 ? text.length : i);
  }
  const open = text.indexOf('{', from);
  if (open < 0) return lineOf(text, from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return lineOf(text, i);
  }
  return lineOf(text, text.length);
}

// Regex-based extraction for languages without a bundled grammar (SQL, GraphQL, proto, R, Terraform).
export function extractLite(source, cfg) {
  const out = { symbols: [], imports: [], refs: [], routes: [] };
  for (const rule of cfg.lite ?? []) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
    let m;
    while ((m = re.exec(source))) {
      const groups = rule.nameGroups ?? [rule.nameGroup];
      const parts = groups.map((g) => (m[g] ?? '').replace(/["`\[\]]/g, '')).filter(Boolean);
      if (!parts.length) continue;
      const name = [rule.prefix, ...parts].filter(Boolean).join('.');
      const start = lineOf(source, m.index);
      out.symbols.push({
        name, kind: KIND_MAP[rule.kind] ?? rule.kind, start, end: Math.max(start, blockEnd(source, m.index, rule.end)),
        parent: -1, owner: null, doc: '', signature: clip(m[0].trim()),
      });
    }
  }
  out.symbols.sort((a, b) => a.start - b.start);
  for (const rule of cfg.refs ?? []) {
    const re = new RegExp(rule.re.source, 'g');
    let m;
    while ((m = re.exec(source))) {
      const line = lineOf(source, m.index);
      const from = out.symbols.findIndex((s) => line >= s.start && line <= s.end);
      const name = `${m[1]}.${m[2]}`;
      if (out.symbols[from]?.name === name) continue;
      out.refs.push({ kind: 'call', name, recv: '', from, rel: 'USAGE', line, exact: true });
    }
  }
  return out;
}

// Markdown: one Resource per ATX heading (# .. ######). A heading's span runs to the next heading of any level,
// so the file's sections are addressable by name. Headings inside fenced code blocks are ignored.
export function extractMarkdown(source) {
  const out = { symbols: [], imports: [], refs: [], routes: [] };
  const lines = source.split(/\r?\n/);
  let fence = null;
  const heads = [];
  lines.forEach((line, i) => {
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fm) {
      if (!fence) fence = fm[1][0].repeat(fm[1].length);
      else if (fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null;
      return;
    }
    if (fence) return;
    const hm = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (hm) heads.push({ line: i + 1, level: hm[1].length, text: hm[2].trim() });
  });
  heads.forEach((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].line - 1 : lines.length;
    out.symbols.push({
      name: clip(h.text, 120), kind: 'Resource', start: h.line, end: Math.max(h.line, end),
      parent: -1, owner: null, doc: '', signature: clip(`${'#'.repeat(h.level)} ${h.text}`),
    });
  });
  return out;
}

// Config/schema files: one Resource per top-level key.
export function extractResource(source, cfg) {
  const out = { symbols: [], imports: [], refs: [], routes: [] };
  let keys = [];
  if (cfg.resource === 'json') {
    try {
      const j = JSON.parse(source);
      if (j && typeof j === 'object' && !Array.isArray(j)) keys = Object.keys(j).map((k) => ({ k, line: 1 }));
    } catch { /* invalid JSON: file node only */ }
  } else {
    const re = /^([A-Za-z_][\w.-]*)\s*[:=]/gm;
    let m;
    while ((m = re.exec(source))) keys.push({ k: m[1], line: lineOf(source, m.index) });
  }
  for (const { k, line } of keys.slice(0, 200)) {
    out.symbols.push({ name: k, kind: 'Resource', start: line, end: line, parent: -1, owner: null, doc: '', signature: k });
  }
  return out;
}

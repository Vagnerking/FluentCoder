// Avaliador de cláusulas `when` (contextos do VS Code) — subconjunto usado em
// `contributes.menus` / `keybindings` das extensões hospedadas:
//   chave · !expr · a && b · a || b · ( … ) · == / != (string, número, bool)
//   · =~ /regex/flags · `chave in lista` · true/false
// Chaves desconhecidas valem `undefined` (falsy), como no VS Code. Erro de
// sintaxe → false (nunca habilita um item por engano).
'use strict';

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '=~', '<=', '>='].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      // `=~` é seguido de uma regex literal /…/flags.
      if (two === '=~') {
        while (/\s/.test(src[i] || '')) i++;
        if (src[i] === '/') {
          let j = i + 1;
          while (j < src.length && src[j] !== '/') j += src[j] === '\\' ? 2 : 1;
          const body = src.slice(i + 1, j);
          j++;
          let flags = '';
          while (/[a-z]/i.test(src[j] || '')) flags += src[j++];
          out.push({ t: 'regex', v: body, flags });
          i = j;
        }
      }
      continue;
    }
    if (c === '!' || c === '(' || c === ')' || c === '<' || c === '>') {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const j = src.indexOf(c, i + 1);
      if (j < 0) throw new Error('string sem fim');
      out.push({ t: 'str', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && !/[\s!()&|=<>'"]/.test(src[j])) j++;
    if (j === i) throw new Error(`caractere inesperado: ${c}`);
    out.push({ t: 'word', v: src.slice(i, j) });
    i = j;
  }
  return out;
}

/**
 * @param {string|undefined} expr
 * @param {(key:string)=>any} lookup valor de uma chave de contexto
 */
function evaluateWhen(expr, lookup) {
  if (expr == null || String(expr).trim() === '') return true;
  let toks;
  try {
    toks = tokenize(String(expr));
  } catch {
    return false;
  }
  let p = 0;
  const peek = () => toks[p];
  const take = () => toks[p++];
  const literal = (w) => {
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(w)) return Number(w);
    return w;
  };
  function primary() {
    const t = take();
    if (!t) throw new Error('fim inesperado');
    if (t.t === 'op' && t.v === '!') return !primary();
    if (t.t === 'op' && t.v === '(') {
      const v = or();
      const close = take();
      if (!close || close.v !== ')') throw new Error('falta )');
      return v;
    }
    if (t.t === 'str') return t.v;
    if (t.t !== 'word') throw new Error(`token inesperado ${t.v}`);
    if (t.v === 'true') return true;
    if (t.v === 'false') return false;
    const key = t.v;
    const value = lookup(key);
    const n = peek();
    if (n && n.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(n.v)) {
      take();
      const rhsTok = take();
      if (!rhsTok) throw new Error('falta operando');
      const rhs = rhsTok.t === 'str' ? rhsTok.v : literal(rhsTok.v);
      // VS Code compara como string quando um dos lados é string.
      const eq = value === rhs || (value != null && String(value) === String(rhs));
      if (n.v === '==') return eq;
      if (n.v === '!=') return !eq;
      const a = Number(value);
      const b = Number(rhs);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return n.v === '<' ? a < b : n.v === '>' ? a > b : n.v === '<=' ? a <= b : a >= b;
    }
    if (n && n.t === 'op' && n.v === '=~') {
      take();
      const re = take();
      if (!re || re.t !== 'regex') throw new Error('regex esperada');
      try {
        return new RegExp(re.v, re.flags).test(value == null ? '' : String(value));
      } catch {
        return false;
      }
    }
    if (n && n.t === 'word' && (n.v === 'in' || n.v === 'not')) {
      let negate = false;
      if (n.v === 'not') {
        take();
        const inTok = take();
        if (!inTok || inTok.v !== 'in') throw new Error('esperado "in"');
        negate = true;
      } else take();
      const listTok = take();
      if (!listTok) throw new Error('falta lista');
      const list = lookup(listTok.v);
      let found = false;
      if (Array.isArray(list)) found = list.includes(value);
      else if (list && typeof list === 'object') found = Object.prototype.hasOwnProperty.call(list, value);
      return negate ? !found : found;
    }
    return !!value;
  }
  function and() {
    let v = primary();
    while (peek() && peek().t === 'op' && peek().v === '&&') {
      take();
      const r = primary();
      v = v && r;
    }
    return v;
  }
  function or() {
    let v = and();
    while (peek() && peek().t === 'op' && peek().v === '||') {
      take();
      const r = and();
      v = v || r;
    }
    return v;
  }
  try {
    const v = or();
    if (p !== toks.length) return false;
    return !!v;
  } catch {
    return false;
  }
}

/** Chaves `config.x.y` citadas numa cláusula (para o snapshot do app). */
function configKeysIn(expr) {
  const out = new Set();
  for (const m of String(expr || '').matchAll(/\bconfig\.([\w.-]+)/g)) out.add(m[1]);
  return [...out];
}

module.exports = { evaluateWhen, tokenize, configKeysIn };

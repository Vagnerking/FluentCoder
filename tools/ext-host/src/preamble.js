// Preâmbulo injetado no HTML de cada webview antes de servi-lo ao <iframe>.
//
// - Fornece `acquireVsCodeApi()` (postMessage/getState/setState) com o mesmo
//   contrato do VS Code, retransmitindo via `window.parent.postMessage`.
// - Aplica as variáveis de tema `--vscode-*` (mapeadas dos tokens Fluent pelo
//   app) e as classes `vscode-dark`/`vscode-light` no <body>.
// - Mensagens de controle do app chegam com `__fluentCtl` e são consumidas aqui
//   (stopImmediatePropagation) — o código da extensão nunca as vê. Mensagens da
//   extensão chegam cruas (event.data === message), como no VS Code.
//
// CSP: o preâmbulo é inserido como PRIMEIRO filho do <head>, antes do
// <meta http-equiv="Content-Security-Policy"> da extensão. Um CSP declarado via
// <meta> só vale para o conteúdo posterior a ele, então o script inline do
// preâmbulo roda sem precisar de nonce e SEM afrouxar o CSP da extensão.
'use strict';

/** Estilo padrão que o VS Code injeta em todo webview (resumo do essencial). */
const DEFAULT_STYLES = `
html{scrollbar-color:var(--vscode-scrollbarSlider-background) transparent}
body{background-color:transparent;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-weight:var(--vscode-font-weight);font-size:var(--vscode-font-size);margin:0;padding:0 20px}
img,video{max-width:100%;max-height:100%}
a,a code{color:var(--vscode-textLink-foreground)}
a:hover{color:var(--vscode-textLink-activeForeground)}
a:focus,input:focus,select:focus,textarea:focus{outline:1px solid -webkit-focus-ring-color;outline-offset:-1px}
code{font-family:var(--monaco-monospace-font);color:var(--vscode-textPreformat-foreground);background-color:var(--vscode-textPreformat-background);padding:1px 3px;border-radius:4px}
pre code{padding:0}
blockquote{background:var(--vscode-textBlockQuote-background);border-color:var(--vscode-textBlockQuote-border)}
kbd{background-color:var(--vscode-keybindingLabel-background);color:var(--vscode-keybindingLabel-foreground);border-style:solid;border-width:1px;border-radius:3px;border-color:var(--vscode-keybindingLabel-border);border-bottom-color:var(--vscode-keybindingLabel-bottomBorder);box-shadow:inset 0 -1px 0 var(--vscode-widget-shadow);vertical-align:middle;padding:1px 3px}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-corner{background-color:var(--vscode-editor-background)}
::-webkit-scrollbar-thumb{background-color:var(--vscode-scrollbarSlider-background)}
::-webkit-scrollbar-thumb:hover{background-color:var(--vscode-scrollbarSlider-hoverBackground)}
::-webkit-scrollbar-thumb:active{background-color:var(--vscode-scrollbarSlider-activeBackground)}
::highlight(find-highlight){background-color:var(--vscode-editor-findMatchHighlightBackground)}
`;

function jsonForScript(value) {
  // Seguro dentro de <script>: escapa `<` (evita `</script>`) e separadores de linha.
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function cssVars(vars) {
  return Object.entries(vars || {})
    .filter(([k, v]) => /^--[\w-]+$/.test(k) && typeof v === 'string' && !/[;{}<]/.test(v))
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
}

/**
 * @param {{handle:string, viewType:string, state:any, themeVars:Record<string,string>, themeKind:'dark'|'light'|'high-contrast', debug?:boolean}} o
 */
function buildPreamble(o) {
  const kind = o.themeKind || 'dark';
  const script = `(function(){
var HANDLE=${jsonForScript(o.handle)},VIEW_TYPE=${jsonForScript(o.viewType)},DEBUG=${o.debug ? 'true' : 'false'};
var state=${jsonForScript(o.state)},acquired=false;
function up(d){d.__fluentExt=1;d.handle=HANDLE;try{window.parent.postMessage(d,'*')}catch(e){}}
var api=Object.freeze({
 postMessage:function(m){if(DEBUG)console.debug('[fluent-ext] webview→ext',m);up({type:'message',message:m});return true},
 getState:function(){return state},
 setState:function(s){state=s;up({type:'setState',state:s});return s}
});
window.acquireVsCodeApi=function(){if(acquired)throw new Error('An instance of the VS Code API has already been acquired');acquired=true;return api};
function applyTheme(vars,k){var r=document.documentElement;for(var key in vars){if(/^--[\\w-]+$/.test(key))r.style.setProperty(key,vars[key])}
 var b=document.body;if(!b)return;b.classList.remove('vscode-dark','vscode-light','vscode-high-contrast');
 b.classList.add(k==='light'?'vscode-light':k==='high-contrast'?'vscode-high-contrast':'vscode-dark');
 b.setAttribute('data-vscode-theme-kind',k==='light'?'vscode-light':k==='high-contrast'?'vscode-high-contrast':'vscode-dark');
 b.setAttribute('data-vscode-theme-id','fluent-acrylic-'+k);b.setAttribute('data-vscode-theme-name','Fluent Acrylic');}
var pendingTheme=null;
window.addEventListener('message',function(e){var d=e.data;if(!d||d.__fluentCtl!==1)return;e.stopImmediatePropagation();
 if(d.type==='theme'){if(document.body)applyTheme(d.vars||{},d.kind);else pendingTheme=d}
 else if(d.type==='ping'){up({type:'pong',nonce:d.nonce})}
},true);
document.addEventListener('DOMContentLoaded',function(){applyTheme({}, ${jsonForScript(kind)});if(pendingTheme){applyTheme(pendingTheme.vars||{},pendingTheme.kind);pendingTheme=null}up({type:'ready'})});
document.addEventListener('click',function(e){if(e.defaultPrevented)return;var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href')||'';
 if(/^(https?|mailto|vscode|command):/i.test(h)){e.preventDefault();up({type:'link',href:h})}},false);
window.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&!e.altKey&&/^[pP]$/.test(e.key)&&e.shiftKey){up({type:'key',key:e.key,ctrl:e.ctrlKey,meta:e.metaKey,shift:e.shiftKey})}});
})();`;
  const vars = cssVars(o.themeVars);
  return (
    `<script>${script}</script>` +
    `<style id="_fluentDefaultStyles">${DEFAULT_STYLES}</style>` +
    (vars ? `<style id="_fluentThemeVars">:root{${vars}}</style>` : '')
  );
}

/** Insere o preâmbulo como primeiro filho do <head> (antes do CSP da extensão). */
function injectPreamble(html, preamble) {
  const src = String(html || '');
  const head = /<head(\s[^>]*)?>/i.exec(src);
  if (head) return src.slice(0, head.index + head[0].length) + preamble + src.slice(head.index + head[0].length);
  const htmlTag = /<html(\s[^>]*)?>/i.exec(src);
  if (htmlTag) return src.slice(0, htmlTag.index + htmlTag[0].length) + `<head>${preamble}</head>` + src.slice(htmlTag.index + htmlTag[0].length);
  return `<!DOCTYPE html><html><head>${preamble}</head><body>${src}</body></html>`;
}

module.exports = { buildPreamble, injectPreamble, jsonForScript, cssVars, DEFAULT_STYLES };

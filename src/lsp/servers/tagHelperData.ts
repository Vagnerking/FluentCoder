/**
 * Dados de Tag Helpers embutidos do ASP.NET Core MVC (milestone #7), no formato
 * `HTMLDataV1` do `vscode-html-languageservice`. Registrados como um
 * `IHTMLDataProvider` custom, dão completion + hover + validação de `asp-*`,
 * `<partial>`, `<environment>`, etc. no MESMO caminho region-gated de HTML já
 * existente (sem novo provider Monaco — o completion é o de HTML).
 *
 * Escopo: os Tag Helpers PADRÃO de `Microsoft.AspNetCore.Mvc.TagHelpers`, que
 * cobrem a grande maioria das Views MVC/Razor Pages. Tag Helpers CUSTOM e View
 * Components (`<vc:...>`) do próprio projeto exigem descoberta via compilador
 * Razor (sidecar) — registrado como follow-up (issue), não neste MVP.
 *
 * Puro (só um objeto de dados) — sem imports de monaco/html-service.
 */

/** Estrutura mínima do `HTMLDataV1` que usamos. */
export interface HtmlDataV1 {
  version: 1.1;
  globalAttributes: { name: string; description?: string }[];
  tags: { name: string; description?: string; attributes: { name: string; description?: string }[] }[];
}

const desc = (s: string) => s;

/**
 * `asp-*` são atributos globais (aplicáveis a várias tags: `<form>`, `<a>`,
 * `<input>`, `<img>`, `<label>`, `<select>`, `<link>`, `<script>`…). Declará-los
 * como globalAttributes dá completion em qualquer tag — o Tag Helper real é mais
 * restrito por tag, mas para completion/hover isso é uma aproximação útil e
 * segura (o compilador valida no build).
 */
const ASP_ATTRIBUTES: { name: string; description?: string }[] = [
  { name: "asp-for", description: desc("Vincula o elemento a uma propriedade do modelo (expressão de model).") },
  { name: "asp-controller", description: desc("Controller de destino do link/form.") },
  { name: "asp-action", description: desc("Action de destino do link/form.") },
  { name: "asp-area", description: desc("Área de destino.") },
  { name: "asp-page", description: desc("Razor Page de destino (ex.: /Index).") },
  { name: "asp-page-handler", description: desc("Handler da Razor Page.") },
  { name: "asp-route", description: desc("Nome da rota de destino.") },
  { name: "asp-route-", description: desc("Valor de parâmetro de rota (asp-route-id, asp-route-slug, …).") },
  { name: "asp-all-route-data", description: desc("Dicionário de valores de rota.") },
  { name: "asp-fragment", description: desc("Fragmento (#âncora) da URL.") },
  { name: "asp-host", description: desc("Host de destino.") },
  { name: "asp-protocol", description: desc("Protocolo (http/https) da URL.") },
  { name: "asp-antiforgery", description: desc("Emite (ou não) o token antiforgery no form.") },
  { name: "asp-items", description: desc("Fonte de itens de um <select> (IEnumerable<SelectListItem>).") },
  { name: "asp-validation-for", description: desc("Mostra a mensagem de validação da propriedade.") },
  { name: "asp-validation-summary", description: desc("Resumo de validação (All | ModelOnly | None).") },
  { name: "asp-append-version", description: desc("Adiciona um hash de versão ao src/href para cache-busting.") },
  { name: "asp-src-include", description: desc("Globs de scripts a incluir.") },
  { name: "asp-src-exclude", description: desc("Globs de scripts a excluir.") },
  { name: "asp-fallback-src", description: desc("Src de fallback (CDN).") },
  { name: "asp-fallback-href", description: desc("Href de fallback (CDN).") },
  { name: "asp-fallback-test", description: desc("Expressão JS de teste do fallback.") },
];

/** Tag Helpers que introduzem TAGS próprias. */
const TAG_HELPER_TAGS: HtmlDataV1["tags"] = [
  {
    name: "partial",
    description: desc("Renderiza uma partial view (<partial name=\"_Nome\" model=\"...\" />)."),
    attributes: [
      { name: "name", description: desc("Nome da partial view.") },
      { name: "model", description: desc("Modelo passado para a partial.") },
      { name: "for", description: desc("Expressão de model para a partial.") },
      { name: "view-data", description: desc("ViewDataDictionary a passar.") },
    ],
  },
  {
    name: "environment",
    description: desc("Renderiza o conteúdo só em ambientes específicos (Development/Production)."),
    attributes: [
      { name: "names", description: desc("Lista de ambientes (ex.: Development).") },
      { name: "include", description: desc("Ambientes onde incluir.") },
      { name: "exclude", description: desc("Ambientes onde excluir.") },
    ],
  },
  {
    name: "cache",
    description: desc("Faz cache do conteúdo interno no servidor."),
    attributes: [
      { name: "expires-after", description: desc("Duração do cache (TimeSpan).") },
      { name: "expires-on", description: desc("Data/hora de expiração.") },
      { name: "expires-sliding", description: desc("Expiração deslizante.") },
      { name: "vary-by", description: desc("Chave de variação do cache.") },
      { name: "vary-by-header", description: desc("Varia por header.") },
      { name: "vary-by-query", description: desc("Varia por query string.") },
      { name: "vary-by-route", description: desc("Varia por valor de rota.") },
      { name: "vary-by-user", description: desc("Varia por usuário autenticado.") },
      { name: "enabled", description: desc("Liga/desliga o cache.") },
    ],
  },
];

/** O `HTMLDataV1` completo dos Tag Helpers embutidos do MVC. */
export const MVC_TAG_HELPER_DATA: HtmlDataV1 = {
  version: 1.1,
  globalAttributes: ASP_ATTRIBUTES,
  tags: TAG_HELPER_TAGS,
};

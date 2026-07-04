/**
 * Razor/CSHTML SYNTAX conformance — the matrix from the project's validation
 * spec, driven against the dependency-free virtual-HTML engine
 * (`buildVirtualHtml`) that is the single Razor-region oracle for `.cshtml`.
 *
 * What this file proves, per case: the engine correctly separates HTML from
 * Razor/C#. The invariant is the same throughout —
 *   - every C#/Razor construct is BLANKED (never leaks into the HTML view, so
 *     the HTML service and the markup linter see clean HTML with no phantom
 *     tags/text), and
 *   - the surrounding HTML markup is PRESERVED at its exact offsets (identity
 *     mapping: same length, newlines kept).
 * `regionAt` is asserted where the caret's classification (HTML vs Razor) is the
 * point (completion routing).
 *
 * The C# *semantics* (type errors, hover, go-to-def) come from the Roslyn
 * projection (Rust broker + sidecar) and are covered by `cargo test razor::` and
 * the opt-in E2E; this file is the syntax/region layer that must never regress.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildVirtualHtml, regionAt } from "./cshtmlHtmlProjection.ts";

/** The blanked HTML-only view of a `.cshtml`. */
function vh(src: string): string {
  return buildVirtualHtml(src).html;
}
/** Assert every substring is GONE from the HTML view (blanked as Razor/C#). */
function blanked(src: string, ...needles: string[]): void {
  const out = vh(src);
  for (const n of needles) {
    assert.ok(!out.includes(n), `expected "${n}" blanked, got: ${JSON.stringify(out)}`);
  }
}
/** Assert every substring SURVIVES in the HTML view (kept as real HTML). */
function kept(src: string, ...needles: string[]): void {
  const out = vh(src);
  for (const n of needles) {
    assert.ok(out.includes(n), `expected "${n}" kept, got: ${JSON.stringify(out)}`);
  }
}
/** Offset of the first occurrence of `needle` (fixture guard). */
function at(text: string, needle: string): number {
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `fixture missing: ${needle}`);
  return i;
}

// The identity-offset invariant underpins EVERY case: only blanking, never
// insert/delete, so a `.cshtml` (line, char) is the same in the HTML view.
function invariant(src: string): void {
  const out = vh(src);
  assert.equal(out.length, src.length, "length preserved");
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\n" || src[i] === "\r") assert.equal(out[i], src[i], `newline @${i}`);
  }
}

// ════════════════════════════ Sintaxe básica Razor ════════════════════════════

test("básico: HTML normal misturado com C# — HTML fica, C# some", () => {
  const src = `<h1>Título</h1>\n<p>@Model.Nome</p>\n<footer>fixo</footer>`;
  invariant(src);
  kept(src, "<h1>Título</h1>", "<footer>fixo</footer>", "<p>", "</p>");
  blanked(src, "Model.Nome");
});

test("básico: expressão implícita @Model.Nome", () => {
  const src = `<span>@Model.Nome</span>`;
  invariant(src);
  kept(src, "<span>", "</span>");
  blanked(src, "Model.Nome");
});

test("básico: expressão explícita @(Model.Nome)", () => {
  const src = `<span>@(Model.Nome)</span>`;
  invariant(src);
  kept(src, "<span>", "</span>");
  blanked(src, "Model.Nome", "@(");
});

test("básico: expressão explícita com operadores @(a + b * c)", () => {
  const src = `<b>@(Model.A + Model.B * 2)</b>`;
  kept(src, "<b>", "</b>");
  blanked(src, "Model.A", "Model.B");
});

test("básico: bloco de código @{ ... } é totalmente C#", () => {
  const src = `@{ var greeting = "Olá"; var n = 3; }\n<p>ok</p>`;
  invariant(src);
  kept(src, "<p>ok</p>");
  blanked(src, "greeting", "var n", "Olá");
});

test("básico: variável C# declarada no @{ } e usada em @expr", () => {
  const src = `@{ var nome = Model.Nome; }\n<h1>@nome</h1>`;
  kept(src, "<h1>", "</h1>");
  blanked(src, "var nome", "Model.Nome");
  // O @nome de saída também é C#:
  const out = vh(src);
  assert.ok(!/>[^<]*nome/.test(out.split("\n")[1]), `@nome de saída blanked: ${out}`);
});

test("básico: escape de arroba @@ vira literal (blanked, não é transição)", () => {
  const src = `<p>user@@host</p>`;
  invariant(src);
  assert.equal(vh(src), `<p>user  host</p>`);
});

test("básico: comentário Razor @* *@ é removido", () => {
  const src = `<p>a</p>@* comentário secreto *@<p>b</p>`;
  invariant(src);
  kept(src, "<p>a</p>", "<p>b</p>");
  blanked(src, "comentário", "secreto", "@*", "*@");
});

test("básico: comentário Razor multi-linha @* ... *@", () => {
  const src = `@*\n  linha 1\n  linha 2\n*@\n<p>ok</p>`;
  invariant(src);
  kept(src, "<p>ok</p>");
  blanked(src, "linha 1", "linha 2");
});

test("básico: comentário HTML <!-- --> é preservado (HTML válido)", () => {
  const src = `<!-- comentário html --><p>x</p>`;
  invariant(src);
  assert.equal(vh(src), src, "comentário HTML intacto");
});

test("básico: @ dentro de comentário HTML não é tratado como Razor", () => {
  const src = `<!-- @Model.Nome não deve sumir --><p>x</p>`;
  assert.equal(vh(src), src);
});

test("básico: interpolação em atributo HTML — class=\"@x\"", () => {
  const src = `<div class="@Model.Css">x</div>`;
  invariant(src);
  kept(src, `<div class="`, `">x</div>`);
  blanked(src, "Model.Css");
});

test("básico: interpolação parcial em atributo — id=\"item-@i\"", () => {
  const src = `<li id="item-@item.Id">x</li>`;
  kept(src, `<li id="item-`, `">x</li>`);
  blanked(src, "item.Id");
});

test("básico: atributo condicional/nulo @(cond ? \"on\" : null)", () => {
  const src = `<input class="@(active ? "on" : null)" />`;
  invariant(src);
  kept(src, `<input class="`, `" />`);
  blanked(src, "active", "null");
});

test("básico: atributo booleano @isDisabled", () => {
  const src = `<input disabled="@isDisabled" />`;
  kept(src, `<input disabled="`, `" />`);
  blanked(src, "isDisabled");
});

test("básico: saída HTML-encoded por padrão @Model.Texto (expr blanked; encoding é runtime)", () => {
  // No nível de projeção, @Model.Texto é apenas uma expressão C# (blanked). O
  // encoding acontece em runtime; aqui garantimos que o texto do usuário não
  // vaza para o HTML virtual como markup.
  const src = `<p>@Model.Texto</p>`;
  blanked(src, "Model.Texto");
  kept(src, "<p>", "</p>");
});

test("básico: Html.Raw(...) é expressão C# (blanked)", () => {
  const src = `<div>@Html.Raw(Model.Html)</div>`;
  kept(src, "<div>", "</div>");
  blanked(src, "Html.Raw", "Model.Html");
});

// ═══════════════════════════════ Diretivas Razor ═══════════════════════════════

test("diretiva: @model Tipo — argumento inteiro blanked", () => {
  const src = `@model MyApp.Models.Cliente\n<p>x</p>`;
  invariant(src);
  kept(src, "<p>x</p>");
  blanked(src, "MyApp.Models.Cliente", "model");
});

test("diretiva: @model com genérico List<T> não vira tag fantasma", () => {
  const src = `@model List<MyApp.Models.Item>\n<p>x</p>`;
  kept(src, "<p>x</p>");
  blanked(src, "List<", "Item>");
});

test("diretiva: @using import — namespace blanked (linha toda)", () => {
  const src = `@using MyApp.Helpers\n<p>x</p>`;
  kept(src, "<p>x</p>");
  blanked(src, "MyApp.Helpers");
});

test("diretiva: @inject Serviço nome", () => {
  const src = `@inject IHtmlLocalizer<Home> L\n<p>x</p>`;
  kept(src, "<p>x</p>");
  blanked(src, "IHtmlLocalizer", "Home");
});

test("diretiva: @inherits BaseType", () => {
  const src = `@inherits MyApp.Views.CustomBase<Model>\n<p>x</p>`;
  kept(src, "<p>x</p>");
  blanked(src, "CustomBase", "MyApp.Views");
});

test("diretiva: @namespace App.Pages", () => {
  const src = `@namespace App.Pages\n<p>x</p>`;
  kept(src, "<p>x</p>");
  blanked(src, "App.Pages");
});

test("diretiva: @addTagHelper *, Assembly", () => {
  const src = `@addTagHelper *, Microsoft.AspNetCore.Mvc.TagHelpers\n<p>x</p>`;
  kept(src, "<p>x</p>");
  blanked(src, "TagHelpers", "Microsoft.AspNetCore");
});

test("diretiva: @removeTagHelper *, Assembly", () => {
  const src = `@removeTagHelper *, MyApp.TagHelpers\n<p>x</p>`;
  kept(src, "<p>x</p>");
  blanked(src, "MyApp.TagHelpers");
});

test("diretiva: @tagHelperPrefix th:", () => {
  const src = `@tagHelperPrefix th:\n<p>x</p>`;
  kept(src, "<p>x</p>");
  blanked(src, "th:");
});

test("diretiva: @page (Razor Pages)", () => {
  const src = `@page\n<p>x</p>`;
  kept(src, "<p>x</p>");
  const out = vh(src);
  assert.ok(!/page/.test(out.split("\n")[0]), `@page blanked: ${out}`);
});

test("diretiva: @page com rota customizada @page \"{id:int}\"", () => {
  const src = `@page "{id:int}"\n<p>x</p>`;
  kept(src, "<p>x</p>");
  blanked(src, "id:int");
});

test("diretiva: @functions { } — membros C# totalmente blanked", () => {
  const src = `@functions {\n  public string Fmt(decimal d) => d.ToString("C");\n}\n<p>ok</p>`;
  invariant(src);
  kept(src, "<p>ok</p>");
  blanked(src, "public", "Fmt", "decimal", "ToString");
});

test("diretiva: @section Nome { markup } — corpo é HTML", () => {
  const src = `@section Scripts {\n  <script src="app.js"></script>\n}\n<p>ok</p>`;
  invariant(src);
  kept(src, `<script src="app.js"></script>`, "<p>ok</p>");
  blanked(src, "section", "Scripts");
});

// ════════════════════════════ Controle de fluxo C# ════════════════════════════

test("fluxo: @if mantém markup do corpo", () => {
  const src = `@if (Model.Ok) { <p>sim</p> }`;
  kept(src, "<p>sim</p>");
  blanked(src, "if", "Model.Ok");
});

test("fluxo: @if / else if / else — todo C# some, todo markup fica", () => {
  const src = `@if (a) { <b>1</b> } else if (b) { <i>2</i> } else { <u>3</u> }`;
  kept(src, "<b>1</b>", "<i>2</i>", "<u>3</u>");
  blanked(src, "else if", "else");
});

test("fluxo: @switch multi-linha preserva markup dos cases", () => {
  const src = `@switch (Model.K) {\n  case 1:\n    <p>um</p>\n    break;\n  default:\n    <b>d</b>\n    break;\n}`;
  invariant(src);
  kept(src, "<p>um</p>", "<b>d</b>");
  blanked(src, "switch", "case 1", "default", "break");
});

test("fluxo: @for preserva markup", () => {
  const src = `@for (var i = 0; i < 3; i++) { <span>@i</span> }`;
  kept(src, "<span>", "</span>");
  blanked(src, "for", "i++", "i < 3");
});

test("fluxo: @foreach preserva markup do <li>", () => {
  const src = `<ul>@foreach (var it in Model.Items) { <li>@it.Nome</li> }</ul>`;
  kept(src, "<ul>", "</ul>", "<li>", "</li>");
  blanked(src, "foreach", "Model.Items", "it.Nome");
});

test("fluxo: @while preserva markup", () => {
  const src = `@while (fila.Any()) { <p>@fila.Dequeue()</p> }`;
  kept(src, "<p>", "</p>");
  blanked(src, "while", "fila.Any", "Dequeue");
});

test("fluxo: @do { } while (...) preserva markup e apaga o tail", () => {
  const src = `@do { <p>x</p> } while (i < 3);<span>after</span>`;
  kept(src, "<p>x</p>", "<span>after</span>");
  blanked(src, "while", "i < 3");
});

test("fluxo: @try / catch / finally preserva markup dos três", () => {
  const src = `@try { <p>t</p> } catch (Exception ex) { <p>c</p> } finally { <p>f</p> }`;
  kept(src, "<p>t</p>", "<p>c</p>", "<p>f</p>");
  blanked(src, "try", "catch", "finally", "Exception");
});

test("fluxo: @using (statement) com corpo markup", () => {
  const src = `@using (Html.BeginForm()) { <input type="submit" /> }`;
  kept(src, `<input type="submit" />`);
  blanked(src, "Html.BeginForm");
});

test("fluxo: @lock (sync) { markup }", () => {
  const src = `@lock (sync) { <p>x</p> }`;
  kept(src, "<p>x</p>");
  blanked(src, "lock", "sync");
});

test("fluxo: @await Html.PartialAsync(...) — expressão inteira blanked", () => {
  const src = `<div>@await Html.PartialAsync("_Card")</div>`;
  invariant(src);
  kept(src, "<div>", "</div>");
  blanked(src, "await", "Html.PartialAsync", "_Card");
});

test("fluxo: @await Component.InvokeAsync(...) — expressão inteira blanked", () => {
  const src = `<div>@await Component.InvokeAsync("Cart", new { id = 1 })</div>`;
  invariant(src);
  kept(src, "<div>", "</div>");
  blanked(src, "await", "Component.InvokeAsync", "Cart");
});

test("fluxo: @awaitable NÃO é o keyword await (word boundary)", () => {
  // Um identificador que começa com `await` é uma expressão implícita normal.
  const src = `<p>@awaitable.Value</p>`;
  blanked(src, "awaitable.Value");
  kept(src, "<p>", "</p>");
});

test("fluxo: chamada assíncrona aninhada em foreach", () => {
  const src = `@foreach (var id in ids) { <div>@await Render(id)</div> }`;
  kept(src, "<div>", "</div>");
  blanked(src, "foreach", "await", "Render");
});

// ═══════════════════ Model e dados da view (expressões C#) ══════════════════

for (const acessor of [
  "Model.Nome",
  'ViewData["Title"]',
  "ViewBag.Title",
  'TempData["msg"]',
  "User.Identity.Name",
  "Context.Request.Path",
  "Request.Query[\"q\"]",
  "Url.Action(\"Index\")",
]) {
  test(`dados: @${acessor} é expressão C# (blanked), markup ao redor fica`, () => {
    const src = `<span>@${acessor}</span>`;
    invariant(src);
    kept(src, "<span>", "</span>");
    // O nome-base do acessor não pode vazar.
    blanked(src, acessor.split(/[.\[]/)[0] + (acessor.includes(".") ? "." : ""));
  });
}

test("dados: @Html.DisplayFor(m => m.Nome) — lambda inteira blanked", () => {
  const src = `<dd>@Html.DisplayFor(m => m.Nome)</dd>`;
  invariant(src);
  kept(src, "<dd>", "</dd>");
  blanked(src, "Html.DisplayFor", "m.Nome");
});

test("dados: ModelState em @if (blanked)", () => {
  const src = `@if (!ViewData.ModelState.IsValid) { <div class="err">erro</div> }`;
  kept(src, `<div class="err">erro</div>`);
  blanked(src, "ModelState", "IsValid");
});

// ══════════════════ Casos de parser Razor (edge cases) ══════════════════════

test("parser: email literal teste@email.com NÃO é transição", () => {
  const src = `<p>Contato: suporte@empresa.com</p>`;
  assert.equal(vh(src), src, "domínio do email preservado");
  const { mask } = buildVirtualHtml(src);
  assert.equal(regionAt(mask, at(src, "empresa")), "html");
});

test("parser: @@ renderiza arroba literal", () => {
  assert.equal(vh(`<p>@@ém arroba</p>`), `<p>  ém arroba</p>`);
});

test("parser: generics em expressão C# @Model.Get<int>()", () => {
  const src = `<p>@Model.Get<int>()</p>`;
  invariant(src);
  kept(src, "<p>", "</p>");
  blanked(src, "Model.Get", "<int>");
});

test("parser: lambda em expressão implícita @itens.Where(x => x.Ativo)", () => {
  const src = `<span>@itens.Where(x => x.Ativo).Count()</span>`;
  invariant(src);
  kept(src, "<span>", "</span>");
  blanked(src, "Where", "x.Ativo", "Count");
});

test("parser: string interpolada @($\"Total {Model.T:C}\")", () => {
  const src = `<b>@($"Total: {Model.Total:C}")</b>`;
  invariant(src);
  kept(src, "<b>", "</b>");
  blanked(src, "Total", "Model.Total");
});

test("parser: string verbatim @\"C:\\path\" em bloco não desincroniza", () => {
  const src = `@{ var p = @"C:\\temp\\x"; }<p>after</p>`;
  kept(src, "<p>after</p>");
  blanked(src, "var p", "temp");
});

test("parser: string interpolada-verbatim @$\"...{x}...\"", () => {
  const src = `@{ var s = @$"user={name}"; }<p>after</p>`;
  kept(src, "<p>after</p>");
  blanked(src, "var s", "name");
});

test("parser: HTML dentro de @if", () => {
  const src = `@if (cond) {\n  <div class="a"><span>@txt</span></div>\n}`;
  kept(src, `<div class="a">`, "<span>", "</span>", "</div>");
  blanked(src, "cond", "txt");
});

test("parser: HTML dentro de @foreach com aninhamento", () => {
  const src = `@foreach (var g in grupos) {\n  <ul>@foreach (var i in g.Itens) { <li>@i</li> }</ul>\n}`;
  kept(src, "<ul>", "</ul>", "<li>", "</li>");
  blanked(src, "grupos", "g.Itens");
});

test("parser: C# dentro de atributo com lambda não vaza a cauda", () => {
  const src = `<div class="@itens.First(y => y.Cls)">x</div>`;
  kept(src, `<div class="`, `">x</div>`);
  blanked(src, "First", "y.Cls");
});

test("parser: tags auto-fechadas ficam intactas", () => {
  const src = `<br /><img src="@Model.Logo" /><hr />`;
  kept(src, "<br />", "<hr />", `<img src="`);
  blanked(src, "Model.Logo");
});

test("parser: mistura de texto, HTML e C# no mesmo bloco", () => {
  const src = `<p>Olá @Model.Nome, você tem @Model.Qtd itens</p>`;
  invariant(src);
  kept(src, "<p>Olá ", ", você tem ", " itens</p>");
  blanked(src, "Model.Nome", "Model.Qtd");
});

test("parser: `<` literal em texto não vira tag", () => {
  const src = `<p>1 < 2 && 3 > 2</p>`;
  assert.equal(vh(src), src);
});

test("parser: @: torna o resto da linha markup literal", () => {
  const src = `@if (x) {\n  @: Olá @Model.Nome fim\n}`;
  kept(src, "Olá", "fim");
  blanked(src, "Model.Nome");
});

// ═══════════════════════════ Layouts e sections ════════════════════════════

test("layout: Layout = \"_Layout\" em @{ } é C# (blanked)", () => {
  const src = `@{ Layout = "_Layout"; }\n<h1>x</h1>`;
  invariant(src);
  kept(src, "<h1>x</h1>");
  blanked(src, "Layout", "_Layout");
});

test("layout: Layout = null (sem layout)", () => {
  const src = `@{ Layout = null; }\n<h1>x</h1>`;
  kept(src, "<h1>x</h1>");
  blanked(src, "Layout", "null");
});

test("layout: @RenderBody() é chamada C# (blanked), <body> fica", () => {
  const src = `<body>@RenderBody()</body>`;
  invariant(src);
  kept(src, "<body>", "</body>");
  blanked(src, "RenderBody");
});

test("layout: @RenderSection(\"Scripts\", required: false)", () => {
  const src = `<footer>@RenderSection("Scripts", required: false)</footer>`;
  kept(src, "<footer>", "</footer>");
  blanked(src, "RenderSection", "Scripts");
});

test("layout: @await RenderSectionAsync(\"Scripts\", required: true)", () => {
  const src = `<div>@await RenderSectionAsync("Scripts", required: true)</div>`;
  invariant(src);
  kept(src, "<div>", "</div>");
  blanked(src, "await", "RenderSectionAsync", "Scripts");
});

test("layout: @section Scripts { } — corpo markup preservado, @expr interno blanked", () => {
  const src = `@section Scripts {\n  <script src="app.js"></script>\n  @Html.Raw(inline)\n}`;
  invariant(src);
  kept(src, `<script src="app.js"></script>`);
  blanked(src, "section", "Scripts", "Html.Raw", "inline");
});

test("layout: @section Styles com <link>", () => {
  const src = `@section Styles {\n  <link rel="stylesheet" href="site.css" />\n}`;
  kept(src, `<link rel="stylesheet" href="site.css" />`);
  blanked(src, "section", "Styles");
});

test("layout: @if (IsSectionDefined(...)) preserva markup do corpo", () => {
  const src = `@if (IsSectionDefined("Scripts")) { <p>tem scripts</p> }`;
  kept(src, "<p>tem scripts</p>");
  blanked(src, "IsSectionDefined", "if");
});

test("layout: _ViewStart típico (só @{ Layout = ... })", () => {
  const src = `@{\n    Layout = "_Layout";\n}`;
  invariant(src);
  blanked(src, "Layout", "_Layout");
  // Nenhum markup — a saída é só espaços e newlines.
  assert.equal(vh(src).trim(), "");
});

test("layout: layout aninhado — Layout aponta para outro _Layout", () => {
  const src = `@{ Layout = "~/Views/Shared/_LayoutAdmin.cshtml"; }\n@RenderBody()`;
  blanked(src, "Layout", "_LayoutAdmin", "RenderBody");
});

// ═══════════════ Partial Views e View Components (markup + C#) ═══════════════

test("partial: <partial name=\"_X\" /> é Tag Helper (fica como HTML)", () => {
  const src = `<partial name="_Row" />`;
  invariant(src);
  assert.equal(vh(src), src, "partial tag helper é markup");
});

test("partial: <partial name model=\"Model.Item\" /> — atributo com @expr? não, é literal", () => {
  // model="Model.Item" é um valor de atributo do tag helper (avaliado no
  // servidor); não tem `@`, então é markup literal e fica.
  const src = `<partial name="_Row" model="Model.Item" />`;
  assert.equal(vh(src), src);
});

test("partial: <partial for=\"Propriedade\" /> fica como HTML", () => {
  const src = `<partial name="_Field" for="Nome" />`;
  assert.equal(vh(src), src);
});

test("partial: @await Html.PartialAsync(\"_X\") — blanked", () => {
  const src = `<div>@await Html.PartialAsync("_Card")</div>`;
  kept(src, "<div>", "</div>");
  blanked(src, "await", "PartialAsync", "_Card");
});

test("partial: @await Html.PartialAsync(\"_X\", model) — blanked", () => {
  const src = `<div>@await Html.PartialAsync("_Card", Model.Item)</div>`;
  kept(src, "<div>", "</div>");
  blanked(src, "PartialAsync", "Model.Item");
});

test("partial: partial dentro de @foreach (loop) preserva ambos", () => {
  const src = `@foreach (var it in Model.Itens) {\n  <partial name="_Row" model="it" />\n}`;
  kept(src, `<partial name="_Row" model="it" />`);
  blanked(src, "foreach", "Model.Itens");
});

test("viewcomponent: @await Component.InvokeAsync(\"Nome\") — blanked", () => {
  const src = `<aside>@await Component.InvokeAsync("Cart")</aside>`;
  invariant(src);
  kept(src, "<aside>", "</aside>");
  blanked(src, "await", "Component.InvokeAsync", "Cart");
});

test("viewcomponent: com parâmetros anônimos new { }", () => {
  const src = `<aside>@await Component.InvokeAsync("Cart", new { id = Model.Id, qtd = 3 })</aside>`;
  kept(src, "<aside>", "</aside>");
  blanked(src, "Component.InvokeAsync", "Model.Id");
});

test("viewcomponent: <vc:my-component> tag helper fica como HTML", () => {
  const src = `<vc:cart-summary count="3"></vc:cart-summary>`;
  assert.equal(vh(src), src);
});

// ═══════════════════════════════ Tag Helpers ═══════════════════════════════

test("taghelper: anchor asp-controller/asp-action — atributos ficam", () => {
  const src = `<a asp-controller="Home" asp-action="Index">Início</a>`;
  invariant(src);
  assert.equal(vh(src), src, "tag helper é HTML processado no servidor");
});

test("taghelper: anchor com asp-route-id e múltiplos asp-route-*", () => {
  const src = `<a asp-action="Detalhe" asp-route-id="@Model.Id" asp-route-tab="info">ver</a>`;
  kept(src, "asp-action", "asp-route-id", "asp-route-tab", "<a ", "</a>");
  blanked(src, "Model.Id");
});

test("taghelper: form asp-controller/asp-action method post", () => {
  const src = `<form asp-controller="Cliente" asp-action="Salvar" method="post"></form>`;
  assert.equal(vh(src), src);
});

test("taghelper: input asp-for", () => {
  const src = `<input asp-for="Nome" class="form-control" />`;
  assert.equal(vh(src), src);
});

test("taghelper: input asp-for propriedade aninhada", () => {
  const src = `<input asp-for="Endereco.Cidade" />`;
  assert.equal(vh(src), src);
});

test("taghelper: label asp-for", () => {
  const src = `<label asp-for="Nome"></label>`;
  assert.equal(vh(src), src);
});

test("taghelper: textarea asp-for com conteúdo", () => {
  const src = `<textarea asp-for="Descricao" rows="4"></textarea>`;
  assert.equal(vh(src), src);
});

test("taghelper: select asp-for asp-items com @expr no atributo", () => {
  const src = `<select asp-for="Status" asp-items="Model.StatusOptions"></select>`;
  // asp-items="Model.StatusOptions" é literal (valor do tag helper, sem @).
  assert.equal(vh(src), src);
});

test("taghelper: span asp-validation-for", () => {
  const src = `<span asp-validation-for="Nome" class="text-danger"></span>`;
  assert.equal(vh(src), src);
});

test("taghelper: div asp-validation-summary", () => {
  const src = `<div asp-validation-summary="ModelOnly" class="text-danger"></div>`;
  assert.equal(vh(src), src);
});

test("taghelper: img asp-append-version com ~/ e @expr misto", () => {
  const src = `<img src="~/img/logo.png" asp-append-version="true" alt="@Model.Alt" />`;
  kept(src, `src="~/img/logo.png"`, "asp-append-version");
  blanked(src, "Model.Alt");
});

test("taghelper: environment include/exclude com markup interno", () => {
  const src = `<environment include="Development"><script src="dev.js"></script></environment>`;
  assert.equal(vh(src), src, "conteúdo do environment é markup");
});

test("taghelper: environment exclude com @expr interno blanked", () => {
  const src = `<environment exclude="Development"><span>@Model.Build</span></environment>`;
  kept(src, "<environment", "</environment>", "<span>", "</span>");
  blanked(src, "Model.Build");
});

test("taghelper: cache com corpo dinâmico", () => {
  const src = `<cache expires-after="@TimeSpan.FromMinutes(5)"><p>@Model.Now</p></cache>`;
  kept(src, "<cache", "</cache>", "<p>", "</p>");
  blanked(src, "TimeSpan.FromMinutes", "Model.Now");
});

test("taghelper: component type render-mode", () => {
  const src = `<component type="typeof(App)" render-mode="ServerPrerendered" />`;
  assert.equal(vh(src), src);
});

test("taghelper: customizado <my-widget> com atributo custom", () => {
  const src = `<my-widget title="Painel" data-id="@Model.Id"></my-widget>`;
  kept(src, "<my-widget", "</my-widget>", `title="Painel"`);
  blanked(src, "Model.Id");
});

// ═══════════════ Static files, ~/, anti-forgery, HTML/URL helpers ═══════════

test("static: ~/ em href fica literal (resolvido no servidor)", () => {
  const src = `<link href="~/css/site.css" rel="stylesheet" />`;
  assert.equal(vh(src), src);
});

test("static: <script src=\"~/js/app.js\">", () => {
  const src = `<script src="~/js/app.js"></script>`;
  assert.equal(vh(src), src);
});

test("helper: @Url.Content(\"~/img/x.png\") em atributo", () => {
  const src = `<img src="@Url.Content("~/img/x.png")" />`;
  kept(src, "<img src=", "/>");
  blanked(src, "Url.Content");
});

test("helper: @Html.AntiForgeryToken() dentro de form", () => {
  const src = `<form method="post">@Html.AntiForgeryToken()</form>`;
  kept(src, `<form method="post">`, "</form>");
  blanked(src, "Html.AntiForgeryToken");
});

for (const helper of [
  "Html.DisplayFor(m => m.Nome)",
  "Html.EditorFor(m => m.Nome)",
  "Html.TextBoxFor(m => m.Nome)",
  "Html.HiddenFor(m => m.Id)",
  "Html.CheckBoxFor(m => m.Ativo)",
  "Html.DropDownListFor(m => m.Status, Model.Opts)",
  "Html.ValidationMessageFor(m => m.Nome)",
  "Html.ValidationSummary()",
  "Html.Partial(\"_X\")",
  "Html.Raw(Model.Html)",
  "Url.Action(\"Index\", \"Home\")",
  "Url.RouteUrl(\"default\")",
]) {
  test(`helper: @${helper.split("(")[0]} — expressão C# blanked`, () => {
    const src = `<div>@${helper}</div>`;
    kept(src, "<div>", "</div>");
    blanked(src, helper.split("(")[0]);
  });
}

// ══════════════════════════ Encoding e segurança ═══════════════════════════

test("segurança: @Model.Texto não injeta markup (fica blanked)", () => {
  // Mesmo que o dado do usuário contenha `<`, a EXPRESSÃO é blanked na projeção;
  // o encoding real acontece em runtime. O ponto aqui: o identificador não vira
  // tag no HTML virtual.
  const src = `<p>@Model.ComentarioDoUsuario</p>`;
  blanked(src, "Model.ComentarioDoUsuario");
  kept(src, "<p>", "</p>");
});

test("segurança: @Html.Raw distinto de @expr — ambos blanked na projeção", () => {
  const src = `<div>@Html.Raw(Model.Html) e @Model.Texto</div>`;
  blanked(src, "Html.Raw", "Model.Html", "Model.Texto");
  kept(src, "<div>", "</div>");
});

test("segurança: conteúdo em <script> com @expr blanked", () => {
  const src = `<script>var id = @Model.Id;</script>`;
  kept(src, "<script>", "</script>", "var id = ");
  blanked(src, "Model.Id");
});

// ═══════════════════════ Razor Pages / MVC / Areas ═════════════════════════

test("pages: @page + @model + handler markup", () => {
  const src = `@page\n@model IndexModel\n<form method="post"><button asp-page-handler="Delete">x</button></form>`;
  kept(src, `<form method="post">`, "asp-page-handler", "</form>");
  blanked(src, "IndexModel");
});

test("pages: @page \"{id:int}\" rota tipada", () => {
  const src = `@page "{id:int}"\n@model DetalheModel\n<h1>@Model.Titulo</h1>`;
  kept(src, "<h1>", "</h1>");
  blanked(src, "id:int", "DetalheModel", "Model.Titulo");
});

test("pages: asp-page e asp-page-handler em anchor", () => {
  const src = `<a asp-page="/Clientes/Editar" asp-route-id="@Model.Id">editar</a>`;
  kept(src, "asp-page", "asp-route-id");
  blanked(src, "Model.Id");
});

test("mvc: view com @model + @foreach + partial", () => {
  const src = `@model IEnumerable<Cliente>\n<table>@foreach (var c in Model) { <tr><td>@c.Nome</td></tr> }</table>`;
  kept(src, "<table>", "</table>", "<tr>", "<td>", "</td>", "</tr>");
  blanked(src, "IEnumerable", "foreach", "c.Nome");
});

test("areas: asp-area em anchor tag helper", () => {
  const src = `<a asp-area="Admin" asp-controller="Home" asp-action="Index">admin</a>`;
  assert.equal(vh(src), src);
});

// ═══════════════════════ Cultura / formatação (C# em expr) ══════════════════

test("cultura: @Model.Data.ToString(\"dd/MM/yyyy\") blanked", () => {
  const src = `<span>@Model.Data.ToString("dd/MM/yyyy")</span>`;
  kept(src, "<span>", "</span>");
  blanked(src, "Model.Data", "dd/MM/yyyy");
});

test("cultura: @Model.Valor.ToString(\"C\", cultura) blanked", () => {
  const src = `<span>@Model.Valor.ToString("C2")</span>`;
  kept(src, "<span>", "</span>");
  blanked(src, "Model.Valor", "C2");
});

test("cultura: string interpolada com formato @($\"{x:N2}\")", () => {
  const src = `<b>@($"{Model.Preco:N2}")</b>`;
  kept(src, "<b>", "</b>");
  blanked(src, "Model.Preco", "N2");
});

// ══════════════════ regionAt: roteamento de completion ══════════════════════

test("region: caret após @Model. classifica como Razor (member completion)", () => {
  const src = `<p>@Model.</p>`;
  const { mask } = buildVirtualHtml(src);
  const caret = src.indexOf("@Model.") + "@Model.".length;
  assert.equal(regionAt(mask, caret), "razor");
});

test("region: caret em posição de atributo HTML classifica como HTML", () => {
  const src = `<div >`;
  const { mask } = buildVirtualHtml(src);
  assert.equal(regionAt(mask, at(src, " ")), "html");
});

test("region: nome de tag é HTML, @expr adjacente é Razor", () => {
  const src = `<div>@Nome</div>`;
  const { mask } = buildVirtualHtml(src);
  assert.equal(regionAt(mask, at(src, "div")), "html");
  assert.equal(regionAt(mask, at(src, "Nome")), "razor");
});

import assert from "node:assert/strict";
import test from "node:test";
import type { KnowledgeFile, KnowledgeIndex } from "../types.ts";
import {
  formatWorkspaceContext,
  knowledgeHubs,
  queryTerms,
  rankKnowledge,
} from "./workspaceSearch.ts";

function file(rel: string, extra: Partial<KnowledgeFile> = {}): KnowledgeFile {
  return {
    path: `/w/${rel}`,
    name: rel.split("/").pop()!,
    rel,
    kind: rel.endsWith(".md") ? "markdown" : "code",
    outgoing: [],
    tags: [],
    headings: [],
    ...extra,
  };
}

const link = (target: string) => ({ target: `/w/${target}`, relation: "import" as const, line: 1, snippet: "" });

const index: KnowledgeIndex = {
  files: [
    file("src/auth/LoginService.ts", { outgoing: [link("src/http/client.ts")] }),
    file("src/http/client.ts"),
    file("src/ui/Button.tsx", { outgoing: [link("src/http/client.ts")] }),
    file("docs/autenticacao.md", {
      headings: [{ level: 1, text: "Fluxo de login", line: 1 }],
      tags: ["auth"],
      outgoing: [link("src/auth/LoginService.ts")],
    }),
    file("src/chat/Composer.tsx", { outgoing: [link("src/http/client.ts")] }),
  ],
};

test("termos: sem acento, sem stopwords, sem palavras curtas", () => {
  assert.deepEqual(queryTerms("Como funciona o login de autenticação?"), ["login", "autenticacao"]);
  assert.deepEqual(queryTerms("o que é o http_client"), ["http_client", "http", "client"]);
});

test("ranqueia por nome, caminho, títulos e tags", () => {
  const ranked = rankKnowledge(index, "como funciona o login?");
  assert.equal(ranked[0].file.rel, "src/auth/LoginService.ts");
  assert.ok(ranked.some((entry) => entry.file.rel === "docs/autenticacao.md"));
  assert.ok(ranked[0].reasons.some((reason) => reason.includes("login")));
  // Arquivo sem relação não entra.
  assert.ok(!ranked.some((entry) => entry.file.rel === "src/ui/Button.tsx"));
});

test("o grafo reforça o arquivo ativo e seus vizinhos", () => {
  const ranked = rankKnowledge(index, "refatorar", { seedPath: "/w/src/auth/LoginService.ts" });
  const rels = ranked.map((entry) => entry.file.rel);
  assert.equal(rels[0], "src/auth/LoginService.ts");
  assert.ok(rels.includes("src/http/client.ts"), "vizinho de saída");
  assert.ok(rels.includes("docs/autenticacao.md"), "backlink");
  assert.ok(!rels.includes("src/ui/Button.tsx"));
});

test("hubs são os mais referenciados", () => {
  assert.deepEqual(knowledgeHubs(index, 1), [{ rel: "src/http/client.ts", count: 3 }]);
});

test("bloco de contexto lista arquivos, motivos e conexões", () => {
  const ranked = rankKnowledge(index, "login");
  const block = formatWorkspaceContext("CONTEXTO DO WORKSPACE (@workspace)", ranked, index, {
    hubs: knowledgeHubs(index, 2),
    contents: [{ rel: "src/auth/LoginService.ts", content: "export {}", lang: "ts" }],
  });
  assert.ok(block.startsWith("CONTEXTO DO WORKSPACE (@workspace)\nWorkspace com 5 arquivo(s)"));
  assert.ok(block.includes("- `src/auth/LoginService.ts` — nome contém \"login\""));
  assert.ok(block.includes("aponta para: src/http/client.ts"));
  assert.ok(block.includes("Arquivos centrais (mais referenciados): `src/http/client.ts` (3)"));
  assert.ok(block.includes("```ts\nexport {}\n```"));
  assert.ok(
    formatWorkspaceContext("X", [], index).includes("Nenhum arquivo do grafo de conhecimento"),
  );
});

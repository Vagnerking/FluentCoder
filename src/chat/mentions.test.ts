import assert from "node:assert/strict";
import test from "node:test";
import {
  findMentionTrigger,
  foldText,
  mentionSuggestions,
  removeMentionToken,
} from "./mentions.ts";
import type { ProjectFile } from "../types.ts";

const files: ProjectFile[] = [
  { path: "/w/src/App.tsx", name: "App.tsx", rel: "src/App.tsx" },
  { path: "/w/src/chat/mentions.ts", name: "mentions.ts", rel: "src/chat/mentions.ts" },
  { path: "/w/README.md", name: "README.md", rel: "README.md" },
];

test("detecta # e @ no início ou depois de espaço", () => {
  assert.deepEqual(findMentionTrigger("#gra", 4), { trigger: "#", query: "gra", start: 0, end: 4 });
  assert.deepEqual(findMentionTrigger("veja @work", 10), {
    trigger: "@",
    query: "work",
    start: 5,
    end: 10,
  });
  // Gatilho sozinho já abre o popup (query vazia).
  assert.equal(findMentionTrigger("oi #", 4)?.query, "");
  // Aceita acento no token.
  assert.equal(findMentionTrigger("#seleç", 6)?.query, "seleç");
});

test("ignora # colado em palavra (C#, e-mail, âncora)", () => {
  assert.equal(findMentionTrigger("em C#", 5), null);
  assert.equal(findMentionTrigger("ana@site", 8), null);
  assert.equal(findMentionTrigger("sem gatilho", 11), null);
  // Espaço depois do token fecha a menção.
  assert.equal(findMentionTrigger("#grafo ", 7), null);
});

test("foldText remove acento e caixa", () => {
  assert.equal(foldText("Seleção"), "selecao");
});

test("ranqueia menções por prefixo, sinônimo e sem acento", () => {
  const byQuery = (text: string) =>
    mentionSuggestions(findMentionTrigger(text, text.length)!, files)
      .filter((s) => s.type === "mention")
      .map((s) => (s.type === "mention" ? s.mention.kind : ""));
  assert.deepEqual(byQuery("#selecao"), ["selection"]);
  assert.equal(byQuery("#pro")[0], "problems");
  assert.equal(byQuery("#graph")[0], "graph");
  assert.equal(byQuery("#")[0], "activeFile");
  assert.ok(byQuery("#").length >= 6);
  assert.deepEqual(byQuery("@work"), ["workspace"]);
});

test("# também sugere arquivos do índice do Quick Open (fuzzy)", () => {
  const suggestions = mentionSuggestions(findMentionTrigger("#ment", 5)!, files);
  const file = suggestions.find((s) => s.type === "file");
  assert.ok(file && file.type === "file");
  assert.equal(file.file.name, "mentions.ts");
  // @ não lista arquivos.
  assert.ok(
    mentionSuggestions(findMentionTrigger("@ment", 5)!, files).every((s) => s.type === "mention"),
  );
  // Sem texto, só as menções (sem despejar o índice inteiro).
  assert.ok(mentionSuggestions(findMentionTrigger("#", 1)!, files).every((s) => s.type === "mention"));
});

test("remove o token ao virar chip, sem espaço duplo", () => {
  const text = "explique #grafo agora";
  const trigger = findMentionTrigger(text, 15)!;
  assert.deepEqual(removeMentionToken(text, trigger), { text: "explique agora", caret: 9 });
  assert.deepEqual(removeMentionToken("#arq", findMentionTrigger("#arq", 4)!), { text: "", caret: 0 });
});

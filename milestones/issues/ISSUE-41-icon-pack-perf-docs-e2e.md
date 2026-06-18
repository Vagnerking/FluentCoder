# ISSUE-41 · Performance (no-inline), docs e E2E

**Épico:** [Icon Pack — Material + Codicons](../EPIC-icon-pack-monaco.md) · **Camada:** Full · **Tamanho:** S · **Depende de:** 38–40 · **Status:** ✅ Concluída

## Contexto

Fechamento do épico: garantir que ~1200 SVGs não pesem no startup, documentar uso e
customização, e cobrir com E2E (regra do projeto: `tauri build` + tauri-driver).

## Tarefas

- [x] `vite.config.ts`: `build.assetsInlineLimit` retorna `false` para
      `material-icon-theme/icons/` — cada SVG vira asset hasheado (lazy), não base64
      no JS. (Sem isso, ~2440 ícones inlavam +1 MB no bundle de startup.)
- [x] Documentação de uso + customização em `src/icon-theme/README.md`.
- [x] Teste de unidade `icon-resolver.test.ts` (cadeia de prioridade contra o JSON
      real do pacote). `test:unit` passou a varrer `src/**/*.test.ts`.
- [x] E2E `icon-pack.e2e.ts`: Codicons da activity/status bar renderizando com a
      web-font `codicon` real (font-family + glyph `::before` + FontFace registrada).
- [x] Ajustar `features.e2e.ts` (StatusBar): asserção mudou de glyph unicode `✕/⚠`
      para presença dos Codicons `.codicon-error`/`.codicon-warning`.

## Arquivos

- `vite.config.ts`, `package.json` (script `test:unit`)
- `src/icon-theme/README.md` (novo)
- `src/icon-theme/material/icon-resolver.test.ts` (novo)
- `tests/e2e/specs/icon-pack.e2e.ts` (novo), `tests/e2e/specs/features.e2e.ts`

## Detalhes técnicos

- Build de produção: JS principal ~1.06 MB (sem data-URIs de SVG); 1242 SVGs
  emitidos como arquivos; `.ttf` do codicon emitida.
- O teste de unidade espelha a cadeia do resolver porque o resolver importa o JSON
  via sintaxe Vite (não carregável no runner de Node); roda contra o JSON real.

## Critérios de aceite

- [x] `npm run build`: nenhum SVG do Material inlined no JS; SVGs como assets.
- [x] `npm run test:unit`: testes de resolver + fuzzy passando.
- [x] E2E `icon-pack` verde (Codicons com web-font na janela Tauri real).
- [x] Docs de uso e de "como adicionar ícones" presentes.

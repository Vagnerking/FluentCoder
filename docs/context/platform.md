# Camada de plataforma

O Rust injeta `__FLUENT_PLATFORM__` antes do primeiro paint de cada webview.
O frontend lê esse snapshot de forma síncrona; fora do Tauri há fallback de
user agent. Capacidades descrevem convenções do SO, não autorização nem
propriedades verificadas de cada volume.

## Processos e IPC

Os comandos de revelar, abrir caminho e abrir URL usam argumentos separados.
URLs externas aceitam apenas http, https e mailto; erro deve chegar ao chamador.
Chamadas que esperam processos usam `spawn_blocking` para preservar o event loop.
Os planos de Explorer, Finder e FileManager1 possuem testes independentes do SO.
Isso não substitui o aceite nativo dos aplicativos e gerenciadores de arquivos.
Adaptadores puros validam caminhos pelas regras do SO modelado: o adaptador
Linux aceita um XDG absoluto com `/`, inclusive quando o teste roda no Windows.
Não usar regras de drive/root do host para decidir se um caminho POSIX é absoluto.

`workspaceRoot`, quando informado, restringe o caminho canonicalizado ao root
canonicalizado, inclusive ao resolver symlinks. O parâmetro é controlado pelo
chamador e não é uma ACL: a interface privilegiada pode abrir arquivos externos
omitindo-o. Não ampliar capabilities para conteúdo remoto. Abertura de um item
não garante identidade imutável se outro processo substituir o arquivo depois.

O probe do PATH do shell de login ocorre antes de iniciar threads do Tauri.
Processo e leitura de stdout compartilham o prazo; a saída tem teto de 8 MiB.
Timeout, erro ou excesso descartam o resultado. O filho direto é recolhido;
processos de background iniciados pelo perfil não são gerenciados pelo probe.
Fixtures usam shell instalado e argumentos posicionais, evitando executar um
script recém-gravado sujeito a ETXTBSY durante forks paralelos.

## Identidade de caminhos e integração

Não inferir identidade de arquivos POSIX a partir de “macOS”: APFS também pode
ser case-sensitive. `samePath` e `pathForWorkspaceDisplay` preservam o caso
POSIX por padrão; o opt-in explícito exige informação do filesystem pelo
chamador. O suporte por volume e sua propagação aos consumidores continuam
no incremento de integração, incluindo volumes case-sensitive e insensitive.
Referência: [formatos suportados pela Apple](https://support.apple.com/en-ie/guide/disk-utility/dsku19ed921c/mac).

O porte inicial disponibiliza APIs e preserva as rotas existentes. Migração
de todos os consumidores de UI e o teste global `src/platform/lint.test.ts`
pertencem ao incremento de integração; suas verificações permanecem no escopo.
Testes Rust ignorados, aceites nativos e revisão efetiva não contam como aprovação.

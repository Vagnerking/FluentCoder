// PROPOSITAL: falta `using Ddd.Domain.Entities;` — a classe Cliente vem da
// camada Domain (que este projeto JÁ referencia). O quick fix "using ..." deve
// aparecer aqui (cenário 1: add-using cross-camada, ProjectReference existe).
namespace Ddd.Application.Services;

public class ClienteService
{
    public string Descrever(Cliente cliente)
    {
        return $"{cliente.Id}: {cliente.Nome}";
    }
}

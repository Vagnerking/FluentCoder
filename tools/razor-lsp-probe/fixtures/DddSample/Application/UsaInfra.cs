// PROPOSITAL: usa RepositorioSql, que está na camada Infra — e a Application NÃO
// referencia o projeto Infra. Aqui o C# Dev Kit ofereceria "Add project
// reference to 'Infra'". O Roslyn standalone (sem o componente de projeto do Dev
// Kit) NÃO oferece isso — cenário 2, para provar o gap.
namespace Ddd.Application.Services;

public class UsaInfra
{
    public string Ler(RepositorioSql repo) => repo.ConnectionString;
}

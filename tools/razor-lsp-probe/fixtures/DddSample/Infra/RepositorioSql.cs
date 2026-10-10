namespace Ddd.Infra.Persistence;

/// <summary>Tipo na camada Infra que a Application NÃO referencia — usado para
/// testar o cenário 2 (add ProjectReference cross-camada).</summary>
public class RepositorioSql
{
    public string ConnectionString { get; set; } = "";
}

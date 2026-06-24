namespace SampleMvc.Models;

/// <summary>Test model used by the Fase 0 Razor LSP probe.</summary>
public class WeatherModel
{
    public string City { get; set; } = "";

    public int TemperatureC { get; set; }

    public int TemperatureF => 32 + (int)(TemperatureC / 0.5556);

    public WeatherKind Kind { get; set; }
}

public enum WeatherKind
{
    Sunny,
    Cloudy,
    Rainy,
}

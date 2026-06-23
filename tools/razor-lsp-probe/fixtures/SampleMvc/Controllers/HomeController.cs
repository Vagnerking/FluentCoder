using Microsoft.AspNetCore.Mvc;
using SampleMvc.Models;

namespace SampleMvc.Controllers;

public class HomeController : Controller
{
    public IActionResult Index()
    {
        var model = new WeatherModel { City = "Lisboa", TemperatureC = 21, Kind = WeatherKind.Sunny };
        return View(model);
    }
}

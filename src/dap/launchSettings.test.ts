import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLaunchSettings, splitArgs } from "./launchSettings.ts";

const SAMPLE = `﻿{
  "profiles": {
    "http": {
      "commandName": "Project",
      "applicationUrl": "http://localhost:5046",
      "environmentVariables": { "ASPNETCORE_ENVIRONMENT": "Development" }
    },
    "https": {
      "commandName": "Project",
      "applicationUrl": "https://localhost:7069;http://localhost:5046",
      "environmentVariables": { "ASPNETCORE_ENVIRONMENT": "Development" },
      "commandLineArgs": "--seed \\"my db\\""
    },
    "IIS Express": { "commandName": "IISExpress" }
  }
}`;

test("parses project profiles, drops IIS Express, handles BOM", () => {
  const profiles = parseLaunchSettings(SAMPLE);
  assert.deepEqual(profiles.map((p) => p.name), ["http", "https"]);
  assert.equal(profiles[0].applicationUrl, "http://localhost:5046");
  assert.equal(profiles[0].environmentVariables.ASPNETCORE_ENVIRONMENT, "Development");
});

test("splits commandLineArgs respecting quotes", () => {
  const https = parseLaunchSettings(SAMPLE).find((p) => p.name === "https")!;
  assert.deepEqual(https.commandLineArgs, ["--seed", "my db"]);
});

test("invalid or empty JSON yields no profiles (never throws)", () => {
  assert.deepEqual(parseLaunchSettings("not json"), []);
  assert.deepEqual(parseLaunchSettings("{}"), []);
  assert.deepEqual(parseLaunchSettings('{"profiles":{}}'), []);
});

test("splitArgs basics", () => {
  assert.equal(splitArgs(undefined), undefined);
  assert.equal(splitArgs("   "), undefined);
  assert.deepEqual(splitArgs("--a --b"), ["--a", "--b"]);
  assert.deepEqual(splitArgs('--path "c:/a b/x"'), ["--path", "c:/a b/x"]);
});

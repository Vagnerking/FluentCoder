"use strict";
function load() { return typeof require("vscode") === "object" ? 1 : 0; }
const api = load();
const vscode = require("vscode");
vscode.window.showInformationMessage("ok");

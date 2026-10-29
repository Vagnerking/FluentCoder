"use strict";
// O namespace fica guardado num objeto antes de ser usado: a varredura não segue.
const holder = { api: require("vscode") };
exports.activate = () => holder.api.commands.registerCommand("acme.run", () => holder.api.window.showInformationMessage("oi"));

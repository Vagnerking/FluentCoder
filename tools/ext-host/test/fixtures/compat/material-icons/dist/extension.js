"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vscode_1 = require("vscode");
const lang = require("./lang");
function activate(context) {
    context.subscriptions.push(vscode_1.commands.registerCommand("material-icon-theme.activateIcons", async () => {
        const pick = await vscode_1.window.showQuickPick(["a", "b"]);
        if (pick) await vscode_1.workspace.getConfiguration("workbench").update("iconTheme", "material-icon-theme", true);
    }));
    vscode_1.workspace.onDidChangeConfiguration(() => {});
}
exports.activate = activate;

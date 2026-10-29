"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vscode = require("vscode");
const cp = require("child_process");
function activate(context) {
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
    context.subscriptions.push(vscode.commands.registerCommand("git-graph.view", () => {
        const panel = vscode.window.createWebviewPanel("git-graph", "Git Graph", vscode.ViewColumn.One, { enableScripts: true });
        panel.webview.onDidReceiveMessage((msg) => {
            if (msg.command === "viewDiff") return vscode.commands.executeCommand("vscode.diff", vscode.Uri.parse(msg.a), vscode.Uri.parse(msg.b), msg.title, { preview: true });
            if (msg.command === "openFile") return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
        });
    }));
    vscode.workspace.onDidChangeConfiguration(() => {});
    cp.spawn("git", ["log"]);
}
exports.activate = activate;

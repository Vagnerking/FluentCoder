// src/extension.ts
import { commands as commands2, workspace as workspace6 } from "vscode";
// src/commands.ts
import { window } from "vscode";
import * as vs from "vscode";
var createConfigFile = () => async () => { const folder = await window.showWorkspaceFolderPick(); };
function activate(ctx) {
  ctx.subscriptions.push(commands2.registerCommand("prettier.createConfigFile", createConfigFile()));
  workspace6.onDidChangeWorkspaceFolders(() => {});
  vs.languages.registerDocumentFormattingEditProvider("*", {});
}
export { activate };

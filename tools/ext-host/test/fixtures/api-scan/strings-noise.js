"use strict";var e=require("vscode"),t=require("node:process");
class G{constructor(){this.M=e}run(){const x=this.M.workspace.getConfiguration("workbench");return e._(x),e.__esModule,e.affectsConfiguration("a"),e.glsl,e.deflate()}}
const vscode = require("vscode");
vscode.commands.executeCommand("vscode.diff", a, b, "t");
vscode.commands.executeCommand('vscode.open', a);
const msg = `use vscode.openFolder now`;
vscode.window.createWebviewPanel("graph", "Graph", vscode.ViewColumn.One, {});

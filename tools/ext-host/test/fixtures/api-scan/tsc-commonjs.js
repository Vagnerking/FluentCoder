"use strict";
var __importStar = (this && this.__importStar) || function (mod) { return mod; };
Object.defineProperty(exports, "__esModule", { value: true });
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const { workspace, Uri: U, commands: cmds } = require("vscode");
const window = vscode.window;
function activate(context) {
    window.cache = window.createOutputChannel("x");
    if (window.flag) { }
    vscode_1.languages.registerCodeLensProvider({ language: "ts" }, {});
    workspace.getConfiguration("x").get("y");
    cmds.registerCommand("x.y", () => U.file("/a"));
    new vscode.Range(0, 0, 0, 1);
    vscode.window.statusBarItem = 1;
    require("vscode").env.clipboard.writeText("x");
    x.vscode.window.nope();
}
exports.activate = activate;

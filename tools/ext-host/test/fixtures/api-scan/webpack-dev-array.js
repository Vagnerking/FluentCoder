/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ([
/* 0 */,
/* 1 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {

exports.register = void 0;
const vscode = __webpack_require__(2);
function register(context) {
    context.subscriptions.push(vscode.window.registerTreeDataProvider("tags", {}));
    vscode.notebooks.registerNotebookCellStatusBarItemProvider("jupyter-notebook", {});
    const align = vscode.NotebookCellStatusBarAlignment.Left;
}
exports.register = register;

/***/ }),
/* 2 */
/***/ ((module) => {

module.exports = require("vscode");

/***/ })
/******/ 	]);
})();

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
const diff = require("diff");
const diff_match_patch_1 = require("diff-match-patch");
function activate(context) {
    let disposable = vscode.commands.registerCommand("extension.applyDiff", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("No active editor found.");
            return;
        }
        const clipboardContent = await vscode.env.clipboard.readText();
        if (!isValidDiff(clipboardContent)) {
            vscode.window.showErrorMessage("Clipboard content is not a valid diff.");
            return;
        }
        const currentContent = editor.document.getText();
        const patchedContent = applyDiff(currentContent, clipboardContent);
        if (!patchedContent) {
            vscode.window.showErrorMessage("Failed to apply diff.");
            return;
        }
        await editor.edit((editBuilder) => {
            const fullRange = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(currentContent.length));
            editBuilder.replace(fullRange, patchedContent);
        });
    });
    context.subscriptions.push(disposable);
}
exports.activate = activate;
function isValidDiff(clipboardContent) {
    try {
        const patches = diff.parsePatch(clipboardContent);
        return patches.length > 0;
    }
    catch (error) {
        return false;
    }
}
function applyDiff(currentContent, clipboardContent) {
    const dmp = new diff_match_patch_1.diff_match_patch();
    const patches = dmp.patch_fromText(clipboardContent);
    const result = dmp.patch_apply(patches, currentContent);
    if (!result[1].every((success) => success)) {
        return null;
    }
    return result[0];
}
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map
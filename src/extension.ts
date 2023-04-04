import * as vscode from 'vscode';
import { createTwoFilesPatch, applyPatch } from 'diff';

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand("extension.applyDiff", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No active editor found.");
      return;
    }
    await applyDiff();
  });
}

async function applyDiff() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active text editor found.');
    return;
  }

  const clipboardContent = await vscode.env.clipboard.readText();
  if (!clipboardContent) {
    vscode.window.showErrorMessage('Clipboard is empty.');
    return;
  }

  const editorText = editor.document.getText();
  const diffText = clipboardContent;

  try {
    const patchedText = applyPatch(editorText, diffText);
    
    if (! patchedText) {
      vscode.window.showErrorMessage("Could not apply the diff to the current file. Some parts of the diff may be incorrect or conflicting.");
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      editor.document.uri,
      new vscode.Range(
        editor.document.positionAt(0),
        editor.document.positionAt(editorText.length)
      ),
      patchedText
    );
    await vscode.workspace.applyEdit(edit);
    vscode.window.showInformationMessage('Diff applied successfully.');
  } catch (error) {
    console.error('Error applying diff:', error);
    vscode.window.showErrorMessage('An error occurred while applying the diff. Please check if the diff is valid and try again.');
  }
}

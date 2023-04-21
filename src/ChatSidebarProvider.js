const vscode = require('vscode')
const prompts = require('./utils/prompts.js')
const { Configuration, OpenAIApi } = require("openai");
const fs = require('fs');
const path = require('path');
const { applyPatch } = require('diff');
const { exec } = require('child_process');

// OpenAI - Cohere API Key
const API_KEY = 'API_KEY'

const historySaveStateKey = 'aiide_history';
const commandAutoExecList = ['tree', 'read_file', 'front_file', 'selected_text']

function buildDirectoryTree(dirPath, depth = 0) {
  function getTabs(numTabs) {
    return '\t'.repeat(numTabs);
  }
  let treeString = '';
  const filesAndDirs = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const item of filesAndDirs) {
    if (item.isDirectory() && item.name[0] == '.')
      continue
    if (item.isDirectory() && item.name == 'node_modules')
      continue
    treeString += getTabs(depth) + item.name;

    if (item.isDirectory()) {
      const nestedDirPath = path.join(dirPath, item.name);
      treeString += '/\n' + buildDirectoryTree(nestedDirPath, depth + 1);
    } else {
      treeString += '\n';
    }
  }
  return treeString;
}

class ChatSidebarProvider {
  constructor (context) {
    this._view = null
    this._extensionUri = context.extensionUri
    this._vscode = vscode
    this._context = context
    this._history = this._context.globalState.get(historySaveStateKey) || []
  }

  static getChatInstance (context) {
    if (!ChatSidebarProvider._instance) {
      ChatSidebarProvider._instance = new ChatSidebarProvider(context)
      console.log('Congratulations, your extension "aiide" is now active!')
    }
    return ChatSidebarProvider._instance
  }

  get view () {
    return this._view
  }

  resolveWebviewView (webviewView) {
    this._view = webviewView
    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true
    }
    this._update()
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)
  }

  generateUniqueId () {
    const timestamp = Date.now()
    const randomNumber = Math.random()
    const hexadecimalString = randomNumber.toString(16)
    return `id-${timestamp}-${hexadecimalString}`
  }

  async sendPrompt(data, apiKey, isGenerated = false) {
    const uniqueId = data.uniqueId
    const model = vscode.workspace.getConfiguration().get('AIIDE.model')
    const temperature = vscode.workspace.getConfiguration().get('AIIDE.temperature')
//    const maxTokens = vscode.workspace.getConfiguration().get('AIIDE.maxTokens')
//    const language = vscode.workspace.getConfiguration().get('AIIDE.query.language')

    let message = data.text
    let command
    let response
    try {
      this._view.webview.postMessage({
        type: 'isStreaming',
        ok: true
      })
      if (!apiKey.g) {
        vscode.window.showErrorMessage('Enter your API KEY to save it securely.')
        this._view.webview.postMessage({
          type: 'showResponse',
          ok: true,
          text: 'Please enter your api key.',
          uniqueId
        })
        return
      }
      const configuration = new Configuration({
        apiKey: apiKey.g,
      });
      const openai = new OpenAIApi(configuration);
      const messages = 
        [{role:'system', content:prompts.getSystemPrompt(this._context)},
        //{role:'system', content: 'Current directory tree:\n' + buildDirectoryTree(vscode.workspace.workspaceFolders[0].uri.fsPath)}
        ]
          .concat(this._history.map((p) => { return {role:p.role, content:p.content}}))
          .concat([{role:'user', content:message}])
          
      const completion = await openai.createChatCompletion({
        model: model,
        messages: messages,
        temperature: temperature
      });

      let data
      try {
        console.log(completion.data.choices[0].message.content)
        data = JSON.parse(completion.data.choices[0].message.content)
      } catch (e) {
        console.log(`${completion.data.choices[0].message.content}`)
        throw e
      }
      response = data.thoughts.speak
      command = data.command

      this._history.push(
        {role:'user', 
          id: this.generateUniqueId(), 
          content:message,
          isGenerated},
        {role:'assistant', 
          id: this.generateUniqueId(), 
          content:completion.data.choices[0].message.content})
      this._context.globalState.update(historySaveStateKey, this._history)
    } catch (error) {
      response = `OpenAI API Response was: ${error}`
      vscode.window.showErrorMessage(response)
    } finally {
      this._view.webview.postMessage({
        type: 'isStreaming',
        ok: false
      })
    }
    if (response) {
      this._view.webview.postMessage({
        type: 'syncHistory',
        history: this._history
      })
    }
    await this.checkAutoExec(command, apiKey)
  }

  async checkAutoExec(command, apiKey) {
    if (command && commandAutoExecList.includes(command.name)) {
      await this.runCommand(command, apiKey)
    }
  }

  async readFileData(relativePath) {
    return new Promise((resolve, reject) => {
      const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const filePath = path.join(workspacePath, relativePath);
      fs.readFile(filePath, 'utf8', (error, data) => {
        if (error) {
          reject(error);
        } else {
          resolve(data);
        }
      });
    });
  }
  
  async createProjectFile(relativePath, fileData) {
    return new Promise((resolve, reject) => {
      const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const filePath = path.join(workspacePath, relativePath);
      fs.writeFile(filePath, fileData, 'utf8', (error) => {
        if (error) {
          reject(error);
        } else {
          resolve(filePath);
        }
      });
    });
  }

  async deleteProjectFile(relativePath) {
    return new Promise((resolve, reject) => {
      const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const filePath = path.join(workspacePath, relativePath);
      fs.unlink(filePath, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve(true);
        }
      });
    });
  }
  
  async applyDiffToFile(file, patch) {
    try {
      const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const filePath = path.join(workspacePath, file);
      let patchedText
      if (patch.startsWith('---') || patch.startsWith('@@')) {
        const fileData = await this.readFileData(file);
        patchedText = applyPatch(fileData, patch);
      } else {
        patchedText = patch
      }
      if (patchedText === false) {
        throw new Error("Could not apply the diff to the file. Some parts of the diff may be incorrect or conflicting.");
      }
      await this.createProjectFile(file, patchedText);
      console.log("Diff applied successfully.");
      return true
    } catch (error) {
      console.error("Error applying diff:", error);
      return false
    }
  }

  // descriptions, type, text
  async executeScript(scriptObj) {
    return new Promise((resolve, reject) => {
      const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
      let cmd = 'python3'
      let arg = '-c'
      switch(scriptObj.type) {
        case 'python':
          cmd = 'python3'
          break
        case 'bash':
          cmd = 'bash'
          break
      }

      const script = `${cmd} ${arg} "${scriptObj.text.replace(/"/g, '\\"')}"`;
      const options = { cwd: workspacePath };
  
      exec(script, options, (error, stdout, stderr) => {
        if (error) {
          resolve(stderr); // we no reject
        } else {
          resolve(stdout);
        }
      });
    });
  }

  async runCommand(command, apiKey) {
    try {
      switch (command.name) {
        case 'tree': {
          let treeTxt = buildDirectoryTree(vscode.workspace.workspaceFolders[0].uri.fsPath)
          await this.sendPrompt({
            text: treeTxt,
            uniqueId: this.generateUniqueId()
          }, apiKey, true)
          break
        }
        case 'read_file': {
          let file = command.args.file
          await this.sendPrompt({
            text: await this.readFileData(file),
            uniqueId: this.generateUniqueId()
          }, apiKey, true)                
          break
        }
        case 'front_file': {
          let ff = vscode.window.activeTextEditor?.document.uri
          let p = ff?.path
          await this.sendPrompt({
            text: p ?? '',
            uniqueId: this.generateUniqueId()
          }, apiKey, true)
          break
        }
        case 'create_file': {
          let file = command.args.file
          let content = command.args.content
          await this.createProjectFile(file, content)
          await this.sendPrompt({
            text: 'true',
            uniqueId: this.generateUniqueId()
          }, apiKey, true)
          break
        }
        case 'delete_file': {
          let file = command.args.file
          await this.sendPrompt({
            text: await this.deleteProjectFile(file),
            uniqueId: this.generateUniqueId()
          }, apiKey, true)
          break
        }
        case 'selected_text': {
          const editor = vscode.window.activeTextEditor
          const { document } = editor
          const cursorPosition = editor.selection.active
          const selection = new vscode.Selection(cursorPosition.line, 0, cursorPosition.line, cursorPosition.character)
          const selectedText = document.getText(selection)
          await this.sendPrompt({
            text: await this.createProjectFile(file, ''),
            uniqueId: this.generateUniqueId()
          }, apiKey, true)
          break
        }
        case 'patch_file': {
          let file = command.args.file
          let patch = command.args.patch
          await this.sendPrompt({
            text: await this.applyDiffToFile(file, patch) ? 'true' : 'false',
            uniqueId: this.generateUniqueId()
          }, apiKey, true)
          break
        }
        case 'run_script': {
          let script = command.args.script
          let stdout = await this.executeScript(script)
          await this.sendPrompt({
            text: stdout,
            uniqueId: this.generateUniqueId()
          }, apiKey, true)
          break
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage('Error in runCommand: ' + error.message);
    }
  }

  async receivedMessage(data, apiKey) {
    switch (data.type) {
      case 'runCommand': {
        console.log(data.command)
        await this.runCommand(data.command, apiKey)
        break
      }
      case 'runScript': {
        console.log(data.script.description)
        await this.runCommand({name:'run_script',args:{script:data.script}}, apiKey)
        break
      }
      case 'sendPrompt': {
        await this.sendPrompt({text: data.text, uniqueId: data.uniqueId}, apiKey)
        break
      }
      case 'clearHistory': {
        this._history = []
        this._context.globalState.update(historySaveStateKey, [])
        this._view.webview.html = this._getHtmlForWebview(this._view.webview)
        break
      }
      case 'openSettings': {
        const settingsCommand = 'workbench.action.openSettings'
        vscode.commands.executeCommand(settingsCommand, 'aiide')
        break
      }
    }
  }

  _update () {
    if (!this._view) {
      return
    }

    this._view.webview.html = this._getHtmlForWebview(this._view.webview)
    const apiKey = this._context.secrets.get(API_KEY)

    if (!apiKey) {
      vscode.window.showWarningMessage('Enter your API KEY to save it securely.')
      return 'Please enter your api key.'
    }

    // const provider = vscode.workspace.getConfiguration().get('AIIDE.apiKey')
    // const model = vscode.workspace.getConfiguration().get('AIIDE.model')
    // const temperature = vscode.workspace.getConfiguration().get('AIIDE.temperature')
    // const maxTokens = vscode.workspace.getConfiguration().get('AIIDE.maxTokens')
    // const language = vscode.workspace.getConfiguration().get('AIIDE.query.language')
    if (this._history.length) {
      setTimeout(() => {
        this._view.webview.postMessage({
          type: 'syncHistory',
          history: this._history
        })
      }, 1500)
    }

    this._view.webview.onDidReceiveMessage(async (data) => {
      await this.receivedMessage(data, apiKey)
    })
  }

  _getHtmlForWebview (webview) {
    const nonce = this._getNonce()
    const styleVscode = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'vscode.css'))
    // const styleMain = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.css'))
    const scriptChat = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'chat.js'))
    const styleChat = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'chat.css'))
    const styleGithubDark = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'github_dark.css'))
    const highlightMinJs = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'highlight.min.js'))
    const markedMindJs = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'marked.min.js'))
    const showdownJs = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'showdown.min.js'))

    const sendButtonSvg = '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M8.08074 5.36891L10.2202 7.50833L4.46802 7.50833L4.46802 8.50833L10.1473 8.50833L8.08073 10.5749L8.78784 11.282L11.7444 8.32545L11.7444 7.61835L8.78784 4.6618L8.08074 5.36891Z"/><path d="M8 14C4.68629 14 2 11.3137 2 8C2 4.68629 4.68629 2 8 2C11.3137 2 14 4.68629 14 8C14 11.3137 11.3137 14 8 14ZM8 13C10.7614 13 13 10.7614 13 8C13 5.23858 10.7614 3 8 3C5.23858 3 3 5.23858 3 8C3 10.7614 5.23858 13 8 13Z"/></svg>'
    const clearButtonSvg = '<svg width="24" height="24" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zM9 2H6v1h3V2zM4 13h7V4H4v9zm2-8H5v7h1V5zm1 0h1v7H7V5zm2 0h1v7H9V5z"/></svg>'
    const botSvg = '<svg width="24" height="24" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.48 4h4l.5.5v2.03h.52l.5.5V8l-.5.5h-.52v3l-.5.5H9.36l-2.5 2.76L6 14.4V12H3.5l-.5-.64V8.5h-.5L2 8v-.97l.5-.5H3V4.36L3.53 4h4V2.86A1 1 0 0 1 7 2a1 1 0 0 1 2 0 1 1 0 0 1-.52.83V4zM12 8V5H4v5.86l2.5.14H7v2.19l1.8-2.04.35-.15H12V8zm-2.12.51a2.71 2.71 0 0 1-1.37.74v-.01a2.71 2.71 0 0 1-2.42-.74l-.7.71c.34.34.745.608 1.19.79.45.188.932.286 1.42.29a3.7 3.7 0 0 0 2.58-1.07l-.7-.71zM6.49 6.5h-1v1h1v-1zm3 0h1v1h-1v-1z"/></svg>'

    const history = this._history
    const initialTemplate = `
    <div class="initialTemplate">
      <div class="wrapper ai">
        <div class="chat">
          <div class="profile chat_header">
            ${botSvg} <span>Let's code</span>
          </div>
          <p>
              AIIDE
          </p>
          <button id="btn-settings">Settings</button>
        </div>
      </div>
    </div>`
    const chat = initialTemplate
    const efit = (s) => {
      //console.log(s)
      return s
    }
    return efit(`
      <!doctype html>
        <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta http-equiv="Content-Security-Policy" content="img-src https: data:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
                <link rel="stylesheet" href="${styleVscode}">
                <link rel="stylesheet" href="${styleChat}">
                <link rel="stylesheet" href="${styleGithubDark}">
                <script nonce="${nonce}" src="${highlightMinJs}"></script>
                <script nonce="${nonce}" src="${showdownJs}"></script>
                <script nonce="${nonce}" src="${markedMindJs}"></script>
            </head>
            <body class="background: black">
                <form id="app" class="">  
                    <input type="hidden" name="lastUniqueId" id="lastUniqueId" value="">
                    <div id="header">
                      <button title="clear chat" id="btn-clear" >${clearButtonSvg}</button>
                    </div>
                    <div id="chat_container" class="hljs">
                        ${chat}
                    </div>
                    <button id="stopResponse">Stop responding</button>
                    <footer>
                      <textarea type="text" rows="1" tabindex="0" name="prompt" id="prompt" placeholder="Ask a question..."></textarea>
                      <button type="submit" id="btn-question">Send ${sendButtonSvg}</button>
                    </footer>
                </form>
                <script nonce="${nonce}" src="${scriptChat}" ></script>
            </body>
        </html>
      `)
  }

  _getNonce () {
    let text = ''
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length))
    }
    return text
  }

  static register (context) {
    const provider = ChatSidebarProvider.getChatInstance(context)
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        'aiide-sidebar',
        provider,
        {
          webviewOptions: {
            retainContextWhenHidden: true
          }
        }
      )
    )
  }
}

ChatSidebarProvider.viewType = 'miExtension.sidebar'

module.exports = ChatSidebarProvider


const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const getSystemPrompt = (context) => {
  const extensionPath = context.extensionPath;
  const filePath = path.join(extensionPath, 'media', 'prompt02.txt');
  
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content;
  } catch (error) {
    console.error(`Error reading file: ${error.message}`);
    return null;
  }
}

module.exports = { getSystemPrompt }

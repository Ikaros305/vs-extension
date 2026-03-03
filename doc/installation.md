# Installation Guide

Follow these steps to set up and run the Codeaira Copilot extension locally for development or personal use.

## Prerequisites

- **Visual Studio Code**: Ensure you have the latest version of VS Code installed.
- **Node.js & npm**: You need Node.js (v16+) and npm installed on your system.
- **API Token**: You will need a valid API token from the Codeaira provider.

## Setup Steps

1. **Clone the Repository** (if applicable):
   ```bash
   git clone <repository-url>
   cd codeaira-copilot
   ```

2. **Install Dependencies**:
   Run the following command in the root of the project to install all necessary Node.js packages:
   ```bash
   npm install
   ```

3. **Compile the Extension**:
   Compile the TypeScript code into JavaScript using the build script:
   ```bash
   npm run compile
   ```
   *Note: For active development, you can use `npm run watch` to re-compile on every file change.*

4. **Package the Extension (Optional)**:
   If you want to create a `.vsix` file for distribution:
   ```bash
   npx vsce package
   ```

## Running the Extension

1. Open the `codeaira-copilot` folder in VS Code.
2. Press `F5` or go to the **Run and Debug** view and select **Run Extension**.
3. A new **Extension Development Host** window will open with the Codeaira Copilot extension enabled.

## Configuration

1. In the Extension Development Host, open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
2. Search for **"Codeaira: Store API Token"**.
3. Enter your API token when prompted. This is required for the AI agent to function.

# Features List

Codeaira Copilot is designed to be more than just a chatbot; it's a fully-featured AI pair programmer. Here's what it can do:

## 🤖 Agentic Intelligence
- **Multi-Step Planning**: Automatically breaks down complex requests into a sequence of actionable steps.
- **File Operations**: Natively creates, modifies, and deletes files based on user requests.
- **Terminal Integration**: Executes shell commands and captures real-time output within the chat UI.
- **Autonomous Error Resolution**: If a command fails, the agent analyzes the error output and attempts to fix it automatically.

## 📁 Rich Context Management
- **Explicit Context**: Attach specific files/folders via drag-and-drop or a file picker.
- **Local Indexing**: The extension maintains a high-level index of your workspace to provide relevant context automatically.
- **Large Context Support**: Injects the actual content of attached files directly into the AI prompt for zero-shot accuracy.

## 🛡️ Trust and sequential Control
- **Universal Trust System**: Mark specific commands or file paths as "Trusted" to bypass manual approval for recurring tasks.
- **Sequential Execution**: Ensures that tasks (like installing dependencies before running tests) happen in the correct order.
- **Global Stop Mechanism**: Abort long-running generations or active terminal processes with a single click.

## 💾 User Experience & Persistence
- **Workspace-Level Persistence**: Chat history is saved per workspace folder. Your conversations remain intact even after closing VS Code.
- **Real-time Feedback**: Streams AI responses and terminal output as they happen.
- **Clean UI**: Modern, VS Code-native aesthetics with dark mode support and interactive action cards.
- **Multi-Model Support**: Support for Gemini, Claude, and GPT-4o out of the box.

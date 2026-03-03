# Usage Guide

Welcome to Codeaira Copilot! This guide explains how to interact with the AI assistant and leverage its advanced agentic features.

## Opening the Chat

Open the Chat interface by clicking on the **Codeaira** icon in the Activity Bar (the side menu) of VS Code.

## Basic Interaction

- **Typing a Message**: Use the text box at the bottom of the chat view to type your query.
- **Selecting Models**: Use the dropdown menu at the top to switch between different AI models (Gemini, Claude, GPT-4o).
- **Session History**: Current and previous chat sessions are automatically saved and can be accessed via the session dropdown. History persists across VS Code restarts.

## Agentic Workflow (The "Agent" Mode)

When the "Agent" flow is selected (default), the assistant doesn't just talk—it acts.

1. **Ask for a Task**: E.g., "Create a new React component called UserProfile."
2. **Review the Plan**: The AI will generate a JSON-based execution plan showing which files it will create or modify and which commands it will run.
3. **Execution Control**:
   - **Run**: Execute a single action.
   - **Run All**: Execute the entire plan sequentially.
   - **Trust**: Marks an action as "trusted." Trusted actions will auto-execute in future plans without asking for confirmation.
   - **Cancel**: Stop a running or pending action.
   - **Stop (🛑)**: Halt the entire generation process if the AI is taking too long.

## Context Management

Give the AI precise context to improve its answers:

- **Drag & Drop**: Drag files or folders from the VS Code Explorer and drop them into the chat input area.
- **Paperclip Button (📎)**: Click the paperclip icon to open a file picker and select multiple items to attach.
- **Context Pills**: Attached items appear as pills. You can remove them by clicking the "X" if you no longer need them in context.

## Troubleshooting

- **API Token**: If the agent says it can't connect, ensure you've set your token via the `Codeaira: Store API Token` command.
- **Logs**: Check the "Codeaira" output channel in VS Code for detailed execution logs.

# Architecture Overview

This document describes the internal structure of the Codeaira Copilot extension.

## Component Overview

The extension is built as a set of decoupled services that interact via the VS Code Extension API.

### 1. Webview UI (`chatViewProvider.ts`)
- **Responsibility**: Manages the Chat Sidebar interface.
- **Tech**: HTML, CSS, Vanilla JS.
- **Key Features**: Markdown rendering (via `marked`), Syntax highlighting (via `highlight.js`), Drag & Drop event handling, and Message passing to the backend.

### 2. Workspace Indexer (`workspaceIndexer.ts`)
- **Responsibility**: Scans the workspace to build a high-level map of the project structure.
- **Purpose**: Provides baseline context to the LLM so it knows which files exist even if they haven't been explicitly attached.

### 3. Workflow Planner (`workflowPlanner.ts`)
- **Responsibility**: Parses the LLM's raw text response into structured `Plan` and `Action` objects.
- **Format**: Detects JSON blocks that conform to our Execution Plan schema.

### 4. Action Executor (`actionExecutor.ts`)
- **Responsibility**: Realizes the plan on the local system.
- **Capabilities**: 
  - File System writes/edits via `vscode.workspace.fs`.
  - Process execution via Node.js `child_process`.
  - Tracks active PIDs to support task cancellation.

### 5. API Client (`apiClient.ts`)
- **Responsibility**: Communicates with the Codeaira LLM backend.
- **Features**: Handles retries, network error normalization, and supports `AbortSignal` for cancellation.

### 6. Context Provider (`contextProvider.ts`)
- **Responsibility**: Aggregates data from the Indexer, active editor, and user-attached files into a final prompt string.

## Data Flow

1. **User Request**: User types a prompt in the Webview.
2. **Context Gathering**: The backend gathers local file context and attached file contents.
3. **LLM Call**: A prompt is sent to the LLM through the API Client.
4. **Planning**: If the response contains a JSON plan, the Workflow Planner extracts it.
5. **Approval**: The plan is displayed in the UI for user approval/execution.
6. **Execution**: The Action Executor carries out the approved tasks, reporting real-time output back to the UI.
7. **Persistence**: The updated session is saved to the VS Code Workspace State.

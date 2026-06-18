import Editor, { OnMount } from "@monaco-editor/react";
import type { OpenFile } from "../types";
import { languageForFile } from "../language";

interface EditorPaneProps {
  file: OpenFile | null;
  onChange: (value: string) => void;
  onCursorChange: (line: number, col: number) => void;
}

export function EditorPane({ file, onChange, onCursorChange }: EditorPaneProps) {
  const handleMount: OnMount = (editor) => {
    editor.onDidChangeCursorPosition((e) => {
      onCursorChange(e.position.lineNumber, e.position.column);
    });
  };

  if (!file) {
    return (
      <div className="editor-empty">
        <div className="editor-empty-inner">
          <h2>Code Editor</h2>
          <p>Abra uma pasta e selecione um arquivo para começar a editar.</p>
        </div>
      </div>
    );
  }

  return (
    <Editor
      height="100%"
      theme="vs-dark"
      path={file.path}
      language={languageForFile(file.name)}
      value={file.content}
      onChange={(value) => onChange(value ?? "")}
      onMount={handleMount}
      options={{
        fontSize: 14,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
      }}
    />
  );
}

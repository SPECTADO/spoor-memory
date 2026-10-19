/**
 * CodeMirror 6 Markdown editor (loaded lazily through MarkdownEditor.tsx so CodeMirror is not in the main
 * bundle). Themed from the CSS tokens, so it follows light and dark mode. Tab is NOT captured (keyboard
 * users can leave the editor); the accessible name is set on `.cm-content`.
 */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorView } from '@codemirror/view'
import CodeMirror from '@uiw/react-codemirror'
import { useMemo } from 'react'
import type { MarkdownEditorProps } from './MarkdownEditor'

const tokenTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--c-bg)', color: 'var(--c-fg)', fontSize: '0.875rem' },
  '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--c-fg)', padding: '0.5rem 0' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--c-fg)' },
  '&.cm-focused': { outline: '2px solid var(--c-focus)', outlineOffset: '2px' },
  '.cm-gutters': {
    backgroundColor: 'var(--c-surface)',
    color: 'var(--c-muted)',
    borderRight: '1px solid var(--c-border)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--c-surface-2)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--c-accent-soft)' },
  '.cm-panels': { backgroundColor: 'var(--c-surface)', color: 'var(--c-fg)' },
  '.cm-tooltip': { backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' },
})

export default function MarkdownEditorImpl({
  value,
  onChange,
  label = 'Editor',
  minHeight = '16rem',
  maxHeight,
  readOnly = false,
  autoFocus = false,
  onBlur,
}: MarkdownEditorProps) {
  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true' }),
      tokenTheme,
    ],
    [label],
  )
  return (
    <div className="overflow-hidden rounded-md border border-border-strong">
      <CodeMirror
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        extensions={extensions}
        theme="none"
        readOnly={readOnly}
        autoFocus={autoFocus}
        indentWithTab={false}
        minHeight={minHeight}
        maxHeight={maxHeight}
        basicSetup={{ foldGutter: false, highlightActiveLine: false, autocompletion: false }}
      />
    </div>
  )
}

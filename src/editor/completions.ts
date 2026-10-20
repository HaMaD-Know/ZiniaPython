import { type Completion, type CompletionContext, type CompletionResult, snippetCompletion } from '@codemirror/autocomplete';
import { BUILTIN_EXCEPTIONS, MODULE_MEMBERS, PYTHON_BUILTINS, PYTHON_KEYWORDS, SNIPPETS, STDLIB_MODULES } from './pythonData';

const keywordCompletions: Completion[] = PYTHON_KEYWORDS.map((k) => ({ label: k, type: 'keyword', boost: -1 }));
const builtinCompletions: Completion[] = [
  ...Object.entries(PYTHON_BUILTINS).map(([label, detail]) => ({ label, type: 'function', detail })),
  ...BUILTIN_EXCEPTIONS.map((label) => ({ label, type: 'class', detail: 'built-in' })),
];
const snippetCompletions: Completion[] = SNIPPETS.map((s) => snippetCompletion(s.template, { label: s.label, detail: s.detail, type: 'text', boost: -2 }));

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;
const DEFINITION = /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/gm;
const ASSIGNMENT = /^\s*([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/gm;

/** Names defined or used in the document, ranked by kind. */
export function documentNames(text: string, exclude: string): Completion[] {
  const seen = new Map<string, Completion>();
  for (const m of text.matchAll(DEFINITION)) {
    seen.set(m[2], { label: m[2], type: m[1] === 'def' ? 'function' : 'class', detail: 'in this file', boost: 2 });
  }
  for (const m of text.matchAll(ASSIGNMENT)) {
    if (!seen.has(m[1])) seen.set(m[1], { label: m[1], type: 'variable', detail: 'in this file', boost: 1 });
  }
  for (const m of text.matchAll(IDENTIFIER)) {
    const word = m[0];
    if (word.length < 3 || word === exclude || seen.has(word) || PYTHON_KEYWORDS.includes(word) || word in PYTHON_BUILTINS) continue;
    seen.set(word, { label: word, type: 'text', boost: -3 });
    if (seen.size > 800) break;
  }
  seen.delete(exclude);
  return [...seen.values()];
}

/**
 * Local Python completion source: keywords, built-ins, snippets, names in
 * the document, standard-library and project module names after
 * `import`/`from`, and members of well-known modules after "module.".
 */
export function pythonCompletionSource(projectModules: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);

    // Inside a string or comment: no suggestions.
    if (/#/.test(before.replace(/(["'])(?:\\.|(?!\1).)*\1/g, ''))) return null;

    const importMatch = /^\s*(?:from\s+([\w.]*)|import\s+(?:[\w.]+\s*,\s*)*([\w.]*))$/.exec(before);
    if (importMatch) {
      const typed = importMatch[1] ?? importMatch[2] ?? '';
      const options: Completion[] = [
        ...projectModules().map((m) => ({ label: m, type: 'namespace', detail: 'project', boost: 2 })),
        ...STDLIB_MODULES.map((m) => ({ label: m, type: 'namespace', detail: 'standard library' })),
      ];
      return { from: context.pos - typed.length, options, validFor: /^[\w.]*$/ };
    }

    const member = /([A-Za-z_][\w.]*)\.(\w*)$/.exec(before);
    if (member) {
      const members = MODULE_MEMBERS[member[1]];
      if (!members) return null;
      return {
        from: context.pos - member[2].length,
        options: members.map((m) => ({ label: m, type: 'property', detail: member[1] })),
        validFor: /^\w*$/,
      };
    }

    const word = context.matchBefore(/[A-Za-z_]\w*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const typed = word.text;
    return {
      from: word.from,
      options: [...documentNames(context.state.doc.toString(), typed), ...builtinCompletions, ...keywordCompletions, ...snippetCompletions],
      validFor: /^\w*$/,
    };
  };
}

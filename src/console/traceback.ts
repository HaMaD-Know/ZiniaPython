import type { PythonErrorInfo, PythonExecutionResult } from '../types/python';

export interface TracebackLine {
  text: string;
  /** Present when the line names a file location ("File "x", line N, in f"). */
  location?: { filename: string; lineno: number };
}

const FILE_LINE = /^\s*File "(.+)", line (\d+)/;

/** Splits a formatted traceback into lines, marking navigable locations. */
export function parseTraceback(text: string): TracebackLine[] {
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => {
      const m = FILE_LINE.exec(line);
      return m ? { text: line, location: { filename: m[1], lineno: Number(m[2]) } } : { text: line };
    });
}

/** One-sentence summary shown above a traceback. */
export function summarizeError(error: PythonErrorInfo): string {
  switch (error.category) {
    case 'syntax': {
      const s = error.syntax;
      const where = s?.lineno ? ` on line ${s.lineno}${s.offset ? `, column ${s.offset}` : ''}` : '';
      return `${error.type}${where}: ${error.message}`;
    }
    case 'import':
      return error.missingModule
        ? `Module "${error.missingModule}" could not be imported.`
        : `Import failed: ${error.message}`;
    case 'interrupt':
      return 'Stopped by KeyboardInterrupt.';
    case 'memory':
      return 'The script ran out of memory.';
    case 'environment':
      return error.message;
    default: {
      const where = error.location?.lineno ? ` (line ${error.location.lineno})` : '';
      return `${error.type}: ${error.message}${where}`;
    }
  }
}

/** Status line text for a finished run. */
export function describeOutcome(result: PythonExecutionResult): { tone: 'ok' | 'error' | 'warn'; text: string } {
  switch (result.status) {
    case 'ok':
      return { tone: 'ok', text: 'Finished' };
    case 'exit':
      return { tone: result.exitCode === 0 ? 'ok' : 'warn', text: `Exited with code ${result.exitCode}` };
    case 'interrupted':
      return { tone: 'warn', text: result.stoppedBy === 'memory-guard' ? 'Stopped: memory limit' : 'Stopped' };
    case 'incomplete':
      return { tone: 'warn', text: 'Incomplete input' };
    default:
      return { tone: 'error', text: result.error ? result.error.type : 'Error' };
  }
}

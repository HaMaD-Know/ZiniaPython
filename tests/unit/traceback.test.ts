import { describe, expect, it } from 'vitest';
import { describeOutcome, parseTraceback, summarizeError } from '../../src/console/traceback';
import type { PythonErrorInfo, PythonExecutionResult } from '../../src/types/python';
import realErrors from '../fixtures/python-errors.json';

describe('traceback rendering', () => {
  it('finds navigable locations in a real CPython traceback', () => {
    const err = realErrors.runtime as PythonErrorInfo;
    const lines = parseTraceback(err.traceback);
    const locations = lines.filter((l) => l.location).map((l) => l.location);
    expect(locations.length).toBeGreaterThanOrEqual(1);
    expect(locations.at(-1)?.lineno).toBe(1);
    expect(lines.at(-1)?.text).toContain('ZeroDivisionError');
  });

  it('summarizes each error category', () => {
    expect(summarizeError(realErrors.syntax as PythonErrorInfo)).toMatch(/SyntaxError on line 1/);
    expect(summarizeError(realErrors.runtime as PythonErrorInfo)).toMatch(/ZeroDivisionError: division by zero \(line 1\)/);
    expect(summarizeError(realErrors.missingModule as PythonErrorInfo)).toBe('Module "zinia_missing_fixture" could not be imported.');
  });

  it('describes run outcomes', () => {
    const base: PythonExecutionResult = { executionId: 'x', status: 'ok', exitCode: null, durationMs: 1, error: null, outputChars: 0, truncated: false };
    expect(describeOutcome(base)).toEqual({ tone: 'ok', text: 'Finished' });
    expect(describeOutcome({ ...base, status: 'exit', exitCode: 3 }).text).toBe('Exited with code 3');
    expect(describeOutcome({ ...base, status: 'interrupted' }).text).toBe('Stopped');
    expect(describeOutcome({ ...base, status: 'interrupted', stoppedBy: 'memory-guard' }).text).toMatch(/memory/);
    expect(describeOutcome({ ...base, status: 'error', error: realErrors.runtime as PythonErrorInfo }).text).toBe('ZeroDivisionError');
  });
});

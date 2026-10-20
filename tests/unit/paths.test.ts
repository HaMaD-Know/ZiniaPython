import { describe, expect, it } from 'vitest';
import { basename, copyName, dirname, extname, formatSize, fromAbsolute, isInside, join, normalize, relative, toAbsolute, validateName } from '../../src/files/paths';

describe('paths', () => {
  it('normalizes root-relative paths', () => {
    expect(normalize('a//b/./c/')).toBe('a/b/c');
    expect(normalize('a/b/../c')).toBe('a/c');
    expect(normalize('')).toBe('');
    expect(() => normalize('../etc/passwd')).toThrow(/escapes/);
    expect(() => normalize('a/../../b')).toThrow();
  });

  it('joins, splits and inspects names', () => {
    expect(join('MyProject', 'data', 'example.json')).toBe('MyProject/data/example.json');
    expect(join('', 'main.py')).toBe('main.py');
    expect(dirname('MyProject/main.py')).toBe('MyProject');
    expect(dirname('main.py')).toBe('');
    expect(basename('MyProject/main.py')).toBe('main.py');
    expect(extname('archive.TAR.GZ')).toBe('.gz');
    expect(extname('.gitignore')).toBe('');
  });

  it('answers containment questions', () => {
    expect(isInside('MyProject/main.py', 'MyProject')).toBe(true);
    expect(isInside('MyProject2/main.py', 'MyProject')).toBe(false);
    expect(isInside('anything', '')).toBe(true);
    expect(relative('MyProject/data/x.json', 'MyProject')).toBe('data/x.json');
    expect(relative('Other/x', 'MyProject')).toBeNull();
  });

  it('maps between absolute and root-relative paths', () => {
    const root = '/var/mobile/Containers/Data/Application/ABC/Documents';
    expect(toAbsolute(root, 'MyProject/main.py')).toBe(`${root}/MyProject/main.py`);
    expect(fromAbsolute(root, `${root}/MyProject/main.py`)).toBe('MyProject/main.py');
    // iOS reports the same container through /private/var as well.
    expect(fromAbsolute(root, `/private${root}/MyProject/helpers.py`)).toBe('MyProject/helpers.py');
    expect(fromAbsolute(root, '/var/somewhere/else.py')).toBeNull();
    expect(fromAbsolute('F:/ws', 'F:\\ws\\MyProject\\helpers.py')).toBe('MyProject/helpers.py');
  });

  it('validates user-typed names', () => {
    expect(validateName('main.py')).toBeNull();
    expect(validateName('')).toMatch(/Enter a name/);
    expect(validateName('a/b')).toMatch(/cannot contain/);
    expect(validateName('..')).toMatch(/reserved/);
  });

  it('builds copy names that do not collide', () => {
    expect(copyName('main.py', new Set())).toBe('main copy.py');
    expect(copyName('main.py', new Set(['main copy.py']))).toBe('main copy 2.py');
    expect(copyName('data', new Set())).toBe('data copy');
  });

  it('formats sizes', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
